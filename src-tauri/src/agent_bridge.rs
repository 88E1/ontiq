//! Spawns the Node/Bun agent-runner sidecar and relays NDJSON events to the overlay.
//!
//! The sidecar prefers Steel (local or cloud) + Playwright to search the web in an
//! isolated browser; falls back to local Chromium, then a mock slideshow.

use crate::investigation::{self, InvestigationSession};
use crate::overlay;
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

static AGENT_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACTIVE_CHILD: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AgentMessage {
    #[serde(rename = "status")]
    Status { message: String },
    /// Steel (or similar) live embed URL for Screen share WebRTC stream.
    #[serde(rename = "live")]
    Live {
        #[serde(default, rename = "viewerUrl")]
        viewer_url: Option<String>,
        #[serde(default, rename = "sessionId")]
        session_id: Option<String>,
    },
    #[serde(rename = "frame")]
    Frame {
        url: String,
        label: String,
        #[serde(default)]
        tone: Option<String>,
        #[serde(default)]
        highlight: Option<HighlightRect>,
        #[serde(default)]
        data_url: Option<String>,
        #[serde(rename = "dataUrl")]
        data_url_camel: Option<String>,
        status: String,
        /// Exact passage extracted from the page (when available).
        #[serde(default)]
        quote: Option<String>,
        /// How this passage affects the overall investigation.
        #[serde(default)]
        meaning: Option<String>,
    },
    #[serde(rename = "provenance")]
    Provenance {
        entries_json: String,
        title: String,
        #[serde(default, alias = "integrityJson")]
        integrity_json: Option<String>,
    },
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationLivePayload {
    pub viewer_url: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationFramePayload {
    pub url: String,
    pub label: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight: Option<HighlightRect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meaning: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn kill_active_child() {
    if let Ok(mut guard) = ACTIVE_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Cancel any in-flight agent run (e.g. new recording started).
pub fn cancel_agent() {
    AGENT_GENERATION.fetch_add(1, Ordering::Relaxed);
    kill_active_child();
}

fn agent_runner_dir() -> Option<PathBuf> {
    // Dev: src-tauri/../agent-runner
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.join("..").join("agent-runner");
    if candidate.join("src").join("run.mjs").is_file()
        || candidate.join("src").join("run.ts").is_file()
    {
        return candidate.canonicalize().ok().or(Some(candidate));
    }
    None
}

fn is_windows_exe(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
}

/// Prefer Node for the agent-runner - Playwright's browser launch hangs under
/// Bun on Windows. Checks PATH plus common install locations (GUI apps often
/// have a thinner PATH than the shell).
fn find_node() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HANDY_NODE_PATH") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(p) = which_cmd("node") {
        return Some(p);
    }
    // Fallbacks when `where node` fails inside the packaged/dev GUI process.
    let mut candidates = vec![
        PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
        PathBuf::from(r"C:\Program Files (x86)\nodejs\node.exe"),
        PathBuf::from(r"C:\nvm4w\nodejs\node.exe"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join("fnm").join("aliases").join("default").join("node.exe"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(home).join("scoop").join("apps").join("nodejs").join("current").join("node.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn which_cmd(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let output = Command::new("where.exe")
            .arg(name)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&output.stdout);
        for line in s.lines() {
            let p = PathBuf::from(line.trim());
            if p.is_file() && is_windows_exe(&p) {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        Command::new("which")
            .arg(name)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout);
                let p = PathBuf::from(s.trim());
                if p.is_file() { Some(p) } else { None }
            })
    }
}

/// Start the agent against `objective`. Streams frames to the overlay; on done
/// persists provenance and transitions to the completion screen.
pub fn start_investigation_agent(app: &AppHandle, objective: String) {
    let generation = AGENT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    kill_active_child();

    let app = app.clone();
    thread::spawn(move || {
        if AGENT_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }

        let _ = app.emit("investigation-status", "Starting isolated browser…");

        let Some(runner_dir) = agent_runner_dir() else {
            error!("agent-runner directory not found");
            let _ = app.emit(
                "investigation-status",
                "Agent runner missing - using offline mock",
            );
            run_inline_mock(&app, &objective, generation);
            return;
        };

        let node = match find_node() {
            Some(n) => n,
            None => {
                warn!("node not found; falling back to inline mock agent");
                run_inline_mock(&app, &objective, generation);
                return;
            }
        };

        log::info!(
            "Spawning agent-runner: {} src/run.mjs --objective {:?} (cwd={})",
            node.display(),
            objective,
            runner_dir.display()
        );

        // Node + run.mjs - Playwright is unreliable under Bun on Windows.
        let mut cmd = Command::new(&node);
        cmd.current_dir(&runner_dir)
            .arg("src/run.mjs")
            .arg("--objective")
            .arg(&objective)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // Inherit Steel / browser env from the parent process.
        match cmd.spawn() {
            Ok(mut child) => {
                log::info!("agent-runner spawned pid={:?}", child.id());
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                if let Ok(mut guard) = ACTIVE_CHILD.lock() {
                    *guard = Some(child);
                }

                if let Some(err) = stderr {
                    thread::spawn(move || {
                        let reader = BufReader::new(err);
                        for line in reader.lines().flatten() {
                            log::info!("[agent-runner] {}", line);
                        }
                    });
                }

                if let Some(out) = stdout {
                    let reader = BufReader::new(out);
                    for line in reader.lines().flatten() {
                        if AGENT_GENERATION.load(Ordering::Relaxed) != generation {
                            break;
                        }
                        handle_agent_line(&app, &line, generation);
                    }
                }

                // Wait / clean up
                if let Ok(mut guard) = ACTIVE_CHILD.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.wait();
                    }
                }
            }
            Err(e) => {
                error!("Failed to spawn agent-runner: {}", e);
                run_inline_mock(&app, &objective, generation);
            }
        }

        if AGENT_GENERATION.load(Ordering::Relaxed) == generation {
            // Ensure we always land on complete if the sidecar exited without "done"
            overlay::show_overlay_state(&app, "complete");
        }
    });
}

fn emit_to_overlay<T: Serialize + Clone>(app: &AppHandle, event: &str, payload: &T) {
    let _ = app.emit(event, payload.clone());
    if let Some(overlay) = app.get_webview_window("recording_overlay") {
        let _ = overlay.emit(event, payload);
    }
}

fn handle_agent_line(app: &AppHandle, line: &str, generation: u64) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let msg: AgentMessage = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(e) => {
            debug!("agent NDJSON parse skip: {} ({})", e, line);
            return;
        }
    };

    match msg {
        AgentMessage::Status { message } => {
            emit_to_overlay(app, "investigation-status", &message);
        }
        AgentMessage::Live {
            viewer_url,
            session_id,
        } => {
            let payload = InvestigationLivePayload {
                viewer_url,
                session_id,
            };
            emit_to_overlay(app, "investigation-live", &payload);
        }
        AgentMessage::Frame {
            url,
            label,
            tone,
            highlight,
            data_url,
            data_url_camel,
            status,
            quote,
            meaning,
        } => {
            let payload = InvestigationFramePayload {
                url,
                label,
                status: status.clone(),
                tone,
                highlight,
                data_url: data_url.or(data_url_camel),
                quote,
                meaning,
            };
            emit_to_overlay(app, "investigation-frame", &payload);
            emit_to_overlay(app, "investigation-status", &status);
        }
        AgentMessage::Provenance {
            entries_json,
            title,
            integrity_json,
        } => {
            if AGENT_GENERATION.load(Ordering::Relaxed) != generation {
                return;
            }
            // Huge base64 screenshot blobs can stall every webview listening for
            // investigation-updated. Keep the session in memory; emit a light ping.
            let integrity = integrity_json.unwrap_or_default();
            // Prefer investigationId from the integrity package when present.
            let id = serde_json::from_str::<serde_json::Value>(&integrity)
                .ok()
                .and_then(|v| {
                    v.get("investigationId")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| format!("inv_{}", now_ms()));
            let session = InvestigationSession {
                id,
                title,
                entries_json,
                created_at_ms: now_ms(),
                integrity_json: integrity,
            };
            investigation::set_session(session);
            investigation::emit_updated_light(app);
        }
        AgentMessage::Done => {
            if AGENT_GENERATION.load(Ordering::Relaxed) == generation {
                overlay::show_overlay_state(app, "complete");
            }
        }
        AgentMessage::Error { message } => {
            error!("agent error: {}", message);
            let _ = app.emit("investigation-status", format!("Agent error: {message}"));
            if AGENT_GENERATION.load(Ordering::Relaxed) == generation {
                overlay::show_overlay_state(app, "complete");
            }
        }
    }
}

/// Minimal in-process mock when bun/sidecar is unavailable.
fn run_inline_mock(app: &AppHandle, objective: &str, generation: u64) {
    let steps = [
        (
            "https://app.example.com/login",
            "Login form error",
            "#3a4554",
            "Opening isolated browser…",
        ),
        (
            "https://app.example.com/settings/notifications",
            "Settings toggle mismatch",
            "#3d4a3f",
            "Clicking through the page…",
        ),
        (
            "https://app.example.com/checkout",
            "Checkout total jump",
            "#4a3f3a",
            "Checking checkout totals…",
        ),
        (
            "https://app.example.com/projects",
            "Empty state flash",
            "#3a3f4a",
            "Capturing final evidence…",
        ),
    ];

    let mut entries = Vec::new();
    let mut t = 0u64;
    for (i, (url, label, tone, status)) in steps.iter().enumerate() {
        if AGENT_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let payload = InvestigationFramePayload {
            url: (*url).to_string(),
            label: (*label).to_string(),
            status: (*status).to_string(),
            tone: Some((*tone).to_string()),
            highlight: Some(HighlightRect {
                x: 18.0 + (i as f64) * 8.0,
                y: 28.0,
                w: 48.0,
                h: 18.0,
            }),
            data_url: None,
            quote: Some((*label).to_string()),
            meaning: Some((*status).to_string()),
        };
        let _ = app.emit("investigation-frame", payload);
        let _ = app.emit("investigation-status", *status);

        t += 400;
        entries.push(serde_json::json!({
            "id": format!("prov_nav_{i}"),
            "t": t,
            "url": url,
            "action": { "kind": "navigate", "url": url }
        }));
        t += 400;
        entries.push(serde_json::json!({
            "id": format!("prov_shot_{}", i + 1),
            "t": t,
            "url": url,
            "action": {
                "kind": "screenshot",
                "label": label,
                "screenshotId": format!("shot_{}", i + 1)
            },
            "screenshotId": format!("shot_{}", i + 1),
            "meta": {
                "label": label,
                "tone": tone,
                "finding": label,
                "extractedPreview": objective
            }
        }));

        thread::sleep(std::time::Duration::from_millis(900));
    }

    if AGENT_GENERATION.load(Ordering::Relaxed) != generation {
        return;
    }

    let session = InvestigationSession {
        id: format!("inv_{}", now_ms()),
        title: objective.chars().take(80).collect(),
        entries_json: serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into()),
        created_at_ms: now_ms(),
        integrity_json: String::new(),
    };
    investigation::set_session(session);
    investigation::emit_updated(app);
    overlay::show_overlay_state(app, "complete");
}
