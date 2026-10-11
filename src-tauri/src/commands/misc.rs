use crate::pipeline;
use crate::storage;
use crate::tray;
use serde_json::json;
use tauri::Emitter;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[tauri::command]
pub fn refresh_tray_labels(app: tauri::AppHandle) -> Result<(), String> {
    tray::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn check_accessibility_permission() -> bool {
    pipeline::is_accessibility_trusted()
}

#[tauri::command]
pub fn request_accessibility_permission() -> bool {
    pipeline::request_accessibility_permission()
}

fn restore_shortcuts_after_failed_update(
    app: &tauri::AppHandle,
    previous: &storage::AppConfig,
    was_paused: bool,
) -> Result<(), String> {
    crate::hotkey::register_configured_shortcuts(app, previous)?;
    if was_paused {
        crate::hotkey::set_shortcuts_paused(app, false);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ShortcutField {
    Speech,
    ScreenOcr,
}

impl ShortcutField {
    fn value(self, config: &storage::AppConfig) -> &str {
        match self {
            Self::Speech => &config.hotkey,
            Self::ScreenOcr => &config.screen_ocr_hotkey,
        }
    }

    fn set(self, config: &mut storage::AppConfig, value: String) {
        match self {
            Self::Speech => config.hotkey = value,
            Self::ScreenOcr => config.screen_ocr_hotkey = value,
        }
    }

    fn patch(self, config: &storage::AppConfig) -> serde_json::Value {
        match self {
            Self::Speech => json!({ "hotkey": self.value(config) }),
            Self::ScreenOcr => json!({ "screen_ocr_hotkey": self.value(config) }),
        }
    }
}

async fn update_configured_shortcut(
    app: &tauri::AppHandle,
    config_state: &storage::ConfigManager,
    mutation_lock: &storage::ConfigMutationLock,
    field: ShortcutField,
    hotkey: String,
) -> Result<(), String> {
    let _mutation_guard = mutation_lock.0.lock().await;
    let previous = config_state
        .load()
        .await
        .map_err(|error| error.to_string())?;
    let was_paused = crate::hotkey::shortcuts_paused(app);
    if field.value(&previous) == hotkey {
        if was_paused {
            restore_shortcuts_after_failed_update(app, &previous, true)?;
        }
        return Ok(());
    }
    let mut next = previous.clone();
    field.set(&mut next, hotkey.clone());
    if let Err(error) = crate::hotkey::register_configured_shortcuts(app, &next) {
        let rollback = restore_shortcuts_after_failed_update(app, &previous, was_paused);
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!(
                "{error}; shortcut rollback also failed: {rollback_error}"
            )),
        };
    }
    let (_, config) = match config_state
        .update(move |current| field.set(current, hotkey))
        .await
    {
        Ok(committed) => committed,
        Err(error) => {
            let rollback = restore_shortcuts_after_failed_update(app, &previous, was_paused);
            return match rollback {
                Ok(()) => Err(error.to_string()),
                Err(rollback_error) => Err(format!(
                    "{error}; shortcut rollback also failed: {rollback_error}"
                )),
            };
        }
    };
    if was_paused {
        crate::hotkey::set_shortcuts_paused(app, false);
    }
    if field.value(&previous) != field.value(&config) {
        let _ = app.emit("config:patch", field.patch(&config));
    }

    Ok(())
}

#[tauri::command]
pub async fn update_hotkey(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
    hotkey: String,
) -> Result<(), String> {
    update_configured_shortcut(
        &app,
        config_state.inner(),
        mutation_lock.inner(),
        ShortcutField::Speech,
        hotkey,
    )
    .await
}

#[tauri::command]
pub async fn update_screen_ocr_hotkey(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
    hotkey: String,
) -> Result<(), String> {
    update_configured_shortcut(
        &app,
        config_state.inner(),
        mutation_lock.inner(),
        ShortcutField::ScreenOcr,
        hotkey,
    )
    .await
}

/// Temporarily unregister all global shortcuts so the webview can capture key events.
#[tauri::command]
pub async fn pause_hotkey(
    app: tauri::AppHandle,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
) -> Result<(), String> {
    let _mutation_guard = mutation_lock.0.lock().await;
    if crate::hotkey::shortcuts_paused(&app) {
        return Ok(());
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    crate::hotkey::set_shortcuts_paused(&app, true);
    Ok(())
}

/// Re-register the latest persisted shortcuts after key capture is done.
#[tauri::command]
pub async fn resume_hotkey(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
) -> Result<(), String> {
    let _mutation_guard = mutation_lock.0.lock().await;
    if !crate::hotkey::shortcuts_paused(&app) {
        return Ok(());
    }
    let config = config_state.load().await.map_err(|e| e.to_string())?;
    match crate::hotkey::register_configured_shortcuts(&app, &config) {
        Ok(()) => {
            crate::hotkey::set_shortcuts_paused(&app, false);
            Ok(())
        }
        Err(error) => {
            let cleanup = app
                .global_shortcut()
                .unregister_all()
                .map_err(|cleanup_error| cleanup_error.to_string());
            match cleanup {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error}; failed to restore the paused shortcut state: {cleanup_error}"
                )),
            }
        }
    }
}
