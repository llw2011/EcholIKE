use crate::{
    commands, idempotency, markdown_window, network, onboarding_guard, pipeline, process_ownership,
    storage,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// Cached hotkey mode to avoid loading config from disk on every keypress.
/// Updated whenever config is saved.
pub struct HotkeyModeCache(pub Arc<Mutex<String>>);

/// Cached close_to_tray setting to avoid blocking I/O in the window close handler.
pub struct CloseToTrayCache(pub Arc<Mutex<bool>>);

#[derive(Default)]
pub struct ShortcutRegistrationState(AtomicBool);

impl ShortcutRegistrationState {
    pub(crate) fn is_paused(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.0.store(paused, Ordering::Release);
    }
}

pub(crate) fn initialize(app: &mut tauri::App) -> anyhow::Result<storage::AppConfig> {
    let app_handle = app.handle().clone();

    // Initialize data directory and database
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let db_path = data_dir.join("echo.db");

    // Initialize stores
    let config_manager = storage::ConfigManager::new(app_handle.clone());
    let history_store = storage::HistoryStore::new(db_path.clone())
        .map_err(|e| anyhow::anyhow!("Failed to init history store: {}", e))?;
    let dictionary_store = storage::DictionaryStore::new(db_path.clone())
        .map_err(|e| anyhow::anyhow!("Failed to init dictionary store: {}", e))?;
    let documents_directory = app
        .path()
        .document_dir()
        .map_err(|error| format!("无法定位系统“文档”文件夹：{error}"));
    let idempotency_registry =
        idempotency::Registry::new(db_path.clone()).map_err(|error| anyhow::anyhow!(error))?;
    let markdown_speech_manager =
        commands::markdown_speech::MarkdownSpeechManager::new(db_path, documents_directory)
            .map_err(|error| anyhow::anyhow!(error))?;

    // Load initial config to get hotkey
    let initial_snapshot = match tauri::async_runtime::block_on(config_manager.load_snapshot()) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let detail = format!(
                "本地配置无法初始化，EcholIKE 将退出。\n\n数据目录：{}\n错误：{error:#}",
                data_dir.display()
            );
            tracing::error!("Failed to load app config: {error:#}");
            app.dialog()
                .message(detail)
                .title("EcholIKE 启动失败")
                .kind(MessageDialogKind::Error)
                .blocking_show();
            return Err(anyhow::anyhow!("Failed to load app config: {error:#}"));
        }
    };
    let initial_config = initial_snapshot.config;
    let boot_blocked = initial_config.onboarding_version == 0;
    let network_client = network::NetworkClient::new(&initial_config);
    let pipeline_handle = pipeline::PipelineHandle::new(
        app_handle.clone(),
        network_client.clone(),
        idempotency_registry.clone(),
    );

    app.manage(config_manager);
    app.manage(storage::ConfigMutationLock::default());
    app.manage(storage::DesktopAuthRuntimeFence::default());
    app.manage(history_store);
    app.manage(dictionary_store);
    app.manage(markdown_speech_manager);
    app.manage(idempotency_registry);
    app.manage(network_client);
    app.manage(pipeline_handle);
    app.manage(process_ownership::ProcessOwners::default());
    app.manage(markdown_window::MarkdownEditorWindowLifecycle::default());
    app.manage(HotkeyModeCache(Arc::new(Mutex::new(
        initial_config.hotkey_mode.clone(),
    ))));
    app.manage(CloseToTrayCache(Arc::new(Mutex::new(
        initial_config.close_to_tray,
    ))));
    app.manage(ShortcutRegistrationState::default());
    app.manage(onboarding_guard::OnboardingGuard::new(boot_blocked));

    Ok(initial_config)
}

#[cfg(test)]
mod tests {
    use super::ShortcutRegistrationState;

    #[test]
    fn shortcut_capture_pause_state_is_idempotent() {
        let state = ShortcutRegistrationState::default();
        assert!(!state.is_paused());
        state.set_paused(true);
        state.set_paused(true);
        assert!(state.is_paused());
        state.set_paused(false);
        assert!(!state.is_paused());
    }
}
