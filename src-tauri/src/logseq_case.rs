//! Seed a Logseq file-graph workspace from a sealed Handy investigation.
//!
//! Pipeline:
//! - `sealed/`  — immutable evidence vault (integrity, provenance, captures)
//! - `pages/`   — Logseq evidence stub pages + Analysis + Variables
//! - `assets/`  — preview images referenced by stubs
//! - case ZIP   — full export package; opened with Logseq
//! - `config.edn` macros + `/handy …` slash commands for every piece

use crate::investigation::InvestigationSession;
use crate::portable;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use log::{debug, warn};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;
use zip::ZipWriter;

#[derive(Debug, Clone)]
pub struct LogseqCaseOpenResult {
    pub graph_path: String,
    pub zip_path: String,
    pub opened_logseq: bool,
    pub opened_zip: bool,
    pub page_count: usize,
    pub variable_count: usize,
}

#[derive(Debug, Clone)]
struct HandyVar {
    /// Slash-command label, e.g. `handy e1 quote`
    command: String,
    /// Macro name, e.g. `handy-e1-quote`
    macro_name: String,
    /// Inserted / expanded value
    value: String,
    /// Path inside the ZIP package (when applicable)
    zip_path: String,
    /// Short description for Variables page
    help: String,
}

fn sanitize_segment(input: &str) -> String {
    let s: String = input
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        "untitled".into()
    } else {
        s.chars().take(72).collect()
    }
}

/// Logseq file graphs map `A/B` page names to `pages/A___B.md`.
fn page_filename(page_name: &str) -> String {
    format!("{}.md", page_name.replace('/', "___"))
}

fn write_text(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

fn decode_data_url(data_url: &str) -> Option<(Vec<u8>, &'static str)> {
    let (meta, payload) = data_url.split_once(',')?;
    if !meta.contains(";base64") {
        return None;
    }
    let bytes = B64.decode(payload).ok()?;
    let ext = if meta.contains("image/jpeg") || meta.contains("image/jpg") {
        "jpg"
    } else if meta.contains("image/webp") {
        "webp"
    } else if meta.contains("image/gif") {
        "gif"
    } else {
        "png"
    };
    Some((bytes, ext))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn host_path(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    rest.split('?').next().unwrap_or(rest).to_string()
}

fn flatten_value(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\n' | '\r' | '\t' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

fn edn_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' | '\r' | '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn push_var(
    vars: &mut Vec<HandyVar>,
    command: impl Into<String>,
    macro_name: impl Into<String>,
    value: impl Into<String>,
    zip_path: impl Into<String>,
    help: impl Into<String>,
) {
    let value = truncate_chars(&flatten_value(&value.into()), 1800);
    if value.trim().is_empty() {
        return;
    }
    vars.push(HandyVar {
        command: command.into(),
        macro_name: macro_name.into(),
        value,
        zip_path: zip_path.into(),
        help: help.into(),
    });
}

fn build_config_edn(vars: &[HandyVar]) -> String {
    let mut out = String::from(
        r#"{:meta/version 1
 :preferred-format :markdown
 :preferred-workflow :now
 :feature/enable-journals? true
 :feature/enable-block-timestamps? true
 :hidden []
 :default-home {:page "Analysis"}
 :pages-directory "pages"
 :journals-directory "journals"
 :property-pages/enabled? true
"#,
    );

    out.push_str(" :commands\n [\n");
    out.push_str(
        "  [\"handy var\" [[:editor/input \"{{handy-}}\" {:backward-pos 2}]]]\n",
    );
    out.push_str(
        "  [\"handy cite\" [[:editor/input \"[[Evidence/]]\" {:backward-pos 2}]]]\n",
    );
    for v in vars {
        out.push_str(&format!(
            "  [{} {}]\n",
            edn_string(&v.command),
            edn_string(&v.value)
        ));
    }
    out.push_str(" ]\n");

    out.push_str(" :macros\n {");
    for (i, v) in vars.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        } else {
            out.push('\n');
        }
        out.push_str(&format!(
            "  {} {}\n",
            edn_string(&v.macro_name),
            edn_string(&v.value)
        ));
    }
    // Generic helpers
    out.push_str("  \"handy-cite\" \"[[Evidence/$1]]\"\n");
    out.push_str(" }\n");
    out.push('}');
    out.push('\n');
    out
}

fn variables_page(session_id: &str, vars: &[HandyVar]) -> String {
    let mut out = String::new();
    out.push_str("title:: Variables\n");
    out.push_str(&format!("handy-investigation-id:: {session_id}\n"));
    out.push_str("type:: handy-variables\n\n");
    out.push_str("- # Handy case variables\n");
    out.push_str(
        "\t- Every piece of the sealed ZIP / evidence pack is addressable here.\n",
    );
    out.push_str("\t- **Slash command:** type `/handy …` (e.g. `/handy e1 quote`) to insert the value.\n");
    out.push_str(
        "\t- **Macro:** type `{{handy-e1-quote}}` (same names as below).\n",
    );
    out.push_str("\t- **Picker:** `/handy var` then finish the macro name.\n");
    out.push_str("- ## Catalog\n");
    for v in vars {
        out.push_str(&format!(
            "- `/{}` → `{{{{{}}}}}`\n",
            v.command, v.macro_name
        ));
        out.push_str(&format!("\t- {}\n", v.help));
        if !v.zip_path.is_empty() {
            out.push_str(&format!("\t- zip:: `{}`\n", v.zip_path));
        }
        let preview = truncate_chars(&v.value, 160);
        out.push_str(&format!("\t- value:: {preview}\n"));
    }
    out
}

fn contents_page(title: &str, session_id: &str, evidence_pages: &[String]) -> String {
    let mut out = String::new();
    out.push_str(&format!("title:: {title}\n"));
    out.push_str(&format!("handy-investigation-id:: {session_id}\n"));
    out.push_str("type:: handy-case\n\n");
    out.push_str("- # Handy investigation workspace\n");
    out.push_str(
        "\t- Full case ZIP is extracted inside this graph — see [[Case package]].\n",
    );
    out.push_str(
        "\t- Sealed evidence also lives under Evidence pages + `sealed/`. Cite from [[Analysis]].\n",
    );
    out.push_str(
        "\t- Call any field with `/handy …` — see [[Variables]] for the full catalog.\n",
    );
    out.push_str("- ## Evidence index\n");
    if evidence_pages.is_empty() {
        out.push_str("\t- _No sealed captures yet._\n");
    } else {
        for page in evidence_pages {
            out.push_str(&format!("\t- [[{page}]]\n"));
        }
    }
    out
}

fn analysis_page(title: &str, session_id: &str) -> String {
    format!(
        r#"title:: Analysis
handy-investigation-id:: {session_id}
type:: handy-analysis
case:: [[{title}]]

- # Analysis
	- Write your reasoning here. Keep it separate from sealed evidence.
	- Insert sealed fields with `/handy e1 quote`, `/handy root-hash`, etc. (see [[Variables]]).
	- Or use macros: `{{{{handy-e1-quote}}}}`, `{{{{handy-root-hash}}}}`.
- ## Working notes
	- 
- ## Hypotheses
	- 
- ## Open questions
	- 
"#
    )
}

fn sealed_readme() -> &'static str {
    "Handy sealed evidence vault\n\
============================\n\
\n\
Files in this folder are immutable investigation artifacts:\n\
- integrity.json  — SHA-256 artifact hashes + tamper-evident chain + root hash\n\
- provenance.json — action log (screenshots referenced, not always inlined)\n\
- captures/       — raw screenshot bytes when available\n\
- variables.json  — every field as a named variable for Logseq /handy commands\n\
\n\
Do not edit these files. Analyst notes belong in Logseq pages (Analysis),\n\
which should only *reference* Evidence/* pages that point here.\n"
}

fn evidence_page_md(
    page_name: &str,
    props: &[(&str, String)],
    quote: Option<&str>,
    finding: Option<&str>,
    asset_rel: Option<&str>,
    command_prefix: &str,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("title:: {page_name}\n"));
    for (k, v) in props {
        let escaped = v.replace('\n', " ");
        out.push_str(&format!("{k}:: {escaped}\n"));
    }
    out.push('\n');
    out.push_str("- # Sealed evidence\n");
    out.push_str("\t- **Read-only pointer.** Do not treat this page as editable source of truth.\n");
    out.push_str(&format!(
        "\t- Slash: `/{command_prefix}`, `/{command_prefix} quote`, `/{command_prefix} url`\n"
    ));
    if let Some(asset) = asset_rel {
        out.push_str(&format!("\t- ![capture](../{asset})\n"));
    }
    if let Some(q) = quote.filter(|s| !s.trim().is_empty()) {
        out.push_str("- ## Extracted quote\n");
        out.push_str(&format!("\t- > {}\n", q.replace('\n', " ")));
    }
    if let Some(f) = finding.filter(|s| !s.trim().is_empty()) {
        out.push_str("- ## Agent finding (sealed summary)\n");
        out.push_str(&format!("\t- {}\n", f.replace('\n', " ")));
    }
    out.push_str("- ## Your notes about this evidence\n");
    out.push_str("\t- Prefer writing longer analysis on [[Analysis]] and linking back here.\n");
    out
}

fn build_event_log_page(session: &InvestigationSession, entries: &[Value]) -> String {
    let mut out = String::new();
    out.push_str("title:: Event log\n");
    out.push_str(&format!("handy-investigation-id:: {}\n", session.id));
    out.push_str("type:: handy-event-log\n");
    out.push_str("read-only:: true\n\n");
    out.push_str("- # Sealed event log\n");
    out.push_str("\t- Generated from provenance. Prefer [[Analysis]] for interpretation.\n");
    for entry in entries {
        let t = entry.get("t").and_then(|v| v.as_u64()).unwrap_or(0);
        let secs = t / 1000;
        let mm = secs / 60;
        let ss = secs % 60;
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let action = entry.get("action").cloned().unwrap_or(Value::Null);
        let kind = action
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("event");
        let meta = entry.get("meta").cloned().unwrap_or(Value::Null);
        let label = meta
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(kind);
        let summary = meta
            .get("finding")
            .and_then(|v| v.as_str())
            .or_else(|| {
                if kind == "extract" {
                    action.get("text").and_then(|v| v.as_str())
                } else if kind == "navigate" {
                    action.get("url").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .unwrap_or(label);
        let summary = truncate_chars(&flatten_value(summary), 220);
        out.push_str(&format!("- `{mm:02}:{ss:02}` **{label}** — {summary}\n"));
        if !url.is_empty() && url != "about:blank" {
            out.push_str(&format!("\t- {url}\n"));
        }
    }
    out
}

fn pretty_json(raw: &str) -> String {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| raw.to_string())
}

fn write_zip_file(path: &Path, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let file = fs::File::create(path).map_err(|e| format!("create zip {}: {e}", path.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, data) in files {
        zip.start_file(name.as_str(), opts)
            .map_err(|e| format!("zip start {name}: {e}"))?;
        zip.write_all(data)
            .map_err(|e| format!("zip write {name}: {e}"))?;
    }
    zip.finish()
        .map_err(|e| format!("zip finish {}: {e}", path.display()))?;
    Ok(())
}

/// Write every package file onto disk under `dest_root` (ZIP paths preserved).
fn extract_package_files(dest_root: &Path, files: &[(String, Vec<u8>)]) -> Result<PathBuf, String> {
    let mut package_root: Option<PathBuf> = None;
    for (name, data) in files {
        let rel = name.replace('\\', "/");
        if rel.contains("..") {
            return Err(format!("refusing unsafe zip path: {rel}"));
        }
        let dest = dest_root.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&dest, data).map_err(|e| format!("extract {}: {e}", dest.display()))?;
        if package_root.is_none() {
            if let Some(first) = rel.split('/').next() {
                if !first.is_empty() {
                    package_root = Some(dest_root.join(first));
                }
            }
        }
    }
    Ok(package_root.unwrap_or_else(|| dest_root.to_path_buf()))
}

struct SeedResult {
    graph: PathBuf,
    /// Extracted case package folder living *inside* the Logseq graph.
    package_dir: PathBuf,
    zip_path: PathBuf,
    page_count: usize,
    variable_count: usize,
}

/// Build (or refresh) a Logseq file graph + case ZIP for this investigation.
fn seed_logseq_graph(app: &AppHandle, session: &InvestigationSession) -> Result<SeedResult, String> {
    let case_dir = portable::app_data_dir(app)
        .map_err(|e| format!("app data dir: {e}"))?
        .join("investigations")
        .join(sanitize_segment(&session.id));
    let root = case_dir.join("logseq-graph");
    let package_name = format!(
        "handy-investigation-{}",
        sanitize_segment(&session.id)
    );

    let pages_dir = root.join("pages");
    let journals_dir = root.join("journals");
    let assets_dir = root.join("assets");
    let sealed_dir = root.join("sealed");
    let captures_dir = sealed_dir.join("captures");
    let extracts_dir = sealed_dir.join("extracts");
    let logseq_dir = root.join("logseq");

    for dir in [
        &pages_dir,
        &journals_dir,
        &assets_dir,
        &captures_dir,
        &extracts_dir,
        &logseq_dir,
    ] {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }

    let integrity_body = if session.integrity_json.trim().is_empty() {
        "{\n  \"note\": \"No integrity package for this run.\"\n}\n".to_string()
    } else {
        pretty_json(&session.integrity_json)
    };
    let provenance_body = pretty_json(&session.entries_json);
    write_text(&sealed_dir.join("README.txt"), sealed_readme())?;
    write_text(&sealed_dir.join("integrity.json"), &integrity_body)?;
    write_text(&sealed_dir.join("provenance.json"), &provenance_body)?;

    let integrity: Value =
        serde_json::from_str(&session.integrity_json).unwrap_or(Value::Null);
    let entries: Vec<Value> = serde_json::from_str(&session.entries_json).unwrap_or_default();

    let title = if session.title.trim().is_empty() {
        "Investigation".to_string()
    } else {
        session.title.trim().to_string()
    };

    let mut vars: Vec<HandyVar> = Vec::new();
    push_var(
        &mut vars,
        "handy title",
        "handy-title",
        &title,
        format!("{package_name}/summary.json"),
        "Case title",
    );
    push_var(
        &mut vars,
        "handy id",
        "handy-id",
        &session.id,
        format!("{package_name}/summary.json"),
        "Investigation id",
    );
    if let Some(root_hash) = integrity.get("rootHash").and_then(|v| v.as_str()) {
        push_var(
            &mut vars,
            "handy root-hash",
            "handy-root-hash",
            root_hash,
            format!("{package_name}/integrity.json"),
            "Integrity root hash",
        );
    }
    if let Some(tip) = integrity.get("chainTip").and_then(|v| v.as_str()) {
        push_var(
            &mut vars,
            "handy chain-tip",
            "handy-chain-tip",
            tip,
            format!("{package_name}/integrity.json"),
            "Hash-chain tip",
        );
    }
    if let Some(run_id) = integrity.get("runId").and_then(|v| v.as_str()) {
        push_var(
            &mut vars,
            "handy run-id",
            "handy-run-id",
            run_id,
            format!("{package_name}/integrity.json"),
            "Sealed run id",
        );
    }
    if let Some(browser) = integrity
        .get("browserSessionId")
        .and_then(|v| v.as_str())
    {
        push_var(
            &mut vars,
            "handy browser-session",
            "handy-browser-session",
            browser,
            format!("{package_name}/integrity.json"),
            "Browser session id",
        );
    }

    let mut evidence_pages: Vec<String> = Vec::new();
    let mut capture_idx = 0usize;
    let mut zip_files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut findings_md = format!("# {title}\n\nInvestigation ID: `{}`\n\n", session.id);
    let mut event_log_txt = String::new();
    let mut summary_captures: Vec<Value> = Vec::new();

    for entry in &entries {
        let action = entry.get("action").cloned().unwrap_or(Value::Null);
        let kind = action
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if kind != "screenshot" && kind != "extract" {
            continue;
        }

        let id = entry
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let meta = entry.get("meta").cloned().unwrap_or(Value::Null);
        let label = meta
            .get("label")
            .and_then(|v| v.as_str())
            .or_else(|| action.get("label").and_then(|v| v.as_str()))
            .unwrap_or(kind);
        let quote = meta.get("quote").and_then(|v| v.as_str());
        let finding = meta
            .get("finding")
            .and_then(|v| v.as_str())
            .or_else(|| meta.get("meaning").and_then(|v| v.as_str()));
        let data_url = meta.get("dataUrl").and_then(|v| v.as_str());
        let t = entry.get("t").and_then(|v| v.as_u64()).unwrap_or(0);

        let is_shot = kind == "screenshot";
        if !is_shot && quote.is_none() && finding.is_none() {
            continue;
        }

        capture_idx += 1;
        let n = format!("{capture_idx:02}");
        let cmd = format!("handy e{capture_idx}");
        let macro_base = format!("handy-e{capture_idx}");
        let page_name = format!("Evidence/{capture_idx}-{}", sanitize_segment(label));
        let file_stem = format!("{n}-{}", sanitize_segment(label));

        let mut asset_rel: Option<String> = None;
        let mut sealed_rel = String::from("sealed/provenance.json");
        let mut artifact_hash = String::new();
        let mut capture_zip_rel: Option<String> = None;

        if let Some(du) = data_url {
            if let Some((bytes, ext)) = decode_data_url(du) {
                artifact_hash = sha256_hex(&bytes);
                let file_name = format!("{file_stem}.{ext}");
                let sealed_path = captures_dir.join(&file_name);
                let asset_path = assets_dir.join(&file_name);
                if let Err(e) = fs::write(&sealed_path, &bytes) {
                    warn!("Failed to write sealed capture {}: {e}", sealed_path.display());
                } else {
                    let _ = fs::copy(&sealed_path, &asset_path);
                    asset_rel = Some(format!("assets/{file_name}"));
                    sealed_rel = format!("sealed/captures/{file_name}");
                    capture_zip_rel = Some(format!("{package_name}/captures/{file_name}"));
                    zip_files.push((
                        format!("{package_name}/captures/{file_name}"),
                        bytes,
                    ));
                }
            }
        }

        if artifact_hash.is_empty() {
            if let Some(arts) = integrity.get("artifacts").and_then(|v| v.as_array()) {
                if let Some(hit) = arts.iter().find(|a| {
                    a.get("url").and_then(|u| u.as_str()) == Some(url)
                        && a.get("kind").and_then(|k| k.as_str()) == Some("screenshot")
                }) {
                    artifact_hash = hit
                        .get("sha256")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
        }

        let capture_meta = json!({
            "id": id,
            "title": label,
            "timestamp": t,
            "url": url,
            "source": host_path(url),
            "finding": finding,
            "extractedText": quote,
            "artifactHash": artifact_hash,
            "page": page_name,
            "commands": {
                "cite": format!("/{cmd}"),
                "quote": format!("/{cmd} quote"),
                "url": format!("/{cmd} url"),
                "finding": format!("/{cmd} finding"),
                "hash": format!("/{cmd} hash"),
            }
        });
        let capture_meta_bytes = serde_json::to_vec_pretty(&capture_meta).unwrap_or_default();
        write_text(
            &captures_dir.join(format!("{file_stem}.json")),
            &String::from_utf8_lossy(&capture_meta_bytes),
        )?;
        zip_files.push((
            format!("{package_name}/captures/{file_stem}.json"),
            capture_meta_bytes,
        ));

        if quote.is_some() || finding.is_some() {
            let body = [
                label.to_string(),
                url.to_string(),
                String::new(),
                finding
                    .map(|f| format!("Finding:\n{f}\n"))
                    .unwrap_or_default(),
                quote
                    .map(|q| format!("Extracted:\n{q}\n"))
                    .unwrap_or_default(),
            ]
            .join("\n");
            let extract_name = format!("{file_stem}.txt");
            write_text(&extracts_dir.join(&extract_name), &body)?;
            zip_files.push((
                format!("{package_name}/extracts/{extract_name}"),
                body.as_bytes().to_vec(),
            ));
            push_var(
                &mut vars,
                format!("{cmd} extract"),
                format!("{macro_base}-extract"),
                &body,
                format!("{package_name}/extracts/{extract_name}"),
                "Full extract text file from the ZIP",
            );
        }

        let props = vec![
            ("handy-id", id.to_string()),
            ("handy-investigation-id", session.id.clone()),
            ("type", "handy-evidence".into()),
            ("read-only", "true".into()),
            ("source-url", url.to_string()),
            ("source", host_path(url)),
            ("label", label.to_string()),
            ("artifact-hash", artifact_hash.clone()),
            ("sealed-path", sealed_rel.clone()),
            ("handy-command", format!("/{cmd}")),
        ];

        let md = evidence_page_md(
            &page_name,
            &props,
            quote,
            finding,
            asset_rel.as_deref(),
            &cmd,
        );
        write_text(&pages_dir.join(page_filename(&page_name)), &md)?;
        evidence_pages.push(page_name.clone());

        // Variables / slash commands for this piece
        push_var(
            &mut vars,
            &cmd,
            &macro_base,
            format!("[[{page_name}]]"),
            capture_zip_rel
                .clone()
                .unwrap_or_else(|| format!("{package_name}/captures/{file_stem}.json")),
            "Cite this evidence page",
        );
        push_var(
            &mut vars,
            format!("{cmd} label"),
            format!("{macro_base}-label"),
            label,
            format!("{package_name}/captures/{file_stem}.json"),
            "Evidence label",
        );
        push_var(
            &mut vars,
            format!("{cmd} url"),
            format!("{macro_base}-url"),
            url,
            format!("{package_name}/captures/{file_stem}.json"),
            "Source URL",
        );
        push_var(
            &mut vars,
            format!("{cmd} source"),
            format!("{macro_base}-source"),
            host_path(url),
            format!("{package_name}/captures/{file_stem}.json"),
            "Host + path",
        );
        if let Some(q) = quote {
            push_var(
                &mut vars,
                format!("{cmd} quote"),
                format!("{macro_base}-quote"),
                q,
                format!("{package_name}/extracts/{file_stem}.txt"),
                "Extracted quote",
            );
        }
        if let Some(f) = finding {
            push_var(
                &mut vars,
                format!("{cmd} finding"),
                format!("{macro_base}-finding"),
                f,
                format!("{package_name}/captures/{file_stem}.json"),
                "Agent finding / why it matters",
            );
        }
        if !artifact_hash.is_empty() {
            push_var(
                &mut vars,
                format!("{cmd} hash"),
                format!("{macro_base}-hash"),
                &artifact_hash,
                format!("{package_name}/integrity.json"),
                "SHA-256 of capture bytes",
            );
        }
        push_var(
            &mut vars,
            format!("{cmd} path"),
            format!("{macro_base}-path"),
            &sealed_rel,
            capture_zip_rel.unwrap_or_default(),
            "Path inside sealed vault / ZIP",
        );
        push_var(
            &mut vars,
            format!("{cmd} id"),
            format!("{macro_base}-id"),
            id,
            format!("{package_name}/captures/{file_stem}.json"),
            "Provenance entry id",
        );

        findings_md.push_str(&format!(
            "## {capture_idx}. {label}\n\n- Command: `/{cmd}`\n- URL: {url}\n"
        ));
        if let Some(f) = finding {
            findings_md.push_str(&format!("\n**Finding**\n\n{f}\n"));
        }
        if let Some(q) = quote {
            findings_md.push_str(&format!("\n**Extracted**\n\n{q}\n"));
        }
        findings_md.push('\n');

        summary_captures.push(json!({
            "index": capture_idx,
            "id": id,
            "title": label,
            "url": url,
            "command": format!("/{cmd}"),
            "macros": {
                "cite": format!("{{{{{macro_base}}}}}"),
                "quote": format!("{{{{{macro_base}-quote}}}}"),
                "url": format!("{{{{{macro_base}-url}}}}"),
            },
            "file": format!("captures/{file_stem}.json"),
        }));
    }

    // Event log text for ZIP
    for entry in &entries {
        let t = entry.get("t").and_then(|v| v.as_u64()).unwrap_or(0);
        let secs = t / 1000;
        let action = entry.get("action").cloned().unwrap_or(Value::Null);
        let kind = action
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("event");
        let meta = entry.get("meta").cloned().unwrap_or(Value::Null);
        let label = meta
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or(kind);
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        event_log_txt.push_str(&format!(
            "{:02}:{:02}\t[{kind}]\t{label}\t{url}\n",
            secs / 60,
            secs % 60
        ));
    }
    if event_log_txt.is_empty() {
        event_log_txt.push_str("(no events)\n");
    }

    let event_page = build_event_log_page(session, &entries);
    write_text(&pages_dir.join("Event log.md"), &event_page)?;

    // ZIP package files (mirrors frontend export shape)
    let summary = json!({
        "id": session.id,
        "title": title,
        "createdAtMs": session.created_at_ms,
        "exportedAtMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(session.created_at_ms),
        "exportedAtUtc": chrono::Utc::now().to_rfc3339(),
        "logseqGraph": "logseq-graph",
        "variablesPage": "Variables",
        "slashPrefix": "/handy",
        "counts": {
            "evidence": capture_idx,
            "events": entries.len(),
            "variables": vars.len(),
        },
        "captures": summary_captures,
        "integrity": {
            "rootHash": integrity.get("rootHash"),
            "chainTip": integrity.get("chainTip"),
            "runId": integrity.get("runId"),
        }
    });
    let summary_bytes = serde_json::to_vec_pretty(&summary).unwrap_or_default();
    let findings_bytes = findings_md.into_bytes();
    let event_log_json = serde_json::to_vec_pretty(&entries).unwrap_or_default();
    let event_log_txt_bytes = event_log_txt.into_bytes();
    let readme = format!(
        "Handy Investigation Export\n\
==========================\n\
\n\
Title: {title}\n\
Investigation ID: {}\n\
\n\
This folder is extracted inside the Logseq graph (not a sidecar).\n\
In Logseq type `/handy` to insert sealed fields (see Variables page).\n\
Macros: {{{{handy-title}}}}, {{{{handy-e1-quote}}}}, {{{{handy-root-hash}}}}, …\n\
\n\
Contents\n\
--------\n\
README.txt\n\
summary.json\n\
integrity.json\n\
provenance.json\n\
event-log.json\n\
event-log.txt\n\
findings.md\n\
variables.json\n\
captures/\n\
extracts/\n",
        session.id
    );

    let vars_json = json!(vars
        .iter()
        .map(|v| json!({
            "command": format!("/{}", v.command),
            "macro": format!("{{{{{}}}}}", v.macro_name),
            "macroName": v.macro_name,
            "value": v.value,
            "zipPath": v.zip_path,
            "help": v.help,
        }))
        .collect::<Vec<_>>());
    let vars_bytes = serde_json::to_vec_pretty(&vars_json).unwrap_or_default();
    write_text(
        &sealed_dir.join("variables.json"),
        &String::from_utf8_lossy(&vars_bytes),
    )?;

    zip_files.push((
        format!("{package_name}/README.txt"),
        readme.into_bytes(),
    ));
    zip_files.push((format!("{package_name}/summary.json"), summary_bytes));
    zip_files.push((
        format!("{package_name}/integrity.json"),
        integrity_body.into_bytes(),
    ));
    zip_files.push((
        format!("{package_name}/provenance.json"),
        provenance_body.into_bytes(),
    ));
    zip_files.push((format!("{package_name}/event-log.json"), event_log_json));
    zip_files.push((
        format!("{package_name}/event-log.txt"),
        event_log_txt_bytes,
    ));
    zip_files.push((format!("{package_name}/findings.md"), findings_bytes));
    zip_files.push((format!("{package_name}/variables.json"), vars_bytes.clone()));

    // Extract the full case package *into* the Logseq graph (primary).
    let package_dir = extract_package_files(&root, &zip_files)?;

    // Keep a ZIP archive next to / inside the graph for handoff, but the
    // extracted tree under `{package_name}/` is what lives in Logseq.
    let zip_path = root.join(format!("{package_name}.zip"));
    write_zip_file(&zip_path, &zip_files)?;
    let zip_sidecar = case_dir.join(format!("{package_name}.zip"));
    let _ = fs::copy(&zip_path, &zip_sidecar);

    push_var(
        &mut vars,
        "handy package",
        "handy-package",
        package_dir.to_string_lossy().as_ref(),
        package_name.clone(),
        "Extracted case package folder inside this Logseq graph",
    );
    push_var(
        &mut vars,
        "handy zip",
        "handy-zip",
        zip_path.to_string_lossy().as_ref(),
        format!("{package_name}.zip"),
        "ZIP archive copy inside the Logseq graph",
    );
    push_var(
        &mut vars,
        "handy graph",
        "handy-graph",
        root.to_string_lossy().as_ref(),
        "logseq-graph",
        "Absolute path to the Logseq graph folder",
    );

    // Write config + pages after vars finalized (includes package/graph paths)
    write_text(&logseq_dir.join("config.edn"), &build_config_edn(&vars))?;
    // Refresh variables.json (sealed + extracted package) with final vars
    let vars_json = json!(vars
        .iter()
        .map(|v| json!({
            "command": format!("/{}", v.command),
            "macro": format!("{{{{{}}}}}", v.macro_name),
            "macroName": v.macro_name,
            "value": v.value,
            "zipPath": v.zip_path,
            "help": v.help,
        }))
        .collect::<Vec<_>>());
    let vars_bytes = serde_json::to_vec_pretty(&vars_json).unwrap_or_default();
    write_text(
        &sealed_dir.join("variables.json"),
        &String::from_utf8_lossy(&vars_bytes),
    )?;
    write_text(
        &package_dir.join("variables.json"),
        &String::from_utf8_lossy(&vars_bytes),
    )?;

    write_text(
        &pages_dir.join("Contents.md"),
        &contents_page(&title, &session.id, &evidence_pages),
    )?;
    write_text(
        &pages_dir.join("Analysis.md"),
        &analysis_page(&title, &session.id),
    )?;
    write_text(
        &pages_dir.join("Variables.md"),
        &variables_page(&session.id, &vars),
    )?;
    // Logseq page pointing at the extracted package tree
    write_text(
        &pages_dir.join("Case package.md"),
        &format!(
            "title:: Case package\nhandy-investigation-id:: {}\ntype:: handy-case-package\n\n\
- # Extracted case package (inside this graph)\n\
\t- Folder: `{package_name}/`\n\
\t- Absolute: `{}`\n\
\t- All ZIP contents are unpacked here — summary, integrity, captures, extracts, variables.\n\
\t- Slash commands: `/handy …` (see [[Variables]]).\n\
- ## Files\n\
\t- [`{package_name}/summary.json`](../{package_name}/summary.json)\n\
\t- [`{package_name}/integrity.json`](../{package_name}/integrity.json)\n\
\t- [`{package_name}/provenance.json`](../{package_name}/provenance.json)\n\
\t- [`{package_name}/event-log.json`](../{package_name}/event-log.json)\n\
\t- [`{package_name}/findings.md`](../{package_name}/findings.md)\n\
\t- [`{package_name}/variables.json`](../{package_name}/variables.json)\n\
\t- `{package_name}/captures/`\n\
\t- `{package_name}/extracts/`\n",
            session.id,
            package_dir.to_string_lossy()
        ),
    )?;
    write_text(
        &root.join("README.md"),
        &format!(
            "# {title}\n\nHandy → Logseq case workspace.\n\n\
- Open **this folder** as a Logseq graph.\n\
- Full case export is extracted inside the graph at `{package_name}/`.\n\
- Archive copy: `{package_name}.zip` (optional handoff).\n\
- In Logseq type `/handy` — every field is a slash command + `{{{{macro}}}}`.\n\
- Catalog: [[Variables]] · package index: [[Case package]] · notes: [[Analysis]].\n\
- Never edit `sealed/` or `{package_name}/` as source of truth edits.\n"
        ),
    )?;

    let page_count = fs::read_dir(&pages_dir)
        .map(|it| it.filter_map(|e| e.ok()).count())
        .unwrap_or(0);

    debug!(
        "Seeded Logseq graph at {} (package={}, {} pages, {} vars, zip={})",
        root.display(),
        package_dir.display(),
        page_count,
        vars.len(),
        zip_path.display()
    );

    Ok(SeedResult {
        graph: root,
        package_dir,
        zip_path,
        page_count,
        variable_count: vars.len(),
    })
}

/// Seed the graph (with ZIP contents extracted inside it) and open Logseq.
pub fn open_logseq_workspace(app: &AppHandle) -> Result<LogseqCaseOpenResult, String> {
    let session = crate::investigation::get_session()
        .ok_or_else(|| "No investigation session yet. Run an investigation first.".to_string())?;

    if session.entries_json.trim().is_empty() || session.entries_json.trim() == "[]" {
        return Err("Investigation session is empty. Run an investigation first.".into());
    }

    let seeded = seed_logseq_graph(app, &session)?;
    let graph_path = seeded.graph.to_string_lossy().to_string();
    let zip_path = seeded.zip_path.to_string_lossy().to_string();
    let package_path = seeded.package_dir.to_string_lossy().to_string();

    let opened_logseq = try_open_logseq(app, &seeded.graph);

    // Reveal the Logseq graph (contains the extracted package tree).
    let _ = app
        .opener()
        .open_path(graph_path.clone(), None::<String>);

    // Also open the extracted package folder inside the graph so every file
    // is visible where Logseq lives — not as a detached ZIP archive.
    let opened_zip = app
        .opener()
        .open_path(package_path, None::<String>)
        .is_ok();
    if !opened_zip {
        warn!(
            "Failed to open extracted package at {}",
            seeded.package_dir.display()
        );
    }

    Ok(LogseqCaseOpenResult {
        graph_path,
        zip_path,
        opened_logseq,
        opened_zip,
        page_count: seeded.page_count,
        variable_count: seeded.variable_count,
    })
}

fn try_open_logseq(app: &AppHandle, graph: &Path) -> bool {
    let candidates = ["logseq://"];
    for uri in candidates {
        if app.opener().open_url(uri, None::<String>).is_ok() {
            debug!("Opened Logseq via {uri}");
            let path = graph.to_string_lossy().to_string();
            let opener_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                let _ = opener_app.opener().open_path(path, None::<String>);
            });
            return true;
        }
    }

    #[cfg(target_os = "windows")]
    {
        let graph_str = graph.to_string_lossy().to_string();
        if std::process::Command::new("cmd")
            .args(["/C", "start", "", "logseq:"])
            .spawn()
            .is_ok()
        {
            let opener_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                let _ = opener_app
                    .opener()
                    .open_path(graph_str, None::<String>);
            });
            return true;
        }
    }

    let _ = graph;
    false
}
