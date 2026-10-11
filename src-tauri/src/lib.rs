pub mod app_detector;
pub mod audio;
pub mod commands;
pub mod error;
pub mod hotkey;
mod idempotency;
#[cfg(target_os = "linux")]
mod linux_x11;
pub mod llm;
mod managed_state;
mod markdown_window;
pub mod network;
mod onboarding_guard;
pub mod output;
pub mod pipeline;
pub mod process_ownership;
pub mod storage;
pub mod stt;
pub mod system_audio;
pub mod tray;
mod window_runtime;
#[cfg(target_os = "windows")]
mod window_shape;

pub use hotkey::{default_shortcut, parse_hotkey};
pub use managed_state::{CloseToTrayCache, HotkeyModeCache, ShortcutRegistrationState};
pub use tray::refresh_tray;

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tracing_subscriber::EnvFilter;

#[tauri::command]
async fn start_recording(
    state: tauri::State<'_, pipeline::PipelineHandle>,
) -> Result<bool, String> {
    state.start().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop_recording(state: tauri::State<'_, pipeline::PipelineHandle>) -> Result<bool, String> {
    state.stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn abort_recording(
    state: tauri::State<'_, pipeline::PipelineHandle>,
) -> Result<bool, String> {
    Ok(state.abort())
}

/// On Linux with NVIDIA proprietary drivers + Wayland, WebKit's DMA-BUF renderer
/// crashes in libnvidia-eglcore during GL context teardown. Set env vars to disable
/// it before any WebView is created. See GitHub issue #36.
fn apply_linux_workarounds() {
    #[cfg(target_os = "linux")]
    {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
        let is_nvidia = std::path::Path::new("/proc/driver/nvidia").exists()
            || std::env::var("__GLX_VENDOR_LIBRARY_NAME")
                .map(|v| v.eq_ignore_ascii_case("nvidia"))
                .unwrap_or(false);

        if is_nvidia && session == "wayland" {
            tracing::info!("Detected NVIDIA + Wayland, disabling WebKit DMA-BUF renderer");
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    let xinitthreads_status = linux_x11::init_xlib_threads();

    apply_linux_workarounds();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("echo=debug".parse().expect("static directive is valid")),
        )
        .init();

    #[cfg(target_os = "linux")]
    match xinitthreads_status {
        linux_x11::XInitThreadsStatus::Enabled => {
            tracing::debug!("Initialized Xlib thread support with XInitThreads");
        }
        linux_x11::XInitThreadsStatus::Unavailable => {
            tracing::debug!("libX11 unavailable; skipping XInitThreads");
        }
        linux_x11::XInitThreadsStatus::Failed => {
            tracing::warn!("XInitThreads returned failure; Xlib thread support may be unavailable");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_window_event(window_runtime::handle_global_window_event)
        .setup(|app| {
            let initial_config = managed_state::initialize(app)?;

            // Sync auto-start state with system
            if let Err(error) =
                commands::config::synchronize_auto_start(app.handle(), &initial_config)
            {
                tracing::warn!("Failed to synchronize auto-start during setup: {error}");
            }

            // Register global shortcut from config
            hotkey::install_configured_shortcuts(app.handle(), &initial_config)?;

            // System tray
            tray::install_tray(app, &initial_config)?;

            // Configured windows are deliberately created only after every command state and
            // native service is ready. A hidden WebView still executes JavaScript, so allowing
            // Tauri to create these windows before setup would let startup IPC outrun app.manage.
            let startup_window_configs = app.config().app.windows.clone();
            window_runtime::create_capsule_window(app, &startup_window_configs)?;
            window_runtime::create_main_window(app, &startup_window_configs)?;
            window_runtime::attach_main_window_handler(app);
            window_runtime::restore_or_center_main_window(app);

            // Open devtools only when the "devtools" feature is explicitly enabled.
            #[cfg(feature = "devtools")]
            window_runtime::open_devtools(app);

            tracing::info!("EcholIKE started");

            // P1-2: Pre-warm HTTP connection pool in background
            let warm_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let pipeline = warm_handle.state::<pipeline::PipelineHandle>();
                pipeline.pre_warm().await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            abort_recording,
            process_ownership::acquire_tts_playback_owner,
            process_ownership::release_tts_playback_owner,
            process_ownership::get_markdown_ai_tasks,
            process_ownership::consume_markdown_ai_task,
            process_ownership::run_proxy_markdown_ai,
            process_ownership::run_local_markdown_ai,
            process_ownership::get_file_command_tasks,
            process_ownership::consume_file_command_task,
            process_ownership::notify_owner_window_destroyed,
            commands::markdown_speech::get_markdown_speech_state,
            commands::markdown_speech::start_markdown_speech_generation,
            commands::markdown_speech::read_markdown_speech_audio,
            commands::markdown_speech::open_markdown_speech_directory,
            commands::markdown_speech::reveal_markdown_speech_asset,
            commands::misc::check_accessibility_permission,
            commands::misc::request_accessibility_permission,
            commands::config::get_config_snapshot,
            commands::config::choose_usage_mode,
            commands::config::detect_system_http_proxy,
            commands::config::update_config,
            commands::backend::backend_auth_sign_in,
            commands::backend::acknowledge_idempotent_operation,
            commands::backend::ask_proxy_llm_once,
            commands::backend::proxy_tts_once,
            commands::backend::diagnose_tts_proxy,
            commands::llm::bench_llm_connection,
            commands::llm::ask_llm_once,
            commands::ocr::test_ocr_connection,
            commands::ocr::read_screen_ocr,
            commands::ocr::read_screen_ocr_proxy,
            commands::ocr::read_screen_ocr_selection,
            commands::ocr::read_screen_ocr_selection_proxy,
            commands::ocr::read_uploaded_ocr,
            commands::ocr::read_uploaded_ocr_proxy,
            commands::ocr::read_uploaded_pdf_proxy,
            commands::ocr::run_export_pdf_images,
            commands::ocr::diagnose_pdf_upload,
            commands::ocr::open_markdown_file,
            commands::ocr::run_export_markdown_docx,
            commands::ocr::run_save_markdown_file,
            commands::ocr::run_export_markdown_file,
            commands::stt::bench_stt_connection,
            commands::llm::fetch_llm_models,
            commands::history::get_history,
            commands::history::delete_history_entries,
            commands::history::clear_history,
            commands::dictionary::get_dictionary,
            commands::misc::update_hotkey,
            commands::misc::update_screen_ocr_hotkey,
            commands::misc::pause_hotkey,
            commands::misc::resume_hotkey,
            commands::misc::refresh_tray_labels,
            commands::misc::quit_app,
            window_runtime::sync_main_window_shape,
            markdown_window::begin_markdown_editor_window,
            markdown_window::reveal_markdown_editor_window,
            onboarding_guard::resolve_onboarding_startup,
            onboarding_guard::acquire_onboarding_guard,
            onboarding_guard::release_onboarding_guard,
            commands::update::check_ota_update,
            commands::update::fetch_desktop_bootstrap,
            commands::update::load_desktop_auth_snapshot,
            commands::update::confirm_desktop_auth_runtime,
            commands::update::invalidate_desktop_auth_runtime,
            commands::update::begin_desktop_auth_candidate,
            commands::update::begin_desktop_auth_candidate_for_login,
            commands::update::commit_desktop_auth_candidate,
            commands::update::clear_desktop_auth_authority,
            commands::config::set_auto_start,
            commands::config::set_capsule_auto_hide,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
