use crate::{commands, pipeline, storage};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Stable Tauri manager id for the application's single tray icon.
///
/// The Tauri manager is deliberately the sole owner of this resource. Its native updater cleanup
/// drops the manager-owned icon before Windows exits to run NSIS, so no second handle can keep a
/// stale icon alive across an OTA restart.
pub const TRAY_ID: &str = "echolike-main";

struct TrayLabels {
    show_window: &'static str,
    hide_window: &'static str,
    start_recording: &'static str,
    stop_recording: &'static str,
    hide_capsule_when_idle: &'static str,
    keep_capsule_visible: &'static str,
    settings: &'static str,
    about: &'static str,
    check_updates: &'static str,
    quit: &'static str,
}

fn get_tray_labels(lang: &str) -> TrayLabels {
    match lang {
        "zh" => TrayLabels {
            show_window: "显示窗口",
            hide_window: "隐藏窗口",
            start_recording: "开始录音",
            stop_recording: "停止录音",
            hide_capsule_when_idle: "空闲时隐藏胶囊",
            keep_capsule_visible: "保持胶囊可见",
            settings: "设置",
            about: "关于 EcholIKE",
            check_updates: "检查更新",
            quit: "退出",
        },
        "ja" => TrayLabels {
            show_window: "ウィンドウを表示",
            hide_window: "ウィンドウを隠す",
            start_recording: "録音を開始",
            stop_recording: "録音を停止",
            hide_capsule_when_idle: "待機中はカプセルを非表示",
            keep_capsule_visible: "カプセルを表示したままにする",
            settings: "設定",
            about: "EcholIKE について",
            check_updates: "更新を確認",
            quit: "終了",
        },
        "ko" => TrayLabels {
            show_window: "창 보이기",
            hide_window: "창 숨기기",
            start_recording: "녹음 시작",
            stop_recording: "녹음 중지",
            hide_capsule_when_idle: "유휴 시 캡슐 숨기기",
            keep_capsule_visible: "캡슐 항상 표시",
            settings: "설정",
            about: "EcholIKE 정보",
            check_updates: "업데이트 확인",
            quit: "종료",
        },
        "fr" => TrayLabels {
            show_window: "Afficher la fenêtre",
            hide_window: "Masquer la fenêtre",
            start_recording: "Démarrer l'enregistrement",
            stop_recording: "Arrêter l'enregistrement",
            hide_capsule_when_idle: "Masquer la capsule au repos",
            keep_capsule_visible: "Garder la capsule visible",
            settings: "Paramètres",
            about: "À propos d'EcholIKE",
            check_updates: "Rechercher les mises à jour",
            quit: "Quitter",
        },
        "de" => TrayLabels {
            show_window: "Fenster anzeigen",
            hide_window: "Fenster ausblenden",
            start_recording: "Aufnahme starten",
            stop_recording: "Aufnahme stoppen",
            hide_capsule_when_idle: "Kapsel im Leerlauf ausblenden",
            keep_capsule_visible: "Kapsel sichtbar lassen",
            settings: "Einstellungen",
            about: "Über EcholIKE",
            check_updates: "Nach Updates suchen",
            quit: "Beenden",
        },
        "es" => TrayLabels {
            show_window: "Mostrar ventana",
            hide_window: "Ocultar ventana",
            start_recording: "Iniciar grabación",
            stop_recording: "Detener grabación",
            hide_capsule_when_idle: "Ocultar cápsula en reposo",
            keep_capsule_visible: "Mantener cápsula visible",
            settings: "Configuración",
            about: "Acerca de EcholIKE",
            check_updates: "Buscar actualizaciones",
            quit: "Salir",
        },
        "pt" => TrayLabels {
            show_window: "Mostrar janela",
            hide_window: "Ocultar janela",
            start_recording: "Iniciar gravação",
            stop_recording: "Parar gravação",
            hide_capsule_when_idle: "Ocultar cápsula em repouso",
            keep_capsule_visible: "Manter cápsula visível",
            settings: "Configurações",
            about: "Sobre o EcholIKE",
            check_updates: "Verificar atualizações",
            quit: "Sair",
        },
        "ru" => TrayLabels {
            show_window: "Показать окно",
            hide_window: "Скрыть окно",
            start_recording: "Начать запись",
            stop_recording: "Остановить запись",
            hide_capsule_when_idle: "Скрывать капсулу в простое",
            keep_capsule_visible: "Оставлять капсулу видимой",
            settings: "Настройки",
            about: "О программе EcholIKE",
            check_updates: "Проверить обновления",
            quit: "Выход",
        },
        "it" => TrayLabels {
            show_window: "Mostra finestra",
            hide_window: "Nascondi finestra",
            start_recording: "Inizia registrazione",
            stop_recording: "Ferma registrazione",
            hide_capsule_when_idle: "Nascondi capsula quando inattiva",
            keep_capsule_visible: "Mantieni capsula visibile",
            settings: "Impostazioni",
            about: "Informazioni su EcholIKE",
            check_updates: "Controlla aggiornamenti",
            quit: "Esci",
        },
        _ => TrayLabels {
            show_window: "Show Window",
            hide_window: "Hide Window",
            start_recording: "Start Recording",
            stop_recording: "Stop Recording",
            hide_capsule_when_idle: "Hide Capsule When Idle",
            keep_capsule_visible: "Keep Capsule Visible",
            settings: "Settings",
            about: "About EcholIKE",
            check_updates: "Check for Updates",
            quit: "Quit",
        },
    }
}

fn current_app_config(app: &tauri::AppHandle) -> Option<storage::AppConfig> {
    app.try_state::<storage::ConfigManager>()
        .and_then(|state| state.current())
}

fn tray_language_from_app_config(config: Option<&storage::AppConfig>) -> String {
    config
        .map(|config| config.ui_language.clone())
        .unwrap_or_else(|| "zh".to_string())
}

fn tray_language(app: &tauri::AppHandle) -> String {
    let config = current_app_config(app);
    tray_language_from_app_config(config.as_ref())
}

fn capsule_auto_hide_from_app_config(config: Option<&storage::AppConfig>) -> bool {
    config
        .map(|config| config.capsule_auto_hide)
        .unwrap_or_else(|| storage::AppConfig::new_install_default().capsule_auto_hide)
}

fn tray_capsule_auto_hide(app: &tauri::AppHandle) -> bool {
    let config = current_app_config(app);
    capsule_auto_hide_from_app_config(config.as_ref())
}

/// Build (or rebuild) the system tray menu based on current state.
pub fn build_tray_menu(
    app: &tauri::AppHandle,
    is_recording: bool,
    window_visible: bool,
    capsule_auto_hide: bool,
) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let lang = tray_language(app);
    let labels = get_tray_labels(&lang);

    let show_hide = MenuItem::with_id(
        app,
        "show_hide",
        if window_visible {
            labels.hide_window
        } else {
            labels.show_window
        },
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let record = MenuItem::with_id(
        app,
        "record",
        if is_recording {
            labels.stop_recording
        } else {
            labels.start_recording
        },
        true,
        None::<&str>,
    )?;
    let capsule_visibility = MenuItem::with_id(
        app,
        "toggle_capsule_auto_hide",
        if capsule_auto_hide {
            labels.keep_capsule_visible
        } else {
            labels.hide_capsule_when_idle
        },
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", labels.settings, true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let about = MenuItem::with_id(app, "about", labels.about, true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        labels.check_updates,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &sep1,
            &record,
            &capsule_visibility,
            &sep2,
            &settings,
            &sep3,
            &about,
            &check_updates,
            &quit,
        ],
    )?;
    Ok(menu)
}

pub(crate) fn install_tray(
    app: &mut tauri::App,
    initial_config: &storage::AppConfig,
) -> anyhow::Result<()> {
    let app_handle = app.handle().clone();
    let tray_menu = build_tray_menu(&app_handle, false, true, initial_config.capsule_auto_hide)
        .map_err(|error| anyhow::anyhow!("Failed to build tray menu: {error}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("default window icon missing")
                .clone(),
        )
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .tooltip("EcholIKE")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "show_hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    refresh_tray(app);
                }
            }
            "record" => {
                let pipeline = app.state::<pipeline::PipelineHandle>();
                if !pipeline::toggle_event_is_actionable(pipeline.current_state()) {
                    return;
                }
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let pipeline = handle.state::<pipeline::PipelineHandle>();
                    if let Err(e) = pipeline.toggle().await {
                        tracing::error!("Tray recording toggle failed: {}", e);
                    }
                });
            }
            "toggle_capsule_auto_hide" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let config_state = handle.state::<storage::ConfigManager>();
                    let enabled = config_state
                        .load()
                        .await
                        .map(|config| !config.capsule_auto_hide)
                        .unwrap_or(true);
                    if let Err(e) =
                        commands::config::save_capsule_auto_hide(&handle, &config_state, enabled)
                            .await
                    {
                        tracing::error!("Tray capsule visibility toggle failed: {}", e);
                    }
                });
            }
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray:settings", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                    refresh_tray(app);
                }
            }
            "about" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray:about", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                    refresh_tray(app);
                }
            }
            "check_updates" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("tray:check-update", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                    refresh_tray(app);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let should_show = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if should_show {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    refresh_tray(app);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray menu and update tooltip based on pipeline state.
pub fn refresh_tray(app: &tauri::AppHandle) {
    let is_recording = app
        .try_state::<pipeline::PipelineHandle>()
        .map(|p| p.current_state() == pipeline::PipelineState::Recording)
        .unwrap_or(false);
    let window_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let capsule_auto_hide = tray_capsule_auto_hide(app);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_tray_menu(app, is_recording, window_visible, capsule_auto_hide) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Updates the tooltip on the manager-owned tray icon when it is still active.
pub fn set_tray_tooltip(app: &tauri::AppHandle, tooltip: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_include_capsule_visibility_controls() {
        let labels = get_tray_labels("en");

        assert_eq!(labels.hide_capsule_when_idle, "Hide Capsule When Idle");
        assert_eq!(labels.keep_capsule_visible, "Keep Capsule Visible");
        assert_eq!(labels.check_updates, "Check for Updates");
    }

    #[test]
    fn missing_app_config_uses_new_install_capsule_auto_hide_default() {
        assert!(capsule_auto_hide_from_app_config(None));
    }
}
