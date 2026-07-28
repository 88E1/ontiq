//! In-memory investigation session shared across Handy windows.
//! Provenance + integrity JSON are produced by the agent-runner; Rust holds
//! and broadcasts them so the overlay and workbench stay in sync.

use log::debug;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static SESSION: Lazy<Mutex<Option<InvestigationSession>>> = Lazy::new(|| Mutex::new(None));

/// Actor switches recorded before / during a run (Take control), merged into
/// the integrity package when provenance lands.
static PENDING_CONTROL: Lazy<Mutex<Vec<Value>>> = Lazy::new(|| Mutex::new(Vec::new()));

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct InvestigationSession {
    pub id: String,
    pub title: String,
    /// JSON-encoded `ProvenanceEntry[]` from the TS browser layer.
    pub entries_json: String,
    pub created_at_ms: u64,
    /// JSON-encoded integrity manifest (SHA-256 artifacts + hash chain).
    #[serde(default)]
    pub integrity_json: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn get_session() -> Option<InvestigationSession> {
    let Ok(mut guard) = SESSION.lock() else {
        return None;
    };
    let Some(session) = guard.as_mut() else {
        return None;
    };
    // Compact in place so an already-loaded fat session becomes openable.
    let compacted = compact_entries_json(&session.entries_json);
    if compacted.len() < session.entries_json.len() {
        session.entries_json = compacted;
    }
    Some(session.clone())
}

/// Strip live-ticker PNG blobs from provenance so IPC stays responsive.
fn compact_entries_json(entries_json: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(entries_json) else {
        return entries_json.to_string();
    };
    let Some(arr) = value.as_array() else {
        return entries_json.to_string();
    };
    let compacted: Vec<Value> = arr
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            let Some(meta) = entry.get_mut("meta") else {
                return entry;
            };
            if !meta
                .get("dataUrl")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s.len() > 256)
            {
                return entry;
            }
            let keep = meta
                .get("quote")
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty())
                || meta
                    .get("meaning")
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
                || meta.get("label").and_then(|v| v.as_str()).is_some_and(|label| {
                    matches!(
                        label,
                        "Source" | "Follow-up" | "Search" | "Done" | "Extracted evidence"
                    )
                });
            if !keep {
                let _ = meta.as_object_mut().map(|m| m.remove("dataUrl"));
            }
            entry
        })
        .collect();
    serde_json::to_string(&compacted).unwrap_or_else(|_| entries_json.to_string())
}

fn merge_control_into_integrity(integrity_json: &str, pending: &[Value]) -> String {
    if pending.is_empty() || integrity_json.trim().is_empty() {
        return integrity_json.to_string();
    }
    let Ok(mut pkg) = serde_json::from_str::<Value>(integrity_json) else {
        return integrity_json.to_string();
    };
    for event in pending {
        let actor = event
            .get("actor")
            .and_then(|v| v.as_str())
            .unwrap_or("human");
        let at = event
            .get("atUtc")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if let Some(periods) = pkg.get_mut("actorPeriods").and_then(|v| v.as_array_mut()) {
            if let Some(last) = periods.last_mut() {
                if last.get("endedAtUtc").and_then(|v| v.as_str()).is_none() {
                    last.as_object_mut()
                        .map(|o| o.insert("endedAtUtc".into(), json!(at.clone())));
                }
            }
            periods.push(json!({
                "actor": actor,
                "startedAtUtc": at,
            }));
        }
        if let Some(obj) = pkg.as_object_mut() {
            let arr = obj
                .entry("controlLog".to_string())
                .or_insert_with(|| json!([]));
            if let Value::Array(list) = arr {
                list.push(event.clone());
            }
        }
    }
    serde_json::to_string(&pkg).unwrap_or_else(|_| integrity_json.to_string())
}

pub fn set_session(session: InvestigationSession) {
    let pending = PENDING_CONTROL
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default();
    let integrity_json = merge_control_into_integrity(&session.integrity_json, &pending);
    let session = InvestigationSession {
        entries_json: compact_entries_json(&session.entries_json),
        integrity_json,
        ..session
    };
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some(session);
    }
}

pub fn clear_session() {
    if let Ok(mut guard) = SESSION.lock() {
        *guard = None;
    }
    if let Ok(mut pending) = PENDING_CONTROL.lock() {
        pending.clear();
    }
}

/// Record human/agent control periods (e.g. Take control) into the integrity package.
pub fn record_actor(actor: &str) -> Result<(), String> {
    let actor = actor.trim().to_lowercase();
    if actor != "human" && actor != "agent" {
        return Err("actor must be 'human' or 'agent'".into());
    }
    let at = chrono_utc_approx();
    let event = json!({
        "actor": actor,
        "atUtc": at,
        "source": "take_control",
    });

    let Ok(mut guard) = SESSION.lock() else {
        return Err("session lock poisoned".into());
    };
    if let Some(session) = guard.as_mut() {
        if !session.integrity_json.trim().is_empty() {
            session.integrity_json =
                merge_control_into_integrity(&session.integrity_json, &[event]);
            return Ok(());
        }
    }
    drop(guard);

    // Session not sealed yet - keep until provenance arrives.
    if let Ok(mut pending) = PENDING_CONTROL.lock() {
        pending.push(event);
    }
    Ok(())
}

fn chrono_utc_approx() -> String {
    // Produce a real ISO-8601 UTC timestamp without adding chrono crate.
    // Windows/Linux: use `humantime`-less manual formatting from unix millis.
    let ms = now_ms();
    let total_secs = ms / 1000;
    let millis = ms % 1000;
    let days = total_secs / 86400;
    let tod = total_secs % 86400;
    let hour = tod / 3600;
    let min = (tod % 3600) / 60;
    let sec = tod % 60;
    // Civil date from Unix day (Howard Hinnant algorithm).
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, min, sec, millis
    )
}

pub fn emit_updated(app: &AppHandle) {
    match get_session() {
        Some(session) => {
            let _ = app.emit("investigation-updated", session);
            debug!("Emitted investigation-updated");
        }
        None => {
            let _ = app.emit("investigation-cleared", ());
            debug!("Emitted investigation-cleared");
        }
    }
}

/// Notify windows that a session changed without shipping multi‑MB screenshot
/// JSON through the event bus. Listeners should call `get_investigation_session`.
pub fn emit_updated_light(app: &AppHandle) {
    match get_session() {
        Some(session) => {
            let light = InvestigationSession {
                id: session.id.clone(),
                title: session.title.clone(),
                // Empty on purpose - frontend refetches the real session.
                entries_json: "[]".into(),
                created_at_ms: session.created_at_ms,
                integrity_json: String::new(),
            };
            let _ = app.emit("investigation-updated", light);
            debug!("Emitted investigation-updated (light)");
        }
        None => {
            let _ = app.emit("investigation-cleared", ());
            debug!("Emitted investigation-cleared");
        }
    }
}
