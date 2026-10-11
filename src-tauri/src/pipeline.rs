use anyhow::Result;
#[cfg(not(target_os = "macos"))]
use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use futures_util::StreamExt;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Notify;

use crate::app_detector;
use crate::audio::{
    AudioCaptureFault, AudioCaptureHandle, AudioCaptureQuality, AudioCaptureStartupTimeout,
    AudioCaptureStats, AudioConfig,
};
use crate::llm::{self, LlmConfig, PolishRequest};
use crate::onboarding_guard::OnboardingGuard;
use crate::storage;
use crate::stt::{self, SttConfig, TranscriptEvent};

mod cloud_policy;
mod errors;
mod output_history;
mod proxy_protocol;

use cloud_policy::{
    backend_stt_policy, load_cloud_proxy_policy, proxy_endpoint, uses_backend_config_source,
    CloudProxyPolicy,
};
use errors::{
    audio_capture_completion_error, audio_capture_fault_user_error, audio_user_error,
    config_load_user_error, llm_polish_user_error, no_speech_user_error, stt_timeout_user_error,
};
use output_history::completed_cloud_operation;
use proxy_protocol::{
    backend_stt_error_code, parse_complete_proxy_llm_stream, parse_proxy_stt_transcript,
    wav_from_pcm_16khz_mono, BackendSttUserError, IncompleteProxyLlmStream,
    PROXY_LLM_STREAM_MAX_BYTES,
};

// --- Timing constants ---

/// On macOS, verify whether the process has been granted Accessibility (Assistive Access)
/// permission. enigo uses CGEventPost under the hood, which requires this permission;
/// without it all synthesised key events are silently dropped by the OS.
/// Returns true on all non-macOS platforms (no permission needed).
pub fn is_accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> u8;
        }
        unsafe { AXIsProcessTrusted() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// On macOS, request Accessibility permission by opening the system Privacy pane.
/// Returns true if permission is already granted or on non-macOS platforms.
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        if is_accessibility_trusted() {
            return true;
        }

        if let Err(e) = std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
        {
            tracing::warn!("Failed to open macOS Accessibility settings: {}", e);
        }

        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Delay before capturing selected text to ensure hotkey modifiers are released.
const SELECTED_TEXT_CAPTURE_DELAY_MS: u64 = 60;
/// Delay after simulating Ctrl+C to let the clipboard update.
const CLIPBOARD_COPY_SETTLE_MS: u64 = 100;
/// Interval for polling audio volume during recording.
const VOLUME_POLL_INTERVAL_MS: u64 = 50;
const METER_ATTACK: f32 = 0.60;
const METER_RELEASE: f32 = 0.25;
const METER_SILENCE_SNAP: f32 = 0.01;
/// Timeout for STT finalization after recording stops.
const STT_FINALIZE_TIMEOUT_SECS: u64 = 120;

fn effective_max_recording_seconds(seconds: u32) -> u64 {
    seconds.clamp(5, 15 * 60) as u64
}

fn should_run_llm(config: &storage::AppConfig, has_selected_text: bool) -> bool {
    config.polish_enabled || config.translate_enabled || has_selected_text
}

fn llm_provider_requires_api_key(provider: &str) -> bool {
    provider != "ollama"
}

fn has_llm_access(config: &storage::AppConfig) -> bool {
    !config.llm_base_url.trim().is_empty()
        && !config.llm_model.trim().is_empty()
        && (!llm_provider_requires_api_key(&config.llm_provider)
            || !config.llm_api_key.trim().is_empty())
}

fn should_mute_system_audio_during_recording(config: &storage::AppConfig) -> bool {
    config.mute_system_audio_during_recording
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineState {
    Idle,
    Recording,
    Transcribing,
    Polishing,
    Outputting,
}

impl PipelineState {
    fn as_u8(self) -> u8 {
        match self {
            Self::Idle => 0,
            Self::Recording => 1,
            Self::Transcribing => 2,
            Self::Polishing => 3,
            Self::Outputting => 4,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Recording,
            2 => Self::Transcribing,
            3 => Self::Polishing,
            4 => Self::Outputting,
            _ => Self::Idle,
        }
    }
}

pub fn toggle_event_is_actionable(state: PipelineState) -> bool {
    matches!(state, PipelineState::Idle | PipelineState::Recording)
}

#[derive(Clone)]
struct SttTaskControl {
    id: u64,
    done: Arc<Notify>,
    abort: Arc<Notify>,
    finalize: Arc<Notify>,
}

fn should_finalize_stt_task(
    abort_flag: &AtomicBool,
    active_session_id: &AtomicU64,
    task_session_id: u64,
) -> bool {
    !abort_flag.load(Ordering::SeqCst)
        && active_session_id.load(Ordering::SeqCst) == task_session_id
}

async fn wait_for_stt_finalize_permission(control: &SttTaskControl) -> bool {
    tokio::select! {
        _ = control.abort.notified() => false,
        _ = control.finalize.notified() => true,
    }
}

async fn wait_for_stt_completion(control: &SttTaskControl, timeout: Duration) -> bool {
    tokio::select! {
        _ = control.done.notified() => true,
        _ = tokio::time::sleep(timeout) => false,
    }
}

fn is_active_generation(
    abort_flag: &AtomicBool,
    active_generation: &AtomicU64,
    generation: u64,
) -> bool {
    !abort_flag.load(Ordering::SeqCst) && active_generation.load(Ordering::SeqCst) == generation
}

fn commit_generation_effect<T>(
    transition_commit_guard: &Mutex<()>,
    abort_flag: &AtomicBool,
    active_generation: &AtomicU64,
    generation: u64,
    effect: impl FnOnce() -> T,
) -> Option<T> {
    let _guard = transition_commit_guard
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !is_active_generation(abort_flag, active_generation, generation) {
        return None;
    }
    Some(effect())
}

fn next_meter_envelope(current: f32, target: f32) -> f32 {
    let current = if current.is_finite() {
        current.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let target = if target.is_finite() {
        target.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let coefficient = if target >= current {
        METER_ATTACK
    } else {
        METER_RELEASE
    };
    let next = (current + (target - current) * coefficient).clamp(0.0, 1.0);
    if target == 0.0 && next <= METER_SILENCE_SNAP {
        0.0
    } else {
        next
    }
}

async fn lock_pipeline_if<'a>(
    pipeline_lock: &'a tokio::sync::Mutex<()>,
    should_start: impl FnOnce() -> bool + Send,
) -> Option<tokio::sync::MutexGuard<'a, ()>> {
    let guard = pipeline_lock.lock().await;
    should_start().then_some(guard)
}

fn matches_expected_generation(
    expected_generation: Option<u64>,
    abort_flag: &AtomicBool,
    active_generation: &AtomicU64,
) -> bool {
    expected_generation
        .map(|expected| is_active_generation(abort_flag, active_generation, expected))
        .unwrap_or(true)
}

fn take_matching_stt_error(
    stt_error: &Mutex<Option<(u64, crate::error::UserError)>>,
    session_id: u64,
) -> Option<crate::error::UserError> {
    let mut guard = stt_error.lock().unwrap_or_else(|e| e.into_inner());
    if guard
        .as_ref()
        .is_some_and(|(latched_session_id, _)| *latched_session_id == session_id)
    {
        return guard.take().map(|(_, error)| error);
    }
    None
}

fn selected_text_from_clipboard_result(selected: Option<String>, sentinel: &str) -> Option<String> {
    match selected {
        Some(text) if !text.trim().is_empty() && text != sentinel => Some(text),
        _ => None,
    }
}

fn clipboard_copy_sentinel() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("__echo_copy_sentinel_{}_{}__", std::process::id(), nanos)
}

#[cfg(target_os = "macos")]
fn copy_selected_text_to_clipboard() -> bool {
    match std::process::Command::new("/usr/bin/osascript")
        .args([
            "-e",
            r#"tell application "System Events" to keystroke "c" using command down"#,
        ])
        .status()
    {
        Ok(status) if status.success() => true,
        Ok(status) => {
            tracing::warn!(
                "macOS selected-text copy failed with exit code: {:?}",
                status.code()
            );
            false
        }
        Err(e) => {
            tracing::warn!("Failed to run osascript for selected-text copy: {}", e);
            false
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_selected_text_to_clipboard() -> bool {
    let Ok(mut enigo) = Enigo::new(&EnigoSettings::default()) else {
        return false;
    };

    let pressed = enigo.key(Key::Control, Direction::Press).is_ok();
    if pressed {
        let _ = enigo.key(Key::Unicode('c'), Direction::Click);
        let _ = enigo.key(Key::Control, Direction::Release);
    }
    pressed
}

pub struct PipelineHandle {
    app_handle: tauri::AppHandle,
    state: Arc<AtomicU8>,
    audio_handle: Arc<Mutex<Option<AudioCaptureHandle>>>,
    accumulated_text: Arc<Mutex<String>>,
    stt_session: Arc<Mutex<Option<SttTaskControl>>>,
    stt_error: Arc<Mutex<Option<(u64, crate::error::UserError)>>>,
    active_stt_session_id: Arc<AtomicU64>,
    abort_flag: Arc<AtomicBool>,
    active_generation: Arc<AtomicU64>,
    in_flight_operations: Arc<AtomicUsize>,
    abort_in_progress: AtomicBool,
    transition_commit_guard: Arc<Mutex<()>>,
    preloaded_config: Arc<Mutex<Option<storage::AppConfig>>>,
    preloaded_cloud_policy: Arc<Mutex<Option<CloudProxyPolicy>>>,
    preloaded_app_ctx: Arc<Mutex<Option<app_detector::AppContext>>>,
    preloaded_dictionary: Arc<Mutex<Option<Vec<String>>>>,
    proxy_audio_buffer: Arc<Mutex<Vec<u8>>>,
    recording_start: Arc<Mutex<Option<std::time::Instant>>>,
    system_audio_mute_guard: Arc<Mutex<Option<crate::system_audio::SystemAudioMuteGuard>>>,
    network_client: crate::network::NetworkClient,
    idempotency_registry: crate::idempotency::Registry,
    /// Serializes start()/stop() so that stop() waits for start() to finish
    /// its setup before reading shared state (preloaded_config, audio_handle, etc.).
    /// Without this, a quick press-release in hold mode causes stop() to run
    /// while start() is still connecting to STT, finding empty fields.
    pipeline_lock: tokio::sync::Mutex<()>,
    /// Preserves toggle-event parity across independently spawned native callbacks.
    toggle_lock: tokio::sync::Mutex<()>,
}

struct PipelineInFlightGuard {
    counter: Arc<AtomicUsize>,
}

impl PipelineInFlightGuard {
    fn enter(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self {
            counter: counter.clone(),
        }
    }
}

impl Drop for PipelineInFlightGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

fn try_pipeline_transition(state: &AtomicU8, from: PipelineState, to: PipelineState) -> bool {
    state
        .compare_exchange(from.as_u8(), to.as_u8(), Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn try_begin_abort_transition(state: &AtomicU8, abort_owner: &AtomicBool) -> bool {
    PipelineState::from_u8(state.load(Ordering::SeqCst)) != PipelineState::Idle
        && abort_owner
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

impl PipelineHandle {
    pub fn new(
        app_handle: tauri::AppHandle,
        network_client: crate::network::NetworkClient,
        idempotency_registry: crate::idempotency::Registry,
    ) -> Self {
        Self {
            app_handle,
            state: Arc::new(AtomicU8::new(PipelineState::Idle.as_u8())),
            audio_handle: Arc::new(Mutex::new(None)),
            accumulated_text: Arc::new(Mutex::new(String::new())),
            stt_session: Arc::new(Mutex::new(None)),
            stt_error: Arc::new(Mutex::new(None)),
            active_stt_session_id: Arc::new(AtomicU64::new(0)),
            abort_flag: Arc::new(AtomicBool::new(false)),
            active_generation: Arc::new(AtomicU64::new(0)),
            in_flight_operations: Arc::new(AtomicUsize::new(0)),
            abort_in_progress: AtomicBool::new(false),
            transition_commit_guard: Arc::new(Mutex::new(())),
            preloaded_config: Arc::new(Mutex::new(None)),
            preloaded_cloud_policy: Arc::new(Mutex::new(None)),
            preloaded_app_ctx: Arc::new(Mutex::new(None)),
            preloaded_dictionary: Arc::new(Mutex::new(None)),
            proxy_audio_buffer: Arc::new(Mutex::new(Vec::new())),
            recording_start: Arc::new(Mutex::new(None)),
            system_audio_mute_guard: Arc::new(Mutex::new(None)),
            network_client,
            idempotency_registry,
            pipeline_lock: tokio::sync::Mutex::new(()),
            toggle_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn set_state(&self, new_state: PipelineState) {
        self.state.store(new_state.as_u8(), Ordering::SeqCst);
        let _ = self.app_handle.emit("pipeline:state", new_state);

        // Update tray tooltip + menu to reflect pipeline state.
        let tooltip = match new_state {
            PipelineState::Recording => "EcholIKE - Recording...",
            PipelineState::Transcribing => "EcholIKE - Transcribing...",
            PipelineState::Polishing => "EcholIKE - Polishing...",
            PipelineState::Outputting => "EcholIKE - Outputting...",
            PipelineState::Idle => "EcholIKE",
        };
        crate::tray::set_tray_tooltip(&self.app_handle, tooltip);
        crate::refresh_tray(&self.app_handle);
    }

    pub fn has_in_flight_operation(&self) -> bool {
        self.in_flight_operations.load(Ordering::SeqCst) != 0
    }

    fn with_active_generation(&self, generation: u64, effect: impl FnOnce()) -> bool {
        commit_generation_effect(
            &self.transition_commit_guard,
            &self.abort_flag,
            &self.active_generation,
            generation,
            effect,
        )
        .is_some()
    }

    fn emit_pipeline_error_message(&self, generation: u64, message: String) {
        self.with_active_generation(generation, || {
            let _ = self.app_handle.emit("pipeline:error", message);
        });
    }

    fn invalidate_rejected_backend_authority(&self, policy: &CloudProxyPolicy) -> &'static str {
        match storage::clear_desktop_auth_authority(
            &self.app_handle,
            policy.auth_generation,
            Some(&policy.auth_token),
        ) {
            Ok(Some(_)) => {
                self.app_handle
                    .state::<storage::DesktopAuthRuntimeFence>()
                    .invalidate_if_matches(policy.auth_generation, Some(&policy.auth_token));
                crate::commands::update::emit_desktop_auth_state_changed(&self.app_handle, true);
                "backend_auth_expired"
            }
            Ok(None) => "backend_auth_changed",
            Err(error) => {
                tracing::warn!("Failed to clear rejected desktop auth authority: {error}");
                let invalidated = self
                    .app_handle
                    .state::<storage::DesktopAuthRuntimeFence>()
                    .invalidate_if_matches(policy.auth_generation, Some(&policy.auth_token));
                if invalidated {
                    "backend_auth_expired"
                } else {
                    "backend_auth_changed"
                }
            }
        }
    }

    fn mute_system_audio_for_recording(&self, config: &storage::AppConfig, generation: u64) {
        if !should_mute_system_audio_during_recording(config) {
            return;
        }

        if let Some(error) = self.restore_system_audio_mute() {
            self.emit_pipeline_error_message(generation, error);
        }

        match crate::system_audio::SystemAudioMuteGuard::mute_for_recording() {
            Ok(guard) => {
                tracing::info!(
                    "System output muted for recording (previous_muted={})",
                    guard.previous_muted()
                );
                *self
                    .system_audio_mute_guard
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(guard);
            }
            Err(error) => {
                tracing::warn!("Failed to mute system output for recording: {}", error);
                self.emit_pipeline_error_message(
                    generation,
                    format!("System audio mute failed: {error}"),
                );
            }
        }
    }

    fn restore_system_audio_mute(&self) -> Option<String> {
        let guard = self
            .system_audio_mute_guard
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();

        if let Some(guard) = guard {
            if let Err(error) = guard.restore() {
                tracing::warn!("Failed to restore system output mute state: {}", error);
                return Some(format!("System audio restore failed: {error}"));
            }
        }
        None
    }

    fn clear_preloaded_recording_context(&self) {
        *self
            .preloaded_config
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .preloaded_cloud_policy
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .preloaded_app_ctx
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .preloaded_dictionary
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.proxy_audio_buffer
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn setup_was_cancelled(&self, generation: u64) -> bool {
        let generation_active =
            is_active_generation(&self.abort_flag, &self.active_generation, generation);
        let onboarding_active = self.app_handle.state::<OnboardingGuard>().is_active();
        if generation_active && !onboarding_active {
            return false;
        }
        if onboarding_active {
            self.abort();
        }
        self.clear_preloaded_recording_context();
        true
    }

    pub fn current_state(&self) -> PipelineState {
        PipelineState::from_u8(self.state.load(Ordering::SeqCst))
    }

    /// Immediately abort the pipeline regardless of current state.
    /// Stops audio capture, forces state to Idle, and signals any
    /// ongoing stop() to exit early via abort_flag.
    pub fn abort(&self) -> bool {
        self.abort_for_generation(None, None)
    }

    fn fail_audio_capture_for_generation(
        &self,
        generation: u64,
        fault: &AudioCaptureFault,
    ) -> bool {
        self.abort_for_generation(
            Some(generation),
            Some(audio_capture_fault_user_error(fault)),
        )
    }

    fn abort_for_generation(
        &self,
        expected_generation: Option<u64>,
        user_error: Option<crate::error::UserError>,
    ) -> bool {
        let _commit_guard = self
            .transition_commit_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !matches_expected_generation(
            expected_generation,
            &self.abort_flag,
            &self.active_generation,
        ) {
            return false;
        }
        if !try_begin_abort_transition(&self.state, &self.abort_in_progress) {
            return false;
        }
        tracing::info!(
            "Pipeline abort requested (current state: {:?})",
            self.current_state()
        );
        if let Some(error) = user_error {
            let _ = self.app_handle.emit("pipeline:error", error);
        }

        // Set abort flag so any running stop() exits early
        self.abort_flag.store(true, Ordering::SeqCst);
        self.active_generation.fetch_add(1, Ordering::SeqCst);
        self.active_stt_session_id.fetch_add(1, Ordering::SeqCst);

        // Stop audio capture (closes channel -> STT task terminates naturally)
        {
            let mut handle = self.audio_handle.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(ref mut h) = *handle {
                let _ = h.stop();
            }
            *handle = None;
        }
        if let Some(error) = self.restore_system_audio_mute() {
            let _ = self.app_handle.emit("pipeline:error", error);
        }
        if let Some(control) = self
            .stt_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            control.abort.notify_one();
            control.done.notify_one();
        }

        // Clear accumulated text
        self.accumulated_text
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.clear_preloaded_recording_context();
        *self.stt_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.recording_start
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();

        // Force state to Idle - emits pipeline:state event to sync frontend
        self.set_state(PipelineState::Idle);
        self.abort_in_progress.store(false, Ordering::SeqCst);
        true
    }

    fn clear_stt_session(&self, session_id: u64) {
        let mut session = self.stt_session.lock().unwrap_or_else(|e| e.into_inner());
        if session.as_ref().map(|control| control.id) == Some(session_id) {
            *session = None;
        }
    }

    /// Capture selected text from the foreground app by simulating Ctrl+C / Cmd+C.
    /// Must be called when no hotkey modifier keys are physically held down.
    /// Called from async context via block_in_place, so std::thread::sleep is acceptable.
    fn capture_selected_text(&self) -> Option<String> {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        let backup = clipboard.get_text().ok();
        let sentinel = clipboard_copy_sentinel();
        let _ = clipboard.set_text(&sentinel);

        if !copy_selected_text_to_clipboard() {
            tracing::debug!("Selected text copy shortcut could not be sent");
        }

        std::thread::sleep(std::time::Duration::from_millis(CLIPBOARD_COPY_SETTLE_MS));

        let selected = clipboard.get_text().ok();

        // Always restore clipboard
        if let Some(ref b) = backup {
            let _ = clipboard.set_text(b);
        } else {
            let _ = clipboard.set_text("");
        }

        tracing::info!(
            "Selected text capture: backup_len={}, selected_len={}",
            backup.as_deref().map(|s| s.len()).unwrap_or(0),
            selected.as_deref().map(|s| s.len()).unwrap_or(0)
        );

        // If Ctrl/Cmd+C had no effect, the clipboard still contains our sentinel.
        // Ignore it so stale clipboard content is not treated as selected text.
        let result = selected_text_from_clipboard_result(selected, &sentinel);
        if result.is_none() {
            tracing::debug!("Selected text capture did not produce fresh clipboard text");
        }
        result
    }

    async fn load_config(&self) -> Result<storage::AppConfig> {
        // Config source is a privacy boundary. A recording started from the hotkey or tray must
        // not observe the old side of an in-flight local/backend mode transaction.
        let mutation_lock = self.app_handle.state::<storage::ConfigMutationLock>();
        let _mutation_guard = mutation_lock.0.lock().await;
        self.app_handle
            .state::<storage::ConfigManager>()
            .load()
            .await
    }

    pub async fn start(&self) -> Result<bool> {
        self.start_if(|| true).await
    }

    pub async fn toggle(&self) -> Result<bool> {
        let _guard = self.toggle_lock.lock().await;
        if self.current_state() == PipelineState::Idle {
            self.start().await
        } else {
            self.stop().await
        }
    }

    pub async fn start_if(&self, should_start: impl FnOnce() -> bool + Send) -> Result<bool> {
        let _in_flight_guard = PipelineInFlightGuard::enter(&self.in_flight_operations);
        // Hold pipeline_lock for the entire setup so stop() cannot read
        // partially-initialised state (preloaded_config, audio_handle, etc.).
        let Some(_guard) = lock_pipeline_if(&self.pipeline_lock, should_start).await else {
            return Ok(false);
        };

        let onboarding_guard = self.app_handle.state::<OnboardingGuard>();
        let generation = onboarding_guard
            .run_if_inactive(|| {
                let _commit_guard = self
                    .transition_commit_guard
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                // Claim the native owner now so abort/stop can invalidate this generation while
                // provider or microphone setup is in flight. Do not emit Recording until the
                // worker has built its stream and delivered a real callback frame.
                if !try_pipeline_transition(
                    &self.state,
                    PipelineState::Idle,
                    PipelineState::Recording,
                ) {
                    return None;
                }
                let generation = self.active_generation.fetch_add(1, Ordering::SeqCst) + 1;
                self.abort_flag.store(false, Ordering::SeqCst);
                Some(generation)
            })
            .flatten();
        let Some(generation) = generation else {
            return Ok(false);
        };

        // Clear accumulated text
        self.accumulated_text
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.stt_error.lock().unwrap_or_else(|e| e.into_inner()) = None;

        // P0-2: Load config BEFORE starting audio capture - fail fast on missing API key
        let config_data = match self.load_config().await {
            Ok(config) => config,
            Err(error) => {
                if self.setup_was_cancelled(generation) {
                    return Ok(false);
                }
                tracing::error!("Recording configuration load failed: {error}");
                self.clear_preloaded_recording_context();
                self.with_active_generation(generation, || {
                    let _ = self
                        .app_handle
                        .emit("pipeline:error", config_load_user_error(error.to_string()));
                    self.set_state(PipelineState::Idle);
                });
                return Ok(true);
            }
        };
        if self.setup_was_cancelled(generation) {
            return Ok(false);
        }
        if storage::cloud_policy_force_update(&self.app_handle) {
            let _ = self.app_handle.emit(
                "pipeline:error",
                "A required EcholIKE update is available. Please update before recording.",
            );
            self.set_state(PipelineState::Idle);
            return Ok(true);
        }
        let cloud_policy =
            match backend_stt_policy(load_cloud_proxy_policy(&self.app_handle, &config_data)) {
                Ok(policy) => policy,
                Err(code) => {
                    let error = crate::error::UserError {
                        code: code.to_string(),
                        details: None,
                        retry_count: 0,
                    };
                    let _ = self.app_handle.emit("pipeline:error", error);
                    self.set_state(PipelineState::Idle);
                    return Ok(true);
                }
            };
        let use_stt_proxy = cloud_policy.is_some();
        *self
            .preloaded_cloud_policy
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = cloud_policy.clone();
        self.proxy_audio_buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self
            .preloaded_config
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(config_data.clone());
        *self
            .preloaded_app_ctx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(app_detector::detect_current_app());
        let dict_words = self
            .app_handle
            .state::<storage::DictionaryStore>()
            .words()
            .await;
        if self.setup_was_cancelled(generation) {
            return Ok(false);
        }
        *self
            .preloaded_dictionary
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(dict_words);

        tracing::debug!(
            "Pipeline using config: stt_provider={}, stt_key_len={}, stt_lang={}",
            config_data.stt_provider,
            config_data.stt_api_key.len(),
            config_data.stt_language
        );

        // Guard: empty API key - bail before starting audio when provider requires one.
        if !use_stt_proxy
            && stt::config::stt_provider_requires_api_key(&config_data.stt_provider)
            && config_data.stt_api_key.is_empty()
        {
            let _ = self.app_handle.emit(
                "pipeline:error",
                "STT API key is not configured. Please set it in Settings -> Speech Recognition.",
            );
            *self
                .preloaded_config
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            *self
                .preloaded_app_ctx
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            *self
                .preloaded_dictionary
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = None;
            self.set_state(PipelineState::Idle);
            return Ok(true);
        }

        let mut provider = if use_stt_proxy {
            None
        } else {
            let custom_whisper_config =
                if config_data.stt_provider == stt::config::CUSTOM_WHISPER_PROVIDER {
                    match stt::config::build_custom_whisper_config(
                        &config_data.stt_custom_base_url,
                        &config_data.stt_custom_model,
                    ) {
                        Ok(cfg) => Some(cfg),
                        Err(e) => {
                            let _ = self.app_handle.emit("pipeline:error", e);
                            *self
                                .preloaded_config
                                .lock()
                                .unwrap_or_else(|e| e.into_inner()) = None;
                            *self
                                .preloaded_app_ctx
                                .lock()
                                .unwrap_or_else(|e| e.into_inner()) = None;
                            *self
                                .preloaded_dictionary
                                .lock()
                                .unwrap_or_else(|e| e.into_inner()) = None;
                            self.set_state(PipelineState::Idle);
                            return Ok(true);
                        }
                    }
                } else {
                    None
                };

            let stt_api_key = if config_data.stt_provider == stt::config::CUSTOM_WHISPER_PROVIDER {
                config_data.stt_custom_api_key.clone()
            } else {
                config_data.stt_api_key.clone()
            };

            let stt_config = SttConfig {
                api_key: stt_api_key,
                language: if config_data.stt_language == "multi" {
                    None
                } else {
                    Some(config_data.stt_language.clone())
                },
                smart_format: true,
                sample_rate: 16000,
                local_base_url: if config_data.stt_provider == stt::config::SENSEVOICE_PROVIDER {
                    Some(config_data.stt_custom_base_url.clone())
                } else {
                    None
                },
            };

            let stt_client = match self.network_client.client() {
                Ok(client) => client,
                Err(error) => {
                    tracing::error!("HTTP client is not available: {}", error);
                    let _ = self.app_handle.emit("pipeline:error", error);
                    *self
                        .preloaded_config
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    *self
                        .preloaded_app_ctx
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    *self
                        .preloaded_dictionary
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    self.set_state(PipelineState::Idle);
                    return Ok(true);
                }
            };

            let mut provider = match stt::create_provider(
                &config_data.stt_provider,
                custom_whisper_config,
                Some(stt_client),
            ) {
                Ok(provider) => provider,
                Err(e) => {
                    tracing::error!("STT provider creation failed: {}", e);
                    let _ = self
                        .app_handle
                        .emit("pipeline:error", format!("STT configuration failed: {e}"));
                    *self
                        .preloaded_config
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    *self
                        .preloaded_app_ctx
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    *self
                        .preloaded_dictionary
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = None;
                    self.set_state(PipelineState::Idle);
                    return Ok(true);
                }
            };
            if self.setup_was_cancelled(generation) {
                return Ok(false);
            }
            let connect_result = provider.connect(&stt_config).await;
            if self.setup_was_cancelled(generation) {
                return Ok(false);
            }
            if let Err(e) = connect_result {
                tracing::error!("STT connect failed: {}", e);
                let _ = self
                    .app_handle
                    .emit("pipeline:error", format!("STT connection failed: {e}"));
                *self
                    .preloaded_config
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                *self
                    .preloaded_app_ctx
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                *self
                    .preloaded_dictionary
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                self.set_state(PipelineState::Idle);
                return Ok(true);
            }
            Some(provider)
        };

        // Start audio capture on dedicated thread
        if self.setup_was_cancelled(generation) {
            return Ok(false);
        }
        let onboarding_guard = self.app_handle.state::<OnboardingGuard>();
        if onboarding_guard.run_if_inactive(|| ()).is_none() {
            self.clear_preloaded_recording_context();
            return Ok(false);
        }
        self.mute_system_audio_for_recording(&config_data, generation);
        let (handle, mut audio_rx) = match AudioCaptureHandle::start(AudioConfig::default()).await {
            Ok(started) => started,
            Err(e) => {
                tracing::error!("Audio capture failed: {}", e);
                let code = if e.downcast_ref::<AudioCaptureStartupTimeout>().is_some() {
                    "audio_no_frames"
                } else {
                    "audio_failed"
                };
                self.with_active_generation(generation, || {
                    let _ = self.app_handle.emit(
                        "pipeline:error",
                        audio_user_error(code, Some(e.to_string())),
                    );
                });
                self.clear_preloaded_recording_context();
                if let Some(error) = self.restore_system_audio_mute() {
                    self.emit_pipeline_error_message(generation, error);
                }
                self.set_state(PipelineState::Idle);
                return Ok(true);
            }
        };

        let session_id = self.active_stt_session_id.fetch_add(1, Ordering::SeqCst) + 1;
        let stt_control = SttTaskControl {
            id: session_id,
            done: Arc::new(Notify::new()),
            abort: Arc::new(Notify::new()),
            finalize: Arc::new(Notify::new()),
        };
        let max_recording_seconds =
            effective_max_recording_seconds(config_data.max_recording_seconds);
        let mut pending_handle = Some(handle);
        let committed = onboarding_guard
            .run_if_inactive(|| {
                let _commit_guard = self
                    .transition_commit_guard
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if !is_active_generation(&self.abort_flag, &self.active_generation, generation)
                    || self.current_state() != PipelineState::Recording
                {
                    return false;
                }
                *self.audio_handle.lock().unwrap_or_else(|e| e.into_inner()) =
                    pending_handle.take();
                *self
                    .recording_start
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
                *self.stt_session.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(stt_control.clone());
                self.set_state(PipelineState::Recording);
                true
            })
            .unwrap_or(false);
        if !committed {
            if let Some(mut handle) = pending_handle {
                let _ = handle.stop();
            }
            self.clear_preloaded_recording_context();
            if let Some(error) = self.restore_system_audio_mute() {
                self.emit_pipeline_error_message(generation, error);
            }
            return Ok(false);
        }
        if self.setup_was_cancelled(generation) {
            return Ok(false);
        }

        // Volume monitoring task
        let app_handle = self.app_handle.clone();
        let audio_handle_ref = self.audio_handle.clone();
        let state_ref = self.state.clone();
        let volume_abort_flag = self.abort_flag.clone();
        let volume_active_generation = self.active_generation.clone();
        let volume_commit_guard = self.transition_commit_guard.clone();
        tokio::spawn(async move {
            let mut displayed_level = 0.0;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(VOLUME_POLL_INTERVAL_MS)).await;
                let current = PipelineState::from_u8(state_ref.load(Ordering::SeqCst));
                if current != PipelineState::Recording {
                    break;
                }
                let measurement = commit_generation_effect(
                    &volume_commit_guard,
                    &volume_abort_flag,
                    &volume_active_generation,
                    generation,
                    || {
                        (PipelineState::from_u8(state_ref.load(Ordering::SeqCst))
                            == PipelineState::Recording)
                            .then(|| {
                                audio_handle_ref
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .as_ref()
                                    .map(|handle| (handle.take_meter_level(), handle.fault()))
                                    .unwrap_or((0.0, None))
                            })
                    },
                )
                .flatten();
                let Some((vol, fault)) = measurement else {
                    break;
                };
                if let Some(fault) = fault {
                    let pipeline = app_handle.state::<PipelineHandle>();
                    pipeline.fail_audio_capture_for_generation(generation, &fault);
                    break;
                }
                displayed_level = next_meter_envelope(displayed_level, vol);
                let emitted = commit_generation_effect(
                    &volume_commit_guard,
                    &volume_abort_flag,
                    &volume_active_generation,
                    generation,
                    || {
                        if PipelineState::from_u8(state_ref.load(Ordering::SeqCst))
                            != PipelineState::Recording
                        {
                            return false;
                        }
                        let _ = app_handle.emit("audio:volume", displayed_level);
                        true
                    },
                );
                if emitted != Some(true) {
                    break;
                }
            }
        });

        // STT streaming task - provider is already connected
        let app_handle = self.app_handle.clone();
        let accumulated = self.accumulated_text.clone();
        let abort_flag_ref = self.abort_flag.clone();
        let active_session_id_ref = self.active_stt_session_id.clone();
        let active_generation_ref = self.active_generation.clone();
        let transition_commit_guard_ref = self.transition_commit_guard.clone();
        let stt_error_ref = self.stt_error.clone();
        let proxy_audio_buffer = self.proxy_audio_buffer.clone();
        let stt_in_flight_guard = PipelineInFlightGuard::enter(&self.in_flight_operations);

        let auto_stop_app_handle = self.app_handle.clone();
        let auto_stop_state = self.state.clone();
        let auto_stop_active_session_id = self.active_stt_session_id.clone();
        let auto_stop_abort_flag = self.abort_flag.clone();
        let auto_stop_active_generation = self.active_generation.clone();
        let auto_stop_commit_guard = self.transition_commit_guard.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(max_recording_seconds)).await;
            let still_recording = PipelineState::from_u8(auto_stop_state.load(Ordering::SeqCst))
                == PipelineState::Recording;
            let same_session = auto_stop_active_session_id.load(Ordering::SeqCst) == session_id;
            if still_recording && same_session {
                tracing::info!(
                    "Max recording duration reached after {}s; stopping pipeline",
                    max_recording_seconds
                );
                let pipeline = auto_stop_app_handle.state::<PipelineHandle>();
                if let Err(error) = pipeline.stop_for_generation(Some(generation)).await {
                    tracing::error!("Auto-stop recording failed: {}", error);
                    commit_generation_effect(
                        &auto_stop_commit_guard,
                        &auto_stop_abort_flag,
                        &auto_stop_active_generation,
                        generation,
                        || {
                            let _ = auto_stop_app_handle.emit(
                                "pipeline:error",
                                format!("Auto-stop recording failed: {error}"),
                            );
                        },
                    );
                }
            }
        });

        tokio::spawn(async move {
            let stt_in_flight_guard = stt_in_flight_guard;
            if provider.is_none() {
                loop {
                    if !should_finalize_stt_task(
                        abort_flag_ref.as_ref(),
                        active_session_id_ref.as_ref(),
                        stt_control.id,
                    ) {
                        break;
                    }

                    tokio::select! {
                        _ = stt_control.abort.notified() => {
                            tracing::info!("Proxy STT collector received abort signal");
                            break;
                        }
                        chunk = audio_rx.recv() => {
                            match chunk {
                                Some(data) => {
                                    commit_generation_effect(
                                        &transition_commit_guard_ref,
                                        &abort_flag_ref,
                                        &active_generation_ref,
                                        generation,
                                        || {
                                            proxy_audio_buffer
                                                .lock()
                                                .unwrap_or_else(|e| e.into_inner())
                                                .extend_from_slice(&data);
                                        },
                                    );
                                }
                                None => break,
                            }
                        }
                    }
                }
                drop(stt_in_flight_guard);
                stt_control.done.notify_one();
                return;
            }
            let mut provider = provider.take().expect("provider checked above");
            // Forward audio to STT and receive transcripts
            loop {
                if !should_finalize_stt_task(
                    abort_flag_ref.as_ref(),
                    active_session_id_ref.as_ref(),
                    stt_control.id,
                ) {
                    break;
                }

                tokio::select! {
                    _ = stt_control.abort.notified() => {
                        tracing::info!("STT task received abort signal");
                        break;
                    }
                    chunk = audio_rx.recv() => {
                        match chunk {
                            Some(data) => {
                                let delivery_result = tokio::select! {
                                    _ = stt_control.abort.notified() => {
                                        tracing::info!("STT audio delivery received abort signal");
                                        break;
                                    }
                                    result = provider.send_audio(&data) => result,
                                };
                                if let Err(error) = delivery_result {
                                    tracing::error!("STT audio delivery error: {}", error);
                                    let user_error = error.to_user_error();
                                    let latched = commit_generation_effect(
                                        &transition_commit_guard_ref,
                                        &abort_flag_ref,
                                        &active_generation_ref,
                                        generation,
                                        || {
                                            if should_finalize_stt_task(
                                                abort_flag_ref.as_ref(),
                                                active_session_id_ref.as_ref(),
                                                stt_control.id,
                                            ) {
                                                *stt_error_ref.lock().unwrap_or_else(|e| e.into_inner()) =
                                                    Some((stt_control.id, user_error.clone()));
                                                true
                                            } else {
                                                false
                                            }
                                        },
                                    )
                                    .unwrap_or(false);
                                    if latched {
                                        app_handle
                                            .state::<PipelineHandle>()
                                            .abort_for_generation(
                                                Some(generation),
                                                Some(user_error),
                                            );
                                    }
                                    break;
                                }
                            }
                            None => {
                                // stop() first joins the capture worker and validates its immutable
                                // stats. Only an explicit finalize permit may let a file provider
                                // use the buffered audio; faults and silence take the abort branch.
                                if !should_finalize_stt_task(
                                    abort_flag_ref.as_ref(),
                                    active_session_id_ref.as_ref(),
                                    stt_control.id,
                                ) {
                                    break;
                                }

                                let finalize = wait_for_stt_finalize_permission(&stt_control).await;
                                if !finalize || !should_finalize_stt_task(
                                    abort_flag_ref.as_ref(),
                                    active_session_id_ref.as_ref(),
                                    stt_control.id,
                                ) {
                                    break;
                                }

                                let disconnect_result = tokio::select! {
                                    _ = stt_control.abort.notified() => None,
                                    result = provider.disconnect() => Some(result),
                                };

                                match disconnect_result {
                                    Some(Ok(Some(text))) => {
                                        commit_generation_effect(
                                            &transition_commit_guard_ref,
                                            &abort_flag_ref,
                                            &active_generation_ref,
                                            generation,
                                            || {
                                                if should_finalize_stt_task(
                                                    abort_flag_ref.as_ref(),
                                                    active_session_id_ref.as_ref(),
                                                    stt_control.id,
                                                ) {
                                                    let mut acc = accumulated.lock().unwrap_or_else(|e| e.into_inner());
                                                    acc.push_str(&text);
                                                    let current = acc.clone();
                                                    drop(acc);
                                                    let _ = app_handle.emit("stt:final", &current);
                                                }
                                            },
                                        );
                                    }
                                    Some(Ok(None)) => {}
                                    Some(Err(e)) => {
                                        tracing::error!("STT disconnect error: {}", e);
                                        commit_generation_effect(
                                            &transition_commit_guard_ref,
                                            &abort_flag_ref,
                                            &active_generation_ref,
                                            generation,
                                            || {
                                                if should_finalize_stt_task(
                                                    abort_flag_ref.as_ref(),
                                                    active_session_id_ref.as_ref(),
                                                    stt_control.id,
                                                ) {
                                                    let user_error = e.to_user_error();
                                                    *stt_error_ref.lock().unwrap_or_else(|e| e.into_inner()) =
                                                        Some((stt_control.id, user_error.clone()));
                                                    let _ = app_handle.emit("pipeline:error", user_error);
                                                }
                                            },
                                        );
                                    }
                                    None => {}
                                }
                                break;
                            }
                        }
                    }
                    transcript = provider.recv_transcript() => {
                        match transcript {
                            Ok(Some(TranscriptEvent::Partial { text })) => {
                                commit_generation_effect(
                                    &transition_commit_guard_ref,
                                    &abort_flag_ref,
                                    &active_generation_ref,
                                    generation,
                                    || {
                                        if should_finalize_stt_task(
                                            abort_flag_ref.as_ref(),
                                            active_session_id_ref.as_ref(),
                                            stt_control.id,
                                        ) {
                                            let _ = app_handle.emit("stt:partial", &text);
                                        }
                                    },
                                );
                            }
                            Ok(Some(TranscriptEvent::Final { text, .. })) => {
                                commit_generation_effect(
                                    &transition_commit_guard_ref,
                                    &abort_flag_ref,
                                    &active_generation_ref,
                                    generation,
                                    || {
                                        if should_finalize_stt_task(
                                            abort_flag_ref.as_ref(),
                                            active_session_id_ref.as_ref(),
                                            stt_control.id,
                                        ) {
                                            let mut acc = accumulated.lock().unwrap_or_else(|e| e.into_inner());
                                            acc.push_str(&text);
                                            acc.push(' ');
                                            let current = acc.clone();
                                            drop(acc);
                                            let _ = app_handle.emit("stt:final", &current);
                                        }
                                    },
                                );
                            }
                            Ok(Some(TranscriptEvent::Error { message })) => {
                                tracing::error!("STT error: {}", message);
                                let user_error =
                                    crate::error::AppError::Config(message.clone()).to_user_error();
                                let latched = commit_generation_effect(
                                    &transition_commit_guard_ref,
                                    &abort_flag_ref,
                                    &active_generation_ref,
                                    generation,
                                    || {
                                        if should_finalize_stt_task(
                                            abort_flag_ref.as_ref(),
                                            active_session_id_ref.as_ref(),
                                            stt_control.id,
                                        ) {
                                            *stt_error_ref.lock().unwrap_or_else(|e| e.into_inner()) =
                                                Some((stt_control.id, user_error.clone()));
                                            true
                                        } else {
                                            false
                                        }
                                    },
                                )
                                .unwrap_or(false);
                                if latched {
                                    app_handle
                                        .state::<PipelineHandle>()
                                        .abort_for_generation(Some(generation), Some(user_error));
                                }
                                // Break out of the loop - STT has failed, no point
                                // continuing. Without break, the loop keeps running
                                // and the pipeline stays stuck in Recording forever.
                                break;
                            }
                            Err(e) => {
                                tracing::error!("STT recv error: {}", e);
                                let user_error = e.to_user_error();
                                let latched = commit_generation_effect(
                                    &transition_commit_guard_ref,
                                    &abort_flag_ref,
                                    &active_generation_ref,
                                    generation,
                                    || {
                                        if should_finalize_stt_task(
                                            abort_flag_ref.as_ref(),
                                            active_session_id_ref.as_ref(),
                                            stt_control.id,
                                        ) {
                                            *stt_error_ref.lock().unwrap_or_else(|e| e.into_inner()) =
                                                Some((stt_control.id, user_error.clone()));
                                            true
                                        } else {
                                            false
                                        }
                                    },
                                )
                                .unwrap_or(false);
                                if latched {
                                    app_handle
                                        .state::<PipelineHandle>()
                                        .abort_for_generation(Some(generation), Some(user_error));
                                }
                                break;
                            }
                            _ => {}
                        }
                    }
                }
            }

            // Signal that STT processing is complete
            drop(stt_in_flight_guard);
            stt_control.done.notify_one();
        });

        Ok(true)
    }

    pub async fn stop(&self) -> Result<bool> {
        self.stop_for_generation(None).await
    }

    pub async fn stop_if(&self, should_stop: impl FnOnce() -> bool + Send) -> Result<bool> {
        self.stop_for_generation_if(None, should_stop).await
    }

    async fn stop_for_generation(&self, expected_generation: Option<u64>) -> Result<bool> {
        self.stop_for_generation_if(expected_generation, || true)
            .await
    }

    async fn stop_for_generation_if(
        &self,
        expected_generation: Option<u64>,
        should_stop: impl FnOnce() -> bool + Send,
    ) -> Result<bool> {
        let _in_flight_guard = PipelineInFlightGuard::enter(&self.in_flight_operations);
        // Acquire pipeline_lock so we wait for start() to finish its setup
        // (load_config, connect STT, start audio) before reading shared state.
        // Released before the long stt_done wait so start() isn't blocked 120s.
        let Some(guard) = lock_pipeline_if(&self.pipeline_lock, should_stop).await else {
            return Ok(false);
        };
        let transition_guard = self
            .transition_commit_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !matches_expected_generation(
            expected_generation,
            &self.abort_flag,
            &self.active_generation,
        ) {
            return Ok(false);
        }

        // Atomic CAS: only one caller can transition Recording -> Transcribing
        if !try_pipeline_transition(
            &self.state,
            PipelineState::Recording,
            PipelineState::Transcribing,
        ) {
            return Ok(false);
        }
        let generation = self.active_generation.load(Ordering::SeqCst);
        self.set_state(PipelineState::Transcribing);
        drop(transition_guard);

        let stop_start = std::time::Instant::now();
        let preloaded_config = self
            .preloaded_config
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some(config) = preloaded_config else {
            self.abort_for_generation(
                Some(generation),
                Some(config_load_user_error(
                    "recording configuration snapshot was missing at stop".to_string(),
                )),
            );
            return Ok(true);
        };

        // Capture selected text now - hotkey is released so Ctrl+C won't conflict.
        // Small delay to ensure hotkey modifiers are fully released (especially in toggle mode).
        let selected_text = if config.selected_text_enabled {
            tokio::time::sleep(std::time::Duration::from_millis(
                SELECTED_TEXT_CAPTURE_DELAY_MS,
            ))
            .await;
            let captured = commit_generation_effect(
                &self.transition_commit_guard,
                &self.abort_flag,
                &self.active_generation,
                generation,
                || tokio::task::block_in_place(|| self.capture_selected_text()),
            );
            let Some(captured) = captured else {
                return Ok(true);
            };
            captured
        } else {
            None
        };
        tracing::info!(
            "Selected text result: len={}",
            selected_text.as_deref().map(|s| s.len()).unwrap_or(0)
        );
        // Stop audio capture (this drops the channel, signaling STT task to stop)
        let mut stopped_handle = self
            .audio_handle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let capture_stats = stopped_handle.as_mut().map(AudioCaptureHandle::stop);
        if let Some(error) = self.restore_system_audio_mute() {
            self.emit_pipeline_error_message(generation, error);
        }
        if let Some(error) = audio_capture_completion_error(capture_stats.as_ref()) {
            tracing::warn!(
                input_frames = capture_stats.as_ref().map_or(0, |stats| stats.input_frames),
                pcm_bytes = capture_stats
                    .as_ref()
                    .map_or(0, |stats| stats.pcm_bytes_delivered),
                peak = capture_stats
                    .as_ref()
                    .map_or(0, |stats| stats.peak_amplitude),
                "Recording ended without valid microphone audio"
            );
            self.abort_for_generation(Some(generation), Some(error));
            return Ok(true);
        }
        let stt_control = self
            .stt_session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(control) = &stt_control {
            control.finalize.notify_one();
        }

        // P2-1: Pre-build LLM resources while waiting for STT
        let app_ctx = self
            .preloaded_app_ctx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or_else(app_detector::detect_current_app);
        let dictionary_words = self
            .preloaded_dictionary
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or_default();
        let cloud_policy = self
            .preloaded_cloud_policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let use_stt_proxy = cloud_policy.as_ref().is_some_and(|policy| policy.stt_proxy);

        // All shared state has been taken - release the lock so a new start()
        // isn't blocked by the long stt_done wait that follows.
        drop(guard);

        // -- Phase 1: Wait for STT --------------------------------------
        let mut stt_operation_id = None;
        let raw_text = if use_stt_proxy {
            if let Some(control) = &stt_control {
                let completed = wait_for_stt_completion(
                    control,
                    std::time::Duration::from_secs(STT_FINALIZE_TIMEOUT_SECS),
                )
                .await;
                if !completed {
                    tracing::warn!(
                        "Proxy STT collector timed out after {}s",
                        STT_FINALIZE_TIMEOUT_SECS
                    );
                    self.abort_for_generation(Some(generation), Some(stt_timeout_user_error()));
                    return Ok(true);
                }
            }
            let pcm = commit_generation_effect(
                &self.transition_commit_guard,
                &self.abort_flag,
                &self.active_generation,
                generation,
                || {
                    let mut buffer = self
                        .proxy_audio_buffer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    std::mem::take(&mut *buffer)
                },
            );
            let Some(pcm) = pcm else {
                return Ok(true);
            };
            let stt_policy = cloud_policy
                .as_ref()
                .expect("cloud policy checked for proxy STT");
            match self
                .transcribe_text_via_proxy(stt_policy, &config, pcm, generation)
                .await
            {
                Ok((text, operation_id)) => {
                    stt_operation_id = Some(operation_id);
                    text
                }
                Err(error) => {
                    tracing::error!("Proxy STT failed: {}", error);
                    let structured_code =
                        error
                            .downcast_ref::<BackendSttUserError>()
                            .map(|user_error| {
                                if user_error.0 == "backend_auth_expired" {
                                    self.invalidate_rejected_backend_authority(stt_policy)
                                } else {
                                    user_error.0
                                }
                            });
                    self.with_active_generation(generation, || {
                        if let Some(code) = structured_code {
                            let _ = self.app_handle.emit(
                                "pipeline:error",
                                crate::error::UserError {
                                    code: code.to_string(),
                                    details: None,
                                    retry_count: 0,
                                },
                            );
                        } else {
                            let _ = self
                                .app_handle
                                .emit("pipeline:error", format!("Cloud STT failed: {error}"));
                        }
                    });
                    if let Some(control) = &stt_control {
                        self.clear_stt_session(control.id);
                    }
                    self.with_active_generation(generation, || {
                        self.set_state(PipelineState::Idle);
                    });
                    return Ok(true);
                }
            }
        } else {
            match self.wait_for_stt(stt_control.clone(), generation).await? {
                Some(text) => text,
                None => {
                    if let Some(control) = &stt_control {
                        self.clear_stt_session(control.id);
                    }
                    return Ok(true);
                }
            }
        };
        let stt_elapsed = stop_start.elapsed();
        tracing::info!(
            "[Pipeline Timing] STT finalize: {}ms",
            stt_elapsed.as_millis()
        );

        // Check abort before entering LLM polish and output
        if !is_active_generation(&self.abort_flag, &self.active_generation, generation) {
            tracing::info!("Pipeline aborted before LLM/output");
            if let Some(control) = &stt_control {
                self.clear_stt_session(control.id);
            }
            return Ok(true);
        }

        // -- Phase 2: LLM polish + output -------------------------------
        let (final_text, llm_elapsed, llm_operation_id) = self
            .polish_text(
                &raw_text,
                &config,
                &app_ctx,
                dictionary_words,
                selected_text,
                cloud_policy.as_ref(),
                generation,
            )
            .await;

        if !is_active_generation(&self.abort_flag, &self.active_generation, generation) {
            return Ok(true);
        }
        let _commit_guard = self
            .transition_commit_guard
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !is_active_generation(&self.abort_flag, &self.active_generation, generation) {
            return Ok(true);
        }
        // -- Phase 3: Timing, history, cleanup --------------------------
        let total_elapsed = stop_start.elapsed();

        // Compute recording duration
        let duration_ms = self
            .recording_start
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|start| start.elapsed().as_millis() as i64);

        tracing::info!(
            "[Pipeline Timing] Total stop(): {}ms (STT: {}ms, LLM: {}ms, Output+Save: {}ms)",
            total_elapsed.as_millis(),
            stt_elapsed.as_millis(),
            llm_elapsed.as_millis(),
            total_elapsed.as_millis() - stt_elapsed.as_millis() - llm_elapsed.as_millis(),
        );

        // Emit timing to frontend
        let _ = self.app_handle.emit(
            "pipeline:timing",
            serde_json::json!({
                "stt_ms": stt_elapsed.as_millis() as u64,
                "llm_ms": llm_elapsed.as_millis() as u64,
                "total_ms": total_elapsed.as_millis() as u64,
                "recording_ms": duration_ms,
            }),
        );

        // Save to history
        if self.save_history(&raw_text, &final_text, &app_ctx, duration_ms) {
            if let Some(operation_id) = stt_operation_id {
                if let Err(error) = self.idempotency_registry.acknowledge(&operation_id) {
                    tracing::warn!(error, "Cloud STT result remains pending after history save");
                }
            }
            if let Some(operation_id) = llm_operation_id {
                if let Err(error) = self.idempotency_registry.acknowledge(&operation_id) {
                    tracing::warn!(error, "Cloud LLM result remains pending after history save");
                }
            }
        }

        if let Some(control) = &stt_control {
            self.clear_stt_session(control.id);
        }
        self.set_state(PipelineState::Idle);
        Ok(true)
    }

    /// Wait for the STT task to complete and return the transcribed text.
    /// Returns `Ok(Some(text))` on success, `Ok(None)` if aborted or no speech,
    /// or `Err` on failure.
    async fn wait_for_stt(
        &self,
        stt_control: Option<SttTaskControl>,
        generation: u64,
    ) -> Result<Option<String>> {
        if let Some(control) = &stt_control {
            let completed = wait_for_stt_completion(
                control,
                std::time::Duration::from_secs(STT_FINALIZE_TIMEOUT_SECS),
            )
            .await;
            if !completed {
                tracing::warn!("STT timed out after {}s", STT_FINALIZE_TIMEOUT_SECS);
                self.abort_for_generation(Some(generation), Some(stt_timeout_user_error()));
                return Ok(None);
            }
            tracing::debug!("STT task completed");

            if !should_finalize_stt_task(
                self.abort_flag.as_ref(),
                self.active_stt_session_id.as_ref(),
                control.id,
            ) {
                tracing::info!("Ignoring stale or aborted STT task");
                return Ok(None);
            }
            if take_matching_stt_error(&self.stt_error, control.id).is_some() {
                self.with_active_generation(generation, || {
                    self.set_state(PipelineState::Idle);
                });
                return Ok(None);
            }
        } else {
            tracing::warn!("No STT session was available to wait for");
        }

        let raw_text = commit_generation_effect(
            &self.transition_commit_guard,
            &self.abort_flag,
            &self.active_generation,
            generation,
            || {
                self.accumulated_text
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .trim()
                    .to_string()
            },
        );
        let Some(raw_text) = raw_text else {
            tracing::info!("Pipeline aborted after STT wait");
            return Ok(None);
        };

        if raw_text.is_empty() {
            self.with_active_generation(generation, || {
                let _ = self
                    .app_handle
                    .emit("pipeline:error", no_speech_user_error());
                self.set_state(PipelineState::Idle);
            });
            return Ok(None);
        }

        Ok(Some(raw_text))
    }

    /// Polish raw text with LLM and output the result.
    /// Returns (final_text, llm_elapsed_duration, pending_cloud_operation).
    async fn polish_text(
        &self,
        raw_text: &str,
        config: &storage::AppConfig,
        app_ctx: &app_detector::AppContext,
        dictionary_words: Vec<String>,
        selected_text: Option<String>,
        cloud_policy: Option<&CloudProxyPolicy>,
        generation: u64,
    ) -> (String, std::time::Duration, Option<String>) {
        // Check if polish is enabled and API key / token is available
        let should_polish = should_run_llm(config, selected_text.is_some());
        let backend_mode = uses_backend_config_source(config);
        let has_cloud_llm = backend_mode && cloud_policy.is_some_and(|policy| policy.llm_proxy);

        if !should_polish {
            // No polishing; output raw text directly.
            self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                .await;
            return (raw_text.to_string(), std::time::Duration::ZERO, None);
        }

        if backend_mode && !has_cloud_llm {
            self.with_active_generation(generation, || {
                let _ = self.app_handle.emit(
                    "pipeline:error",
                    "后台托管文本 AI 不可用，请先同步后台配置或切换到本机配置。",
                );
            });
            self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                .await;
            return (raw_text.to_string(), std::time::Duration::ZERO, None);
        }

        if !backend_mode && !has_llm_access(config) {
            self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                .await;
            return (raw_text.to_string(), std::time::Duration::ZERO, None);
        }

        if !self.with_active_generation(generation, || {
            self.set_state(PipelineState::Polishing);
        }) {
            return (raw_text.to_string(), std::time::Duration::ZERO, None);
        }
        let llm_start = std::time::Instant::now();

        if let Some(policy) = cloud_policy.filter(|policy| policy.llm_proxy) {
            let req = PolishRequest {
                raw_text: raw_text.to_string(),
                app_type: app_ctx.app_type,
                dictionary: dictionary_words.clone(),
                translate_enabled: config.translate_enabled,
                target_lang: config.target_lang.clone(),
                selected_text: selected_text.clone(),
            };

            match self.polish_text_via_proxy(policy, &req, generation).await {
                Ok((final_text, operation_id)) => {
                    if !is_active_generation(&self.abort_flag, &self.active_generation, generation)
                    {
                        return (raw_text.to_string(), llm_start.elapsed(), None);
                    }
                    let output_delivered = self
                        .output_text_and_report(&final_text, &app_ctx.app_name, config, generation)
                        .await;
                    return (
                        final_text,
                        llm_start.elapsed(),
                        completed_cloud_operation(operation_id, output_delivered),
                    );
                }
                Err(error) => {
                    tracing::warn!("Cloud LLM proxy failed in backend mode: {}", error);
                    self.emit_pipeline_error_message(
                        generation,
                        format!("Cloud LLM failed: {error}"),
                    );
                    self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                        .await;
                    return (raw_text.to_string(), llm_start.elapsed(), None);
                }
            }
        }

        let llm_config = LlmConfig {
            api_key: config.llm_api_key.clone(),
            model: config.llm_model.clone(),
            base_url: config.llm_base_url.clone(),
            max_tokens: 4096,
            temperature: 0.3,
        };
        let llm_client = match self.network_client.client() {
            Ok(client) => client,
            Err(error) => {
                tracing::error!("HTTP client is not available: {}", error);
                self.emit_pipeline_error_message(generation, error);
                self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                    .await;
                return (raw_text.to_string(), llm_start.elapsed(), None);
            }
        };
        let provider = llm::create_provider(&config.llm_provider, Some(llm_client));

        // on_chunk only drives the UI transcript display; actual output happens
        // in batch after the full response arrives (see output_text below).
        let app_handle = self.app_handle.clone();
        let active_generation = self.active_generation.clone();
        let abort_flag = self.abort_flag.clone();
        let transition_commit_guard = self.transition_commit_guard.clone();
        let on_chunk: llm::ChunkCallback = Box::new(move |chunk: &str| {
            commit_generation_effect(
                &transition_commit_guard,
                &abort_flag,
                &active_generation,
                generation,
                || {
                    let _ = app_handle.emit("llm:chunk", chunk);
                },
            );
        });

        let req = PolishRequest {
            raw_text: raw_text.to_string(),
            app_type: app_ctx.app_type,
            dictionary: dictionary_words,
            translate_enabled: config.translate_enabled,
            target_lang: config.target_lang.clone(),
            selected_text,
        };

        let (final_text, llm_elapsed) = match provider
            .polish(&llm_config, &req, Some(&on_chunk))
            .await
        {
            Ok(response) => {
                // Check abort after LLM returns - skip output if cancelled during polish
                if !is_active_generation(&self.abort_flag, &self.active_generation, generation) {
                    tracing::info!("Pipeline aborted after LLM polish, skipping output");
                    return (raw_text.to_string(), llm_start.elapsed(), None);
                }
                let elapsed = llm_start.elapsed();
                self.output_text_and_report(
                    &response.polished_text,
                    &app_ctx.app_name,
                    config,
                    generation,
                )
                .await;
                (response.polished_text, elapsed)
            }
            Err(e) => {
                // Check abort after LLM error - skip fallback output if cancelled
                if !is_active_generation(&self.abort_flag, &self.active_generation, generation) {
                    tracing::info!("Pipeline aborted after LLM error, skipping output");
                    return (raw_text.to_string(), llm_start.elapsed(), None);
                }
                tracing::error!("LLM polish failed: {}, outputting raw text", e);
                let elapsed = llm_start.elapsed();

                self.with_active_generation(generation, || {
                    let _ = self
                        .app_handle
                        .emit("pipeline:error", llm_polish_user_error(&e));
                });
                self.output_text_and_report(raw_text, &app_ctx.app_name, config, generation)
                    .await;
                (raw_text.to_string(), elapsed)
            }
        };

        tracing::info!(
            "[Pipeline Timing] LLM polish: {}ms",
            llm_elapsed.as_millis()
        );

        (final_text, llm_elapsed, None)
    }

    async fn transcribe_text_via_proxy(
        &self,
        policy: &CloudProxyPolicy,
        config: &storage::AppConfig,
        pcm_audio: Vec<u8>,
        generation: u64,
    ) -> Result<(String, String)> {
        if pcm_audio.is_empty() {
            anyhow::bail!("No audio was captured");
        }
        let wav = wav_from_pcm_16khz_mono(&pcm_audio);
        let language = (config.stt_language != "multi").then(|| config.stt_language.clone());

        let client = self
            .network_client
            .client()
            .map_err(|e| anyhow::anyhow!(e))?;
        let endpoint = proxy_endpoint(policy, "/proxy/stt");
        let language_fingerprint = language.as_deref().unwrap_or("multi");
        let persistent_operation = self
            .idempotency_registry
            .acquire_authenticated(
                "stt",
                &policy.api_base_url,
                &policy.auth_token,
                &[&wav, language_fingerprint.as_bytes()],
            )
            .map_err(anyhow::Error::msg)?;
        let response = crate::idempotency::execute_buffered_with_key(
            persistent_operation.root().to_string(),
            std::time::Duration::from_secs(90),
            std::time::Duration::from_secs(30),
            8 * 1024 * 1024,
            || {
                let part = reqwest::multipart::Part::bytes(wav.clone())
                    .file_name("audio.wav")
                    .mime_str("audio/wav")
                    .expect("static WAV MIME should be valid");
                let mut form = reqwest::multipart::Form::new().part("audio", part);
                if let Some(language) = &language {
                    form = form.text("language", language.clone());
                }
                client
                    .post(&endpoint)
                    .bearer_auth(&policy.auth_token)
                    .multipart(form)
            },
        )
        .await
        .map_err(anyhow::Error::msg)?;
        let status = response.status;
        let text = String::from_utf8(response.body)
            .map_err(|_| anyhow::anyhow!("Cloud STT returned non-UTF-8 data"))?;
        if !status.is_success() {
            if crate::idempotency::response_retires_operation(status, text.as_bytes()) {
                persistent_operation.retire().map_err(anyhow::Error::msg)?;
            }
            if let Some(code) = backend_stt_error_code(status, &text) {
                return Err(BackendSttUserError(code).into());
            }
            anyhow::bail!("HTTP {} {}", status.as_u16(), text);
        }
        let transcript = parse_proxy_stt_transcript(&text)?;
        self.with_active_generation(generation, || {
            let _ = self.app_handle.emit("stt:final", &transcript);
        });
        Ok((transcript, persistent_operation.root().to_string()))
    }

    async fn polish_text_via_proxy(
        &self,
        policy: &CloudProxyPolicy,
        req: &PolishRequest,
        generation: u64,
    ) -> Result<(String, String)> {
        let has_selected_text = req
            .selected_text
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty());
        let system_prompt = llm::prompt::build_system_prompt(
            req.app_type,
            &req.dictionary,
            req.translate_enabled,
            &req.target_lang,
            has_selected_text,
        );
        let mut messages = vec![serde_json::json!({
            "role": "system",
            "content": system_prompt,
        })];
        if let Some(selected_text) = req
            .selected_text
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("<selected_text>\n{}\n</selected_text>", selected_text),
            }));
        }
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("<transcription>\n{}\n</transcription>", req.raw_text),
        }));

        let client = self
            .network_client
            .client()
            .map_err(|e| anyhow::anyhow!(e))?;
        let endpoint = proxy_endpoint(policy, "/proxy/llm");
        let body = serde_json::json!({ "messages": messages, "stream": true });
        let semantic_body = serde_json::to_vec(&body)?;
        let persistent_operation = self
            .idempotency_registry
            .acquire_authenticated(
                "llm-stream",
                &policy.api_base_url,
                &policy.auth_token,
                &[&semantic_body],
            )
            .map_err(anyhow::Error::msg)?;
        let mut operation = crate::idempotency::Operation::with_key(
            persistent_operation.root().to_string(),
            std::time::Duration::from_secs(90),
            std::time::Duration::from_secs(30),
        )
        .map_err(anyhow::Error::msg)?;
        loop {
            let request = operation
                .prepare(
                    client
                        .post(&endpoint)
                        .bearer_auth(&policy.auth_token)
                        .json(&body),
                )
                .map_err(anyhow::Error::msg)?;
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    if operation.retry_transport(&error).await {
                        continue;
                    }
                    return Err(error.into());
                }
            };
            let status = response.status();
            if !status.is_success() {
                let headers = response.headers().clone();
                let text = response.text().await.unwrap_or_default();
                if operation
                    .retry_response(status, &headers, text.as_bytes())
                    .await
                {
                    continue;
                }
                if crate::idempotency::response_retires_operation(status, text.as_bytes()) {
                    persistent_operation.retire().map_err(anyhow::Error::msg)?;
                }
                anyhow::bail!("HTTP {} {}", status.as_u16(), text);
            }
            let result = self.consume_proxy_llm_stream(response, generation).await;
            match result {
                Ok(final_text) if final_text.trim().is_empty() => {
                    anyhow::bail!("Cloud LLM returned empty text");
                }
                Ok(final_text) => {
                    return Ok((final_text, persistent_operation.root().to_string()));
                }
                Err(error) => {
                    let retry = if let Some(transport) = error.downcast_ref::<reqwest::Error>() {
                        operation.retry_transport(transport).await
                    } else if error.is::<IncompleteProxyLlmStream>() {
                        operation.retry_ambiguous().await
                    } else {
                        false
                    };
                    if retry {
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }

    async fn consume_proxy_llm_stream(
        &self,
        response: reqwest::Response,
        generation: u64,
    ) -> Result<String> {
        if response
            .content_length()
            .is_some_and(|length| length > PROXY_LLM_STREAM_MAX_BYTES as u64)
        {
            anyhow::bail!("Cloud LLM stream exceeded the client limit");
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > PROXY_LLM_STREAM_MAX_BYTES {
                anyhow::bail!("Cloud LLM stream exceeded the client limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| IncompleteProxyLlmStream("Cloud LLM stream was not valid UTF-8"))?;
        let (content_chunks, full_text) = parse_complete_proxy_llm_stream(&text)?;

        self.with_active_generation(generation, || {
            for content in content_chunks {
                let _ = self.app_handle.emit("llm:chunk", content);
            }
        });
        Ok(full_text)
    }

    /// P1-2: Pre-warm HTTP connection pool by issuing a HEAD request to the STT endpoint.
    /// Call once after app startup to avoid cold-start TLS handshake on first recording.
    pub async fn pre_warm(&self) {
        let config = match self.load_config().await {
            Ok(config) => config,
            Err(error) => {
                tracing::debug!("Skipping STT pre-warm because config is unavailable: {error}");
                return;
            }
        };
        if uses_backend_config_source(&config) {
            tracing::debug!("Skipping local provider pre-warm in backend-managed mode");
            return;
        }

        // Pre-warm STT endpoint
        let stt_endpoint = match config.stt_provider.as_str() {
            "glm-asr" => "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions".to_string(),
            "openai-whisper" => "https://api.openai.com/v1/audio/transcriptions".to_string(),
            "groq-whisper" => "https://api.groq.com/openai/v1/audio/transcriptions".to_string(),
            "siliconflow" => "https://api.siliconflow.cn/v1/audio/transcriptions".to_string(),
            "deepgram" => "https://api.deepgram.com/v1/listen".to_string(),
            "assemblyai" => "https://api.assemblyai.com/v2/transcript".to_string(),
            stt::config::SENSEVOICE_PROVIDER => {
                stt::config::normalize_sensevoice_endpoint(&config.stt_custom_base_url)
                    .unwrap_or_else(|_| format!("{}/asr", stt::config::DEFAULT_SENSEVOICE_BASE_URL))
            }
            _ => {
                tracing::debug!(
                    "Unknown STT provider '{}', skipping pre-warm",
                    config.stt_provider
                );
                return;
            }
        };
        tracing::debug!("Pre-warming STT provider connection");
        let Ok(client) = self.network_client.client() else {
            tracing::debug!("Skipping pre-warm because HTTP client is unavailable");
            return;
        };
        let _ = client
            .head(&stt_endpoint)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        tracing::debug!("STT connection pre-warm complete");

        // Pre-warm LLM endpoint if polish is enabled
        if config.polish_enabled {
            let llm_url = config.llm_base_url.clone();
            tracing::debug!("Pre-warming LLM provider connection");
            let _ = client
                .head(&llm_url)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
            tracing::debug!("LLM connection pre-warm complete");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meter_envelope_has_fast_attack_slow_release_and_silence_reset() {
        let attack = next_meter_envelope(0.0, 1.0);
        let continued_attack = next_meter_envelope(attack, 1.0);
        let release = next_meter_envelope(0.8, 0.4);

        assert!((attack - 0.6).abs() <= f32::EPSILON);
        assert!((continued_attack - 0.84).abs() <= f32::EPSILON);
        assert!((release - 0.7).abs() <= f32::EPSILON);
        let first_silent_release = next_meter_envelope(release, 0.0);
        assert!((first_silent_release - 0.525).abs() <= f32::EPSILON);
        assert_eq!(next_meter_envelope(release, f32::NAN), first_silent_release);
        assert!((next_meter_envelope(f32::NAN, 0.5) - 0.3).abs() <= f32::EPSILON);

        let mut decayed = first_silent_release;
        for _ in 0..20 {
            let next = next_meter_envelope(decayed, 0.0);
            assert!(next <= decayed);
            decayed = next;
        }
        assert_eq!(decayed, 0.0);

        for level in [
            next_meter_envelope(-1.0, 2.0),
            next_meter_envelope(2.0, 0.5),
            next_meter_envelope(f32::INFINITY, f32::NEG_INFINITY),
        ] {
            assert!(level.is_finite());
            assert!((0.0..=1.0).contains(&level));
        }
    }

    #[test]
    fn recording_start_transition_has_one_atomic_owner() {
        let state = AtomicU8::new(PipelineState::Idle.as_u8());
        assert!(try_pipeline_transition(
            &state,
            PipelineState::Idle,
            PipelineState::Recording
        ));
        assert!(!try_pipeline_transition(
            &state,
            PipelineState::Idle,
            PipelineState::Recording
        ));
        assert_eq!(
            PipelineState::from_u8(state.load(Ordering::SeqCst)),
            PipelineState::Recording
        );
    }

    #[test]
    fn recording_stop_transition_rejects_non_recording_and_duplicate_owner() {
        let state = AtomicU8::new(PipelineState::Idle.as_u8());
        assert!(!try_pipeline_transition(
            &state,
            PipelineState::Recording,
            PipelineState::Transcribing
        ));
        state.store(PipelineState::Recording.as_u8(), Ordering::SeqCst);
        assert!(try_pipeline_transition(
            &state,
            PipelineState::Recording,
            PipelineState::Transcribing
        ));
        assert!(!try_pipeline_transition(
            &state,
            PipelineState::Recording,
            PipelineState::Transcribing
        ));
    }
    use std::sync::atomic::{AtomicBool, AtomicU64};

    #[test]
    fn stt_task_should_not_finalize_when_abort_flag_is_set() {
        let abort_flag = AtomicBool::new(true);
        let active_session_id = AtomicU64::new(7);

        assert!(!should_finalize_stt_task(
            &abort_flag,
            &active_session_id,
            7
        ));
    }

    #[test]
    fn effective_max_recording_seconds_clamps_bad_values() {
        assert_eq!(effective_max_recording_seconds(0), 5);
        assert_eq!(effective_max_recording_seconds(30), 30);
        assert_eq!(effective_max_recording_seconds(60 * 60), 15 * 60);
    }

    #[test]
    fn system_audio_mute_follows_recording_config() {
        let mut config = storage::AppConfig::default();
        assert!(!should_mute_system_audio_during_recording(&config));

        config.mute_system_audio_during_recording = true;
        assert!(should_mute_system_audio_during_recording(&config));
    }

    #[test]
    fn llm_runs_only_for_ai_paths() {
        let mut config = storage::AppConfig {
            polish_enabled: false,
            translate_enabled: false,
            ..storage::AppConfig::default()
        };

        assert!(!should_run_llm(&config, false));
        assert!(should_run_llm(&config, true));

        config.translate_enabled = true;
        assert!(should_run_llm(&config, false));

        config.translate_enabled = false;
        config.polish_enabled = true;
        assert!(should_run_llm(&config, false));
    }

    #[test]
    fn ollama_llm_access_allows_empty_api_key() {
        let config = storage::AppConfig {
            llm_provider: "ollama".to_string(),
            llm_api_key: String::new(),
            llm_base_url: "http://localhost:1234/v1".to_string(),
            llm_model: "local-model".to_string(),
            ..storage::AppConfig::default()
        };

        assert!(has_llm_access(&config));
    }

    #[test]
    fn hosted_llm_access_requires_api_key_base_url_and_model() {
        let mut config = storage::AppConfig {
            llm_provider: "openrouter".to_string(),
            llm_api_key: String::new(),
            llm_base_url: "https://openrouter.ai/api/v1".to_string(),
            llm_model: "openai/gpt-4o-mini".to_string(),
            ..storage::AppConfig::default()
        };

        assert!(!has_llm_access(&config));

        config.llm_api_key = "sk-test".to_string();
        assert!(has_llm_access(&config));

        config.llm_model = " ".to_string();
        assert!(!has_llm_access(&config));
    }

    #[test]
    fn stt_task_should_not_finalize_when_session_is_stale() {
        let abort_flag = AtomicBool::new(false);
        let active_session_id = AtomicU64::new(8);

        assert!(!should_finalize_stt_task(
            &abort_flag,
            &active_session_id,
            7
        ));
    }

    #[test]
    fn stt_task_should_finalize_when_session_is_active_and_not_aborted() {
        let abort_flag = AtomicBool::new(false);
        let active_session_id = AtomicU64::new(7);

        assert!(should_finalize_stt_task(&abort_flag, &active_session_id, 7));
    }

    #[test]
    fn old_generation_stays_stale_when_a_new_start_clears_abort() {
        let abort_flag = AtomicBool::new(true);
        let active_generation = AtomicU64::new(8);
        assert!(!is_active_generation(&abort_flag, &active_generation, 7));
        abort_flag.store(false, Ordering::SeqCst);
        assert!(!is_active_generation(&abort_flag, &active_generation, 7));
        assert!(is_active_generation(&abort_flag, &active_generation, 8));
    }

    #[tokio::test]
    async fn pipeline_condition_is_rechecked_after_waiting_for_the_transition_lock() {
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let allowed = Arc::new(AtomicBool::new(true));
        let held = lock.lock().await;
        let worker_lock = Arc::clone(&lock);
        let worker_allowed = Arc::clone(&allowed);
        let worker = tokio::spawn(async move {
            lock_pipeline_if(&worker_lock, move || worker_allowed.load(Ordering::SeqCst))
                .await
                .is_some()
        });

        tokio::task::yield_now().await;
        allowed.store(false, Ordering::SeqCst);
        drop(held);

        assert!(!worker.await.unwrap());
    }

    #[test]
    fn toggle_events_are_dropped_during_long_tail_pipeline_states() {
        assert!(toggle_event_is_actionable(PipelineState::Idle));
        assert!(toggle_event_is_actionable(PipelineState::Recording));
        assert!(!toggle_event_is_actionable(PipelineState::Transcribing));
        assert!(!toggle_event_is_actionable(PipelineState::Polishing));
        assert!(!toggle_event_is_actionable(PipelineState::Outputting));
    }

    #[test]
    fn active_generation_is_rejected_immediately_after_abort() {
        let abort_flag = AtomicBool::new(false);
        let active_generation = AtomicU64::new(7);
        assert!(is_active_generation(&abort_flag, &active_generation, 7));
        abort_flag.store(true, Ordering::SeqCst);
        active_generation.fetch_add(1, Ordering::SeqCst);
        assert!(!is_active_generation(&abort_flag, &active_generation, 7));
    }

    #[test]
    fn in_flight_guard_outlives_public_idle_and_releases_exactly_once() {
        let counter = Arc::new(AtomicUsize::new(0));
        let first = PipelineInFlightGuard::enter(&counter);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        {
            let _second = PipelineInFlightGuard::enter(&counter);
            assert_eq!(counter.load(Ordering::SeqCst), 2);
        }
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        drop(first);
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn matched_generation_commit_runs_once_and_stale_or_aborted_commit_is_suppressed() {
        let guard = Mutex::new(());
        let abort_flag = AtomicBool::new(false);
        let active_generation = AtomicU64::new(7);
        let effects = AtomicU64::new(0);

        assert_eq!(
            commit_generation_effect(&guard, &abort_flag, &active_generation, 7, || {
                effects.fetch_add(1, Ordering::SeqCst)
            }),
            Some(0)
        );
        active_generation.store(8, Ordering::SeqCst);
        assert!(
            commit_generation_effect(&guard, &abort_flag, &active_generation, 7, || {
                effects.fetch_add(1, Ordering::SeqCst)
            })
            .is_none()
        );
        abort_flag.store(true, Ordering::SeqCst);
        assert!(
            commit_generation_effect(&guard, &abort_flag, &active_generation, 8, || {
                effects.fetch_add(1, Ordering::SeqCst)
            })
            .is_none()
        );
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn generation_commit_rechecks_after_waiting_for_transition_guard() {
        let guard = Arc::new(Mutex::new(()));
        let abort_flag = Arc::new(AtomicBool::new(false));
        let active_generation = Arc::new(AtomicU64::new(7));
        let effects = Arc::new(AtomicU64::new(0));
        let held = guard.lock().unwrap();
        let worker_guard = guard.clone();
        let worker_abort = abort_flag.clone();
        let worker_generation = active_generation.clone();
        let worker_effects = effects.clone();
        let worker = std::thread::spawn(move || {
            commit_generation_effect(&worker_guard, &worker_abort, &worker_generation, 7, || {
                worker_effects.fetch_add(1, Ordering::SeqCst)
            })
        });

        active_generation.store(8, Ordering::SeqCst);
        drop(held);
        assert_eq!(worker.join().unwrap(), None);
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stale_output_state_commit_cannot_overwrite_a_new_recording() {
        let guard = Mutex::new(());
        let abort_flag = AtomicBool::new(false);
        let active_generation = AtomicU64::new(8);
        let state = AtomicU8::new(PipelineState::Recording.as_u8());

        assert!(
            commit_generation_effect(&guard, &abort_flag, &active_generation, 7, || state
                .store(PipelineState::Outputting.as_u8(), Ordering::SeqCst),)
            .is_none()
        );
        assert_eq!(
            PipelineState::from_u8(state.load(Ordering::SeqCst)),
            PipelineState::Recording
        );
    }

    #[test]
    fn stale_auto_stop_generation_cannot_claim_a_new_recording() {
        let abort_flag = AtomicBool::new(false);
        let active_generation = AtomicU64::new(8);
        assert!(!matches_expected_generation(
            Some(7),
            &abort_flag,
            &active_generation
        ));
        assert!(matches_expected_generation(
            Some(8),
            &abort_flag,
            &active_generation
        ));
        assert!(matches_expected_generation(
            None,
            &abort_flag,
            &active_generation
        ));
    }

    #[test]
    fn repeated_abort_has_one_atomic_cleanup_owner() {
        let state = AtomicU8::new(PipelineState::Transcribing.as_u8());
        let owner = AtomicBool::new(false);
        assert!(try_begin_abort_transition(&state, &owner));
        assert!(!try_begin_abort_transition(&state, &owner));
        owner.store(false, Ordering::SeqCst);
        state.store(PipelineState::Idle.as_u8(), Ordering::SeqCst);
        assert!(!try_begin_abort_transition(&state, &owner));
    }

    #[test]
    fn session_error_latch_returns_matching_error() {
        let latch = Mutex::new(Some((
            7,
            crate::error::UserError {
                code: "stt_quota_exceeded".to_string(),
                details: Some("quota".to_string()),
                retry_count: 0,
            },
        )));

        let err = take_matching_stt_error(&latch, 7).unwrap();
        assert_eq!(err.code, "stt_quota_exceeded");
        assert!(latch.lock().unwrap().is_none());
    }

    #[test]
    fn session_error_latch_ignores_stale_error() {
        let latch = Mutex::new(Some((
            6,
            crate::error::UserError {
                code: "stt_quota_exceeded".to_string(),
                details: Some("quota".to_string()),
                retry_count: 0,
            },
        )));

        assert!(take_matching_stt_error(&latch, 7).is_none());
        assert!(latch.lock().unwrap().is_some());
    }

    #[tokio::test]
    async fn file_stt_disconnect_waits_for_validated_capture_permission() {
        let control = SttTaskControl {
            id: 7,
            done: Arc::new(Notify::new()),
            abort: Arc::new(Notify::new()),
            finalize: Arc::new(Notify::new()),
        };
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(5),
            wait_for_stt_finalize_permission(&control),
        )
        .await
        .is_err());
        control.finalize.notify_one();
        assert!(wait_for_stt_finalize_permission(&control).await);

        let aborted = SttTaskControl {
            id: 8,
            done: Arc::new(Notify::new()),
            abort: Arc::new(Notify::new()),
            finalize: Arc::new(Notify::new()),
        };
        aborted.abort.notify_one();
        assert!(!wait_for_stt_finalize_permission(&aborted).await);
    }

    #[tokio::test]
    async fn stt_completion_timeout_is_bounded_and_done_permits_are_not_lost() {
        let control = SttTaskControl {
            id: 9,
            done: Arc::new(Notify::new()),
            abort: Arc::new(Notify::new()),
            finalize: Arc::new(Notify::new()),
        };
        assert!(!wait_for_stt_completion(&control, Duration::from_millis(5)).await);
        control.done.notify_one();
        assert!(wait_for_stt_completion(&control, Duration::from_secs(1)).await);
    }

    #[test]
    fn selected_text_rejects_copy_sentinel_when_clipboard_was_unchanged() {
        assert_eq!(
            selected_text_from_clipboard_result(
                Some("__echo_sentinel__".to_string()),
                "__echo_sentinel__"
            ),
            None
        );
    }

    #[test]
    fn selected_text_accepts_text_that_matches_previous_clipboard_backup() {
        assert_eq!(
            selected_text_from_clipboard_result(
                Some("same as previous clipboard".to_string()),
                "__echo_sentinel__",
            ),
            Some("same as previous clipboard".to_string())
        );
    }

    #[test]
    fn selected_text_rejects_whitespace_only_clipboard() {
        assert_eq!(
            selected_text_from_clipboard_result(Some(" \n\t ".to_string()), "__echo_sentinel__"),
            None
        );
    }
}
