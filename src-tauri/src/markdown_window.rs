use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

pub const MARKDOWN_EDITOR_WINDOW_LABEL: &str = "markdown-editor";
pub const MARKDOWN_EDITOR_WINDOW_GENERATION_PARAM: &str = "markdownWindowGeneration";

pub fn window_url(generation: u64) -> String {
    format!("index.html?{MARKDOWN_EDITOR_WINDOW_GENERATION_PARAM}={generation}#markdown-editor")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum MarkdownEditorWindowOpenDecision {
    Create { generation: u64 },
    Pending { generation: u64 },
    RetryReveal { generation: u64 },
    Activated { generation: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkdownEditorWindowPhase {
    Reserved,
    Pending,
    Revealing,
    RetryReveal,
    Visible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ActiveMarkdownEditorWindow {
    generation: u64,
    phase: MarkdownEditorWindowPhase,
}

#[derive(Debug, Default)]
struct MarkdownEditorWindowInner {
    next_generation: u64,
    active: Option<ActiveMarkdownEditorWindow>,
}

#[derive(Debug, Default)]
pub struct MarkdownEditorWindowLifecycle(Mutex<MarkdownEditorWindowInner>);

impl MarkdownEditorWindowLifecycle {
    pub fn begin(&self, window_exists: bool) -> MarkdownEditorWindowOpenDecision {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());

        if let Some(active) = inner.active {
            return match (active.phase, window_exists) {
                (MarkdownEditorWindowPhase::Visible, true) => {
                    MarkdownEditorWindowOpenDecision::Activated {
                        generation: active.generation,
                    }
                }
                (
                    MarkdownEditorWindowPhase::Pending
                    | MarkdownEditorWindowPhase::Revealing
                    | MarkdownEditorWindowPhase::RetryReveal
                    | MarkdownEditorWindowPhase::Visible,
                    false,
                ) => {
                    inner.active = None;
                    Self::reserve_generation(&mut inner)
                }
                (MarkdownEditorWindowPhase::RetryReveal, true) => {
                    MarkdownEditorWindowOpenDecision::RetryReveal {
                        generation: active.generation,
                    }
                }
                (
                    MarkdownEditorWindowPhase::Reserved
                    | MarkdownEditorWindowPhase::Pending
                    | MarkdownEditorWindowPhase::Revealing,
                    _,
                ) => MarkdownEditorWindowOpenDecision::Pending {
                    generation: active.generation,
                },
            };
        }

        Self::reserve_generation(&mut inner)
    }

    pub fn mark_created(&self, generation: u64) -> Result<bool, String> {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let Some(active) = inner.active.as_mut() else {
            return Err("Markdown editor window has no reserved generation".to_string());
        };
        if active.generation != generation {
            return Err(format!(
                "Markdown editor generation {generation} is stale; current generation is {}",
                active.generation
            ));
        }
        if active.phase == MarkdownEditorWindowPhase::Reserved {
            active.phase = MarkdownEditorWindowPhase::Pending;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn begin_reveal(&self, generation: u64) -> Result<(), String> {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let Some(active) = inner.active.as_mut() else {
            return Err("Markdown editor window has no pending generation".to_string());
        };

        if active.generation != generation {
            return Err(format!(
                "Markdown editor generation {generation} is stale; current generation is {}",
                active.generation
            ));
        }
        match active.phase {
            MarkdownEditorWindowPhase::Reserved
            | MarkdownEditorWindowPhase::Pending
            | MarkdownEditorWindowPhase::RetryReveal => {
                active.phase = MarkdownEditorWindowPhase::Revealing;
                Ok(())
            }
            MarkdownEditorWindowPhase::Revealing => Err(format!(
                "Markdown editor generation {generation} is already being revealed"
            )),
            MarkdownEditorWindowPhase::Visible => Err(format!(
                "Markdown editor generation {generation} is already visible"
            )),
        }
    }

    pub fn mark_visible(&self, generation: u64) -> Result<(), String> {
        self.transition_reveal(generation, MarkdownEditorWindowPhase::Visible)
    }

    pub fn mark_reveal_failed(&self, generation: u64) -> bool {
        self.transition_reveal(generation, MarkdownEditorWindowPhase::RetryReveal)
            .is_ok()
    }

    pub fn fail_creation(&self, generation: u64) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(
            inner.active,
            Some(ActiveMarkdownEditorWindow {
                generation: active_generation,
                phase: MarkdownEditorWindowPhase::Reserved | MarkdownEditorWindowPhase::Pending,
            }) if active_generation == generation
        ) {
            inner.active = None;
            return true;
        }
        false
    }

    pub fn destroyed(&self, generation: u64) -> bool {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(inner.active, Some(active) if active.generation == generation) {
            inner.active = None;
            return true;
        }
        false
    }

    fn transition_reveal(
        &self,
        generation: u64,
        next_phase: MarkdownEditorWindowPhase,
    ) -> Result<(), String> {
        let mut inner = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let Some(active) = inner.active.as_mut() else {
            return Err("Markdown editor window has no active generation".to_string());
        };
        if active.generation != generation {
            return Err(format!(
                "Markdown editor generation {generation} is stale; current generation is {}",
                active.generation
            ));
        }
        if active.phase != MarkdownEditorWindowPhase::Revealing {
            return Err(format!(
                "Markdown editor generation {generation} is not being revealed"
            ));
        }

        active.phase = next_phase;
        Ok(())
    }

    fn reserve_generation(
        inner: &mut MarkdownEditorWindowInner,
    ) -> MarkdownEditorWindowOpenDecision {
        inner.next_generation = inner.next_generation.saturating_add(1).max(1);
        let generation = inner.next_generation;
        inner.active = Some(ActiveMarkdownEditorWindow {
            generation,
            phase: MarkdownEditorWindowPhase::Reserved,
        });
        MarkdownEditorWindowOpenDecision::Create { generation }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownEditorWindowOptions {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    background_color: [u8; 4],
}

impl MarkdownEditorWindowOptions {
    fn validate(&self) -> Result<(), String> {
        let dimensions = [self.width, self.height, self.min_width, self.min_height];
        if dimensions
            .iter()
            .any(|value| !value.is_finite() || !(320.0..=8192.0).contains(value))
        {
            return Err("Markdown editor window dimensions are outside the supported range".into());
        }
        if self.width < self.min_width || self.height < self.min_height {
            return Err("Markdown editor window cannot be smaller than its minimum size".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn begin_markdown_editor_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    options: MarkdownEditorWindowOptions,
    lifecycle: tauri::State<'_, MarkdownEditorWindowLifecycle>,
) -> Result<MarkdownEditorWindowOpenDecision, String> {
    if window.label() != "main" {
        return Err(format!(
            "Markdown editor window creation is restricted to the main window, got {:?}",
            window.label()
        ));
    }

    let existing = app
        .get_webview_window(MARKDOWN_EDITOR_WINDOW_LABEL)
        .is_some();
    options.validate()?;
    let decision = lifecycle.begin(existing);
    if let MarkdownEditorWindowOpenDecision::Create { generation } = decision {
        let [red, green, blue, alpha] = options.background_color;
        let editor = tauri::WebviewWindowBuilder::new(
            &app,
            MARKDOWN_EDITOR_WINDOW_LABEL,
            tauri::WebviewUrl::App(std::path::PathBuf::from(window_url(generation))),
        )
        .title("Markdown 编辑器")
        .inner_size(options.width, options.height)
        .min_inner_size(options.min_width, options.min_height)
        .prevent_overflow()
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::utils::config::Color(red, green, blue, alpha))
        .shadow(false)
        .center()
        .skip_taskbar(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| {
            lifecycle.fail_creation(generation);
            format!("Could not create Markdown editor generation {generation}: {error}")
        })?;

        let lifecycle_app = app.clone();
        editor.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            if let Some(lifecycle) = lifecycle_app.try_state::<MarkdownEditorWindowLifecycle>() {
                lifecycle.destroyed(generation);
            }
        });

        if let Err(error) = lifecycle.mark_created(generation) {
            if let Err(close_error) = editor.close() {
                tracing::warn!(
                    "Could not close Markdown editor generation {generation} after a stale creation: {close_error}"
                );
            }
            return Err(error);
        }
        return Ok(decision);
    }
    if let MarkdownEditorWindowOpenDecision::RetryReveal { generation } = decision {
        let editor = app
            .get_webview_window(MARKDOWN_EDITOR_WINDOW_LABEL)
            .ok_or_else(|| "Markdown editor ready window disappeared before retry".to_string())?;
        reveal_markdown_editor_window_generation(&editor, generation, &lifecycle)?;
        return Ok(MarkdownEditorWindowOpenDecision::Activated { generation });
    }
    if matches!(decision, MarkdownEditorWindowOpenDecision::Activated { .. }) {
        let editor = app
            .get_webview_window(MARKDOWN_EDITOR_WINDOW_LABEL)
            .ok_or_else(|| {
                "Markdown editor visible window disappeared before activation".to_string()
            })?;
        editor.show().map_err(|error| {
            format!("Could not show the visible Markdown editor window: {error}")
        })?;
        if let Err(error) = editor.set_focus() {
            tracing::warn!("Could not focus the visible Markdown editor window: {error}");
        }
    }
    Ok(decision)
}

#[tauri::command]
pub(crate) fn reveal_markdown_editor_window(
    window: tauri::WebviewWindow,
    generation: u64,
    lifecycle: tauri::State<'_, MarkdownEditorWindowLifecycle>,
) -> Result<(), String> {
    if window.label() != MARKDOWN_EDITOR_WINDOW_LABEL {
        return Err(format!(
            "Markdown editor reveal is restricted to its own renderer, got {:?}",
            window.label()
        ));
    }

    reveal_markdown_editor_window_generation(&window, generation, &lifecycle)
}

fn reveal_markdown_editor_window_generation(
    window: &tauri::WebviewWindow,
    generation: u64,
    lifecycle: &MarkdownEditorWindowLifecycle,
) -> Result<(), String> {
    lifecycle.begin_reveal(generation)?;

    #[cfg(target_os = "windows")]
    if let Err(error) = crate::window_shape::sync_markdown_editor_rounding(window) {
        tracing::warn!("Failed to update the Markdown editor window shape before reveal: {error}");
    }

    if let Err(error) = window.show() {
        lifecycle.mark_reveal_failed(generation);
        return Err(format!(
            "Could not show Markdown editor generation {generation}: {error}"
        ));
    }

    if let Err(error) = lifecycle.mark_visible(generation) {
        if let Err(hide_error) = window.hide() {
            tracing::warn!(
                "Could not hide Markdown editor generation {generation} after a stale reveal: {hide_error}"
            );
        }
        return Err(error);
    }
    if let Err(error) = window.set_focus() {
        tracing::warn!("Could not focus the visible Markdown editor window: {error}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{window_url, MarkdownEditorWindowLifecycle, MarkdownEditorWindowOpenDecision};

    #[test]
    fn generation_is_embedded_in_the_native_child_url() {
        assert_eq!(
            window_url(42),
            "index.html?markdownWindowGeneration=42#markdown-editor"
        );
    }

    #[test]
    fn pending_generation_cannot_be_activated_or_replaced_by_reentry() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Pending { generation: 1 }
        );
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::Pending { generation: 1 }
        );
    }

    #[test]
    fn only_the_matching_generation_can_become_ready_once() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert!(lifecycle.mark_created(1).unwrap());
        assert!(lifecycle.begin_reveal(2).is_err());
        assert!(lifecycle.begin_reveal(1).is_ok());
        assert!(lifecycle.begin_reveal(1).is_err());
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::Pending { generation: 1 }
        );
        assert!(lifecycle.mark_visible(1).is_ok());
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::Activated { generation: 1 }
        );
    }

    #[test]
    fn matched_failure_and_destroy_release_the_current_generation() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert!(lifecycle.fail_creation(1));
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 2 }
        );
        assert!(lifecycle.mark_created(2).unwrap());
        assert!(!lifecycle.fail_creation(1));
        assert!(lifecycle.begin_reveal(2).is_ok());
        assert!(lifecycle.mark_visible(2).is_ok());
        assert!(!lifecycle.destroyed(1));
        assert!(lifecycle.destroyed(2));
        assert!(!lifecycle.destroyed(2));
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 3 }
        );
    }

    #[test]
    fn missing_ready_window_reserves_a_fresh_generation() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert!(lifecycle.mark_created(1).unwrap());
        assert!(lifecycle.begin_reveal(1).is_ok());
        assert!(lifecycle.mark_visible(1).is_ok());
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 2 }
        );
    }

    #[test]
    fn missing_created_window_recovers_without_accepting_a_stale_destroy() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert!(lifecycle.mark_created(1).unwrap());
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 2 }
        );
        assert!(!lifecycle.destroyed(1));
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Pending { generation: 2 }
        );
    }

    #[test]
    fn failed_show_is_retryable_without_exposing_a_revealing_window() {
        let lifecycle = MarkdownEditorWindowLifecycle::default();
        assert_eq!(
            lifecycle.begin(false),
            MarkdownEditorWindowOpenDecision::Create { generation: 1 }
        );
        assert!(lifecycle.mark_created(1).unwrap());
        assert!(lifecycle.begin_reveal(1).is_ok());
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::Pending { generation: 1 }
        );
        assert!(lifecycle.mark_reveal_failed(1));
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::RetryReveal { generation: 1 }
        );
        assert!(lifecycle.begin_reveal(1).is_ok());
        assert!(lifecycle.mark_visible(1).is_ok());
        assert_eq!(
            lifecycle.begin(true),
            MarkdownEditorWindowOpenDecision::Activated { generation: 1 }
        );
    }
}
