//! Pin Handy on top visually while letting mouse clicks pass through to the
//! desktop underneath. Unlock is always via the global shortcut (UI is inert).

use log::debug;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static LOCKED: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

const LOCK_WINDOWS: &[&str] = &["recording_overlay", "investigation", "main"];

pub fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// Toggle pin/click-through mode. Returns the new locked state.
pub fn toggle(app: &AppHandle) -> bool {
    let next = !is_locked();
    set_locked(app, next);
    next
}

pub fn set_locked(app: &AppHandle, locked: bool) {
    LOCKED.store(locked, Ordering::SeqCst);
    apply_to_all_windows(app, locked);
    let _ = app.emit("handy-lock-changed", locked);
    debug!("Handy lock {}", if locked { "enabled" } else { "disabled" });
}

/// Apply current lock state to a single window (e.g. just created).
pub fn apply_to_window(window: &tauri::WebviewWindow) {
    let locked = is_locked();
    let _ = window.set_ignore_cursor_events(locked);
    if locked {
        // Stay visible above the desktop while clicks pass through.
        let _ = window.set_always_on_top(true);
    }
}

fn apply_to_all_windows(app: &AppHandle, locked: bool) {
    for label in LOCK_WINDOWS {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let _ = window.set_ignore_cursor_events(locked);
        match *label {
            "recording_overlay" => {
                // Overlay is always topmost by design.
                let _ = window.set_always_on_top(true);
            }
            "investigation" | "main" => {
                // While locked: keep elevated so the dimmed UI stays visible.
                // When unlocked: drop forced topmost (overlay stays topmost).
                let _ = window.set_always_on_top(locked);
            }
            _ => {}
        }
    }
}
