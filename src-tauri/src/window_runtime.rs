use crate::{process_ownership, storage, CloseToTrayCache};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

/// Persisted window position and size.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Copy, Clone, PartialEq)]
struct ResponsiveMainWindowSize {
    width: f64,
    height: f64,
}

const MAIN_WINDOW_PREFERRED_WIDTH: f64 = 1180.0;
const MAIN_WINDOW_PREFERRED_HEIGHT: f64 = 820.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 520.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 340.0;
const MAIN_WINDOW_WORK_AREA_GUTTER: f64 = 48.0;

fn responsive_main_window_size(
    work_area_width: f64,
    work_area_height: f64,
    scale_factor: f64,
) -> ResponsiveMainWindowSize {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    let fit_dimension = |physical: f64, preferred: f64, minimum: f64| {
        let logical = if physical.is_finite() && physical > 0.0 {
            physical / scale_factor
        } else {
            minimum
        };
        (logical - MAIN_WINDOW_WORK_AREA_GUTTER)
            .clamp(minimum, preferred)
            .round()
    };

    ResponsiveMainWindowSize {
        width: fit_dimension(
            work_area_width,
            MAIN_WINDOW_PREFERRED_WIDTH,
            MAIN_WINDOW_MIN_WIDTH,
        ),
        height: fit_dimension(
            work_area_height,
            MAIN_WINDOW_PREFERRED_HEIGHT,
            MAIN_WINDOW_MIN_HEIGHT,
        ),
    }
}

fn saved_position_fits_monitor(
    ws: &WindowState,
    monitor: Option<&tauri::Monitor>,
    current_size: Option<&tauri::PhysicalSize<u32>>,
) -> bool {
    if ws.x <= -1000 || ws.y <= -1000 || ws.width < 540 || ws.height < 420 {
        return false;
    }

    let width = current_size.map_or(ws.width, |size| size.width);
    let height = current_size.map_or(ws.height, |size| size.height);
    if ws.width.abs_diff(width) > 2 || ws.height.abs_diff(height) > 2 {
        return false;
    }

    let Some(monitor) = monitor else {
        return true;
    };

    let work_area = monitor.work_area();
    let right = i64::from(work_area.position.x) + i64::from(work_area.size.width);
    let bottom = i64::from(work_area.position.y) + i64::from(work_area.size.height);

    i64::from(ws.x) >= i64::from(work_area.position.x)
        && i64::from(ws.y) >= i64::from(work_area.position.y)
        && i64::from(ws.x) + i64::from(width) <= right
        && i64::from(ws.y) + i64::from(height) <= bottom
}

pub(crate) fn handle_global_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "windows")]
    if window.label() == "markdown-editor"
        && matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        )
    {
        if let Some(shape_window) = window.app_handle().get_webview_window("markdown-editor") {
            if let Err(error) = crate::window_shape::sync_markdown_editor_rounding(&shape_window) {
                tracing::warn!("Failed to update the Markdown editor window shape: {error}");
            }
        }
    }

    if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Some(owners) = window
            .app_handle()
            .try_state::<process_ownership::ProcessOwners>()
        {
            owners.owner_window_destroyed(window.label());
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = (window, event);
}

pub(crate) fn create_capsule_window(
    app: &tauri::App,
    startup_window_configs: &[tauri::utils::config::WindowConfig],
) -> anyhow::Result<()> {
    let capsule_config = startup_window_configs
        .iter()
        .find(|config| config.label == "capsule")
        .ok_or_else(|| anyhow::anyhow!("capsule window config is missing"))?;
    tauri::WebviewWindowBuilder::from_config(app.handle(), capsule_config)?
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()?;
    Ok(())
}

pub(crate) fn create_main_window(
    app: &tauri::App,
    startup_window_configs: &[tauri::utils::config::WindowConfig],
) -> anyhow::Result<()> {
    let main_config = startup_window_configs
        .iter()
        .find(|config| config.label == "main")
        .ok_or_else(|| anyhow::anyhow!("main window config is missing"))?;
    let responsive_size = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let work_area = monitor.work_area();
            let size = responsive_main_window_size(
                f64::from(work_area.size.width),
                f64::from(work_area.size.height),
                monitor.scale_factor(),
            );
            tracing::debug!(
                "Responsive main window size: {}x{} on logical work area {}x{}",
                size.width,
                size.height,
                (f64::from(work_area.size.width) / monitor.scale_factor()).round(),
                (f64::from(work_area.size.height) / monitor.scale_factor()).round()
            );
            size
        })
        .unwrap_or(ResponsiveMainWindowSize {
            width: main_config.width,
            height: main_config.height,
        });
    tauri::WebviewWindowBuilder::from_config(app.handle(), main_config)?
        .inner_size(responsive_size.width, responsive_size.height)
        .center()
        .prevent_overflow()
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .build()?;
    Ok(())
}

pub(crate) fn attach_main_window_handler(app: &tauri::App) {
    if let Some(main_window) = app.get_webview_window("main") {
        let handle = app.handle().clone();
        main_window.on_window_event(move |event| {
            #[cfg(target_os = "windows")]
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if let Some(shape_window) = handle.get_webview_window("main") {
                        if let Err(error) =
                            crate::window_shape::sync_main_window_rounding(&shape_window)
                        {
                            tracing::warn!("Failed to update the main window shape: {error}");
                        }
                    }
                }
                _ => {}
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = *handle
                    .state::<CloseToTrayCache>()
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                if close_to_tray {
                    api.prevent_close();
                    // Save window state before hiding (skip if minimized)
                    if let Some(w) = handle.get_webview_window("main") {
                        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
                            if pos.x > -1000
                                && pos.y > -1000
                                && size.width >= 540
                                && size.height >= 420
                            {
                                let ws = WindowState {
                                    x: pos.x,
                                    y: pos.y,
                                    width: size.width,
                                    height: size.height,
                                };
                                if let Ok(store) = handle.store(storage::RUNTIME_STATE_STORE_FILE) {
                                    if let Ok(val) = serde_json::to_value(&ws) {
                                        store.set("window_state", val);
                                        let _ = store.save();
                                    }
                                }
                            }
                        }
                        let _ = w.hide();
                    }
                    crate::tray::refresh_tray(&handle);
                }
            }
        });
    }
}

pub(crate) fn restore_or_center_main_window(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let monitor = window
            .primary_monitor()
            .ok()
            .flatten()
            .or_else(|| window.current_monitor().ok().flatten());
        let current_size = window.outer_size().ok();

        let mut restored_position = false;
        if let Ok(store) = app.handle().store(storage::RUNTIME_STATE_STORE_FILE) {
            if let Some(val) = store.get("window_state") {
                if let Ok(ws) = serde_json::from_value::<WindowState>(val.clone()) {
                    // Validate: skip if coordinates are off-screen after monitor changes.
                    if saved_position_fits_monitor(&ws, monitor.as_ref(), current_size.as_ref()) {
                        restored_position = window
                            .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                                ws.x, ws.y,
                            )))
                            .is_ok();
                    }
                }
            }
        }

        if !restored_position {
            let _ = window.center();
        }
    }
}

#[cfg(feature = "devtools")]
pub(crate) fn open_devtools(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
    if let Some(window) = app.get_webview_window("capsule") {
        window.open_devtools();
    }
}

#[tauri::command]
pub(crate) fn sync_main_window_shape(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return crate::window_shape::sync_main_window_rounding(&window);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responsive_size_fits_common_logical_work_areas() {
        assert_eq!(
            responsive_main_window_size(1920.0, 1040.0, 1.0),
            ResponsiveMainWindowSize {
                width: 1180.0,
                height: 820.0,
            }
        );
        assert_eq!(
            responsive_main_window_size(1366.0, 728.0, 1.0),
            ResponsiveMainWindowSize {
                width: 1180.0,
                height: 680.0,
            }
        );
        assert_eq!(
            responsive_main_window_size(1024.0, 560.0, 1.0),
            ResponsiveMainWindowSize {
                width: 976.0,
                height: 512.0,
            }
        );
    }

    #[test]
    fn responsive_size_uses_logical_dpi_and_keeps_bounded_fallbacks() {
        assert_eq!(
            responsive_main_window_size(1920.0, 1040.0, 1.25),
            ResponsiveMainWindowSize {
                width: 1180.0,
                height: 784.0,
            }
        );
        assert_eq!(
            responsive_main_window_size(3840.0, 2080.0, 2.0),
            ResponsiveMainWindowSize {
                width: 1180.0,
                height: 820.0,
            }
        );
        assert_eq!(
            responsive_main_window_size(560.0, 380.0, 1.0),
            ResponsiveMainWindowSize {
                width: 520.0,
                height: 340.0,
            }
        );
        assert_eq!(
            responsive_main_window_size(560.0, 380.0, 0.0),
            responsive_main_window_size(560.0, 380.0, 1.0)
        );
    }
}
