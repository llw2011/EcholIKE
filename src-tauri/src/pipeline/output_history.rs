use super::{commit_generation_effect, is_accessibility_trusted, PipelineHandle, PipelineState};
use crate::app_detector;
use crate::output::{self, OutputMode};
use crate::storage;
use anyhow::Result;
use tauri::{Emitter, Manager};

impl PipelineHandle {
    /// Save the transcription to history.
    pub(super) fn save_history(
        &self,
        raw_text: &str,
        final_text: &str,
        app_ctx: &app_detector::AppContext,
        duration_ms: Option<i64>,
    ) -> bool {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        let entry = storage::HistoryEntry {
            id: 0, // auto-increment
            created_at: now,
            app_name: app_ctx.app_name.clone(),
            app_type: format!("{:?}", app_ctx.app_type),
            raw_text: raw_text.to_string(),
            polished_text: final_text.to_string(),
            language: None,
            duration_ms,
        };
        match self.app_handle.state::<storage::HistoryStore>().add(entry) {
            Ok(_) => true,
            Err(error) => {
                tracing::error!("Failed to save history: {}", error);
                false
            }
        }
    }

    pub(super) async fn output_text_and_report(
        &self,
        text: &str,
        app_name: &str,
        config: &storage::AppConfig,
        generation: u64,
    ) -> bool {
        match self.output_text(text, app_name, config, generation).await {
            Ok(()) => true,
            Err(error) => {
                tracing::error!("Output failed: {}", error);
                self.emit_pipeline_error_message(generation, format!("Output failed: {error}"));
                false
            }
        }
    }

    async fn output_text(
        &self,
        text: &str,
        app_name: &str,
        config: &storage::AppConfig,
        generation: u64,
    ) -> Result<()> {
        let mode = if config.output_mode == "keyboard" {
            OutputMode::Keyboard
        } else {
            OutputMode::Clipboard
        };

        if mode == OutputMode::Keyboard && !is_accessibility_trusted() {
            anyhow::bail!("ACCESSIBILITY_REQUIRED");
        }

        // Linux: check keyboard availability before attempting
        let mut wayland_warning = None;
        let effective_mode = if mode == OutputMode::Keyboard {
            if let Err(reason) = output::keyboard::check_keyboard_available() {
                if reason == "wayland_unsupported" {
                    tracing::warn!(
                        "Keyboard output not supported on Wayland, falling back to clipboard"
                    );
                    wayland_warning = Some(crate::error::UserError {
                        code: "output_wayland_unsupported".to_string(),
                        details: None,
                        retry_count: 0,
                    });
                    OutputMode::Clipboard
                } else {
                    tracing::warn!("xdotool not found, keyboard output may fail: {}", reason);
                    mode
                }
            } else {
                mode
            }
        } else {
            mode
        };

        let output_task = commit_generation_effect(
            &self.transition_commit_guard,
            &self.abort_flag,
            &self.active_generation,
            generation,
            || {
                self.set_state(PipelineState::Outputting);
                if let Some(warning) = wayland_warning {
                    let _ = self.app_handle.emit("pipeline:warning", warning);
                }
                let app_handle = self.app_handle.clone();
                let text = text.to_string();
                tokio::spawn(async move {
                    output::output_with_fallback(&app_handle, &text, effective_mode).await
                })
            },
        );
        let Some(output_task) = output_task else {
            return Ok(());
        };
        let output_result = output_task
            .await
            .map_err(|error| anyhow::anyhow!("Output task failed: {error}"))?;

        match output_result {
            Ok(Some(user_error)) => {
                tracing::info!("Output fell back to clipboard");
                self.with_active_generation(generation, || {
                    let _ = self.app_handle.emit("pipeline:warning", &user_error);
                });
            }
            Ok(None) => {}
            Err(error) => anyhow::bail!(error),
        }

        self.with_active_generation(generation, || {
            let _ = self.app_handle.emit("pipeline:target_app", app_name);
        });
        Ok(())
    }
}

pub(super) fn completed_cloud_operation(
    operation_id: String,
    output_delivered: bool,
) -> Option<String> {
    output_delivered.then_some(operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_llm_operation_remains_pending_when_output_delivery_fails() {
        assert_eq!(
            completed_cloud_operation("operation-1".to_string(), false),
            None
        );
        assert_eq!(
            completed_cloud_operation("operation-1".to_string(), true),
            Some("operation-1".to_string())
        );
    }
}
