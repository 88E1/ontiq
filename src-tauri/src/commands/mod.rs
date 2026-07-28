pub mod audio;
pub mod history;
pub mod models;
pub mod transcription;

use crate::settings::{get_settings, write_settings, AppSettings, LogLevel};
use crate::utils::cancel_current_operation;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
#[specta::specta]
pub fn cancel_operation(app: AppHandle) {
    cancel_current_operation(&app);
}

/// Toggle the default transcribe binding (same path as CLI `--toggle-transcription`).
/// Used by the completion "Continue" button to reopen the recording pill.
#[tauri::command]
#[specta::specta]
pub fn toggle_transcription(app: AppHandle) {
    crate::signal_handle::send_transcription_input(&app, "transcribe", "UI");
}

/// Seed a Logseq file-graph for the current investigation and open it.
///
/// Primary "Open Investigation" path: sealed vault + evidence stub pages +
/// Analysis workspace, then launch Logseq / reveal the graph folder.
#[tauri::command]
#[specta::specta]
pub async fn open_investigation_window(app: AppHandle) -> Result<String, String> {
    let result = crate::logseq_case::open_logseq_workspace(&app)?;
    log::info!(
        "Logseq workspace ready at {} (package extracted inside graph, zip={}, {} pages, {} vars, logseq={}, package_opened={})",
        result.graph_path,
        result.zip_path,
        result.page_count,
        result.variable_count,
        result.opened_logseq,
        result.opened_zip
    );
    Ok(result.graph_path)
}

/// Open (or focus) the Handy vault/workbench window (integrity viewer).
///
/// Must be async on Windows - creating a WebviewWindow from a sync command
/// deadlocks WebView2 and leaves a frozen white window.
#[tauri::command]
#[specta::specta]
pub async fn open_investigation_vault_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("investigation") {
        let _ = existing.unminimize();
        let _ = existing.show();
        crate::handy_lock::apply_to_window(&existing);
        if !crate::handy_lock::is_locked() {
            // Raise above the always-on-top overlay briefly, then settle.
            let _ = existing.set_always_on_top(true);
            let _ = existing.set_focus();
            let raised = existing.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let _ = raised.set_always_on_top(false);
            });
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        "investigation",
        WebviewUrl::App("src/investigation/index.html".into()),
    )
    .title("Investigation vault")
    .inner_size(1120.0, 720.0)
    .min_inner_size(880.0, 560.0)
    .resizable(true)
    .maximizable(true)
    .minimizable(true)
    .closable(true)
    .focused(true)
    .visible(true)
    .always_on_top(true);

    if let Some(data_dir) = crate::portable::data_dir() {
        // Share the main webview profile so theme/localStorage match the app.
        builder = builder.data_directory(data_dir.join("webview"));
    }

    let window = builder
        .build()
        .map_err(|e| format!("Failed to open investigation vault: {e}"))?;

    let _ = window.show();
    crate::handy_lock::apply_to_window(&window);
    if !crate::handy_lock::is_locked() {
        let _ = window.set_focus();
        let raised = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            let _ = raised.set_always_on_top(false);
        });
    }
    Ok(())
}

/// Whether Handy is currently pinned (dimmed + click-through).
#[tauri::command]
#[specta::specta]
pub fn get_handy_locked() -> bool {
    crate::handy_lock::is_locked()
}

/// Toggle pin / click-through mode (same as the lock_handy shortcut).
#[tauri::command]
#[specta::specta]
pub fn toggle_handy_lock(app: AppHandle) -> bool {
    crate::handy_lock::toggle(&app)
}

#[tauri::command]
#[specta::specta]
pub fn get_investigation_session() -> Option<crate::investigation::InvestigationSession> {
    crate::investigation::get_session()
}

#[tauri::command]
#[specta::specta]
pub fn save_investigation_session(
    app: AppHandle,
    session: crate::investigation::InvestigationSession,
) -> Result<(), String> {
    crate::investigation::set_session(session);
    crate::investigation::emit_updated(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_investigation_session(app: AppHandle) -> Result<(), String> {
    crate::investigation::clear_session();
    crate::investigation::emit_updated(&app);
    Ok(())
}

/// Record a human/agent actor period (Take control / Release control).
#[tauri::command]
#[specta::specta]
pub fn record_investigation_actor(app: AppHandle, actor: String) -> Result<(), String> {
    crate::investigation::record_actor(&actor)?;
    crate::investigation::emit_updated_light(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn is_portable() -> bool {
    crate::portable::is_portable()
}

#[tauri::command]
#[specta::specta]
pub fn get_app_dir_path(app: AppHandle) -> Result<String, String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(get_settings(&app))
}

#[tauri::command]
#[specta::specta]
pub fn get_default_settings() -> Result<AppSettings, String> {
    Ok(crate::settings::get_default_settings())
}

#[tauri::command]
#[specta::specta]
pub fn get_log_dir_path(app: AppHandle) -> Result<String, String> {
    let log_dir = crate::portable::app_log_dir(&app)
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    Ok(log_dir.to_string_lossy().to_string())
}

#[specta::specta]
#[tauri::command]
pub fn set_log_level(app: AppHandle, level: LogLevel) -> Result<(), String> {
    let tauri_log_level: tauri_plugin_log::LogLevel = level.into();
    let log_level: log::Level = tauri_log_level.into();
    // Update the file log level atomic so the filter picks up the new level
    crate::FILE_LOG_LEVEL.store(
        log_level.to_level_filter() as u8,
        std::sync::atomic::Ordering::Relaxed,
    );

    let mut settings = get_settings(&app);
    settings.log_level = level;
    write_settings(&app, settings);

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_recordings_folder(app: AppHandle) -> Result<(), String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let recordings_dir = app_data_dir.join("recordings");

    let path = recordings_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open recordings folder: {}", e))?;

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let log_dir = crate::portable::app_log_dir(&app)
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    let path = log_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open log directory: {}", e))?;

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_app_data_dir(app: AppHandle) -> Result<(), String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let path = app_data_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open app data directory: {}", e))?;

    Ok(())
}

/// Check if Apple Intelligence is available on this device.
/// Called by the frontend when the user selects Apple Intelligence provider.
#[specta::specta]
#[tauri::command]
pub fn check_apple_intelligence_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        crate::apple_intelligence::check_apple_intelligence_availability()
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

/// Try to initialize Enigo (keyboard/mouse simulation).
/// On macOS, this will return an error if accessibility permissions are not granted.
#[specta::specta]
#[tauri::command]
pub fn initialize_enigo(app: AppHandle) -> Result<(), String> {
    use crate::input::EnigoState;

    // Check if already initialized
    if app.try_state::<EnigoState>().is_some() {
        log::debug!("Enigo already initialized");
        return Ok(());
    }

    // Try to initialize
    match EnigoState::new() {
        Ok(enigo_state) => {
            app.manage(enigo_state);
            log::info!("Enigo initialized successfully after permission grant");
            Ok(())
        }
        Err(e) => {
            if cfg!(target_os = "macos") {
                log::warn!(
                    "Failed to initialize Enigo: {} (accessibility permissions may not be granted)",
                    e
                );
            } else {
                log::warn!("Failed to initialize Enigo: {}", e);
            }
            Err(format!("Failed to initialize input system: {}", e))
        }
    }
}

/// Marker state to track if shortcuts have been initialized.
pub struct ShortcutsInitialized;

/// Initialize keyboard shortcuts.
/// On macOS, this should be called after accessibility permissions are granted.
/// This is idempotent - calling it multiple times is safe.
#[specta::specta]
#[tauri::command]
pub fn initialize_shortcuts(app: AppHandle) -> Result<(), String> {
    // Check if already initialized
    if app.try_state::<ShortcutsInitialized>().is_some() {
        log::debug!("Shortcuts already initialized");
        return Ok(());
    }

    // Initialize shortcuts
    crate::shortcut::init_shortcuts(&app);

    // Mark as initialized
    app.manage(ShortcutsInitialized);

    log::info!("Shortcuts initialized successfully");
    Ok(())
}
