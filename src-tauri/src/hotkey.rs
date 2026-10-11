use crate::onboarding_guard::OnboardingGuard;
use crate::pipeline;
use crate::storage;
use crate::HotkeyModeCache;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[derive(Default)]
struct ShortcutEventTracker {
    next_generation: u64,
    current: HashMap<u32, (u64, bool)>,
}

impl ShortcutEventTracker {
    fn record(&mut self, shortcut_id: u32, pressed: bool) -> u64 {
        self.next_generation = self.next_generation.wrapping_add(1);
        if self.next_generation == 0 {
            self.next_generation = 1;
        }
        let generation = self.next_generation;
        self.current.insert(shortcut_id, (generation, pressed));
        generation
    }

    fn matches(&self, shortcut_id: u32, generation: u64, pressed: bool) -> bool {
        self.current.get(&shortcut_id) == Some(&(generation, pressed))
    }
}

pub fn default_shortcut() -> Shortcut {
    let default_hotkey = storage::AppConfig::default().hotkey;
    let fallback = {
        #[cfg(target_os = "macos")]
        {
            Shortcut::new(Some(Modifiers::ALT), Code::Slash)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Shortcut::new(Some(Modifiers::CONTROL), Code::Slash)
        }
    };
    parse_hotkey(&default_hotkey).unwrap_or(fallback)
}

fn shortcut_matches(left: &Shortcut, right: &Shortcut) -> bool {
    left.mods == right.mods && left.key == right.key
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutKind {
    Input,
    ScreenOcr,
}

impl ShortcutKind {
    fn human_label(self) -> &'static str {
        match self {
            Self::Input => "快速输入",
            Self::ScreenOcr => "看窗口",
        }
    }

    fn diagnostic_label(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::ScreenOcr => "screen_ocr",
        }
    }
}

#[derive(Debug)]
struct ConfiguredShortcut {
    kind: ShortcutKind,
    shortcut: Shortcut,
}

const SHORTCUTS_UNAVAILABLE_MESSAGE: &str =
    "快捷键无法启用，可能已被其他应用占用或被系统拦截。请在设置中更换快捷键后重试。";

fn invalid_shortcut_message(kind: ShortcutKind) -> String {
    format!("{}快捷键设置无效，请在设置中重新选择。", kind.human_label())
}

fn registration_failure_message(registered: &[ShortcutKind], failed: &[ShortcutKind]) -> String {
    if registered.is_empty() {
        return SHORTCUTS_UNAVAILABLE_MESSAGE.to_string();
    }

    let failed_labels = failed
        .iter()
        .map(|kind| kind.human_label())
        .collect::<Vec<_>>()
        .join("、");
    let registered_labels = registered
        .iter()
        .map(|kind| kind.human_label())
        .collect::<Vec<_>>()
        .join("、");
    format!(
        "{failed_labels}快捷键未启用，{registered_labels}快捷键仍可使用。请在设置中更换未启用的快捷键后重试。"
    )
}

fn configured_shortcuts(config: &storage::AppConfig) -> Result<Vec<ConfiguredShortcut>, String> {
    let input = parse_hotkey(&config.hotkey)
        .ok_or_else(|| invalid_shortcut_message(ShortcutKind::Input))?;
    let screen_ocr = parse_hotkey(&config.screen_ocr_hotkey)
        .ok_or_else(|| invalid_shortcut_message(ShortcutKind::ScreenOcr))?;

    if shortcut_matches(&input, &screen_ocr) {
        return Err("快速输入键和看窗口快捷键不能相同。".to_string());
    }

    Ok(vec![
        ConfiguredShortcut {
            kind: ShortcutKind::Input,
            shortcut: input,
        },
        ConfiguredShortcut {
            kind: ShortcutKind::ScreenOcr,
            shortcut: screen_ocr,
        },
    ])
}

pub fn register_configured_shortcuts(
    app: &tauri::AppHandle,
    config: &storage::AppConfig,
) -> Result<(), String> {
    let shortcuts = configured_shortcuts(config)?;
    let manager = app.global_shortcut();
    if let Err(error) = manager.unregister_all() {
        tracing::error!("Failed to unregister global shortcuts: {}", error);
        return Err(SHORTCUTS_UNAVAILABLE_MESSAGE.to_string());
    }

    let mut registered = Vec::new();
    let mut failures = Vec::new();
    for configured in shortcuts {
        if let Err(error) = manager.register(configured.shortcut) {
            tracing::error!(
                "Failed to register {} shortcut: {}",
                configured.kind.diagnostic_label(),
                error
            );
            failures.push(configured.kind);
        } else {
            registered.push(configured.kind);
        }
    }

    if failures.is_empty() {
        return Ok(());
    }

    Err(registration_failure_message(&registered, &failures))
}

pub(crate) fn install_configured_shortcuts(
    app: &tauri::AppHandle,
    config: &storage::AppConfig,
) -> tauri::Result<()> {
    let handler = build_shortcut_handler(app.clone());
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(handler)
            .build(),
    )?;
    if let Err(error) = register_configured_shortcuts(app, config) {
        tracing::warn!("Failed to register configured shortcuts (may be occupied): {error}");
    }
    Ok(())
}

pub(crate) fn shortcuts_paused(app: &tauri::AppHandle) -> bool {
    app.state::<crate::ShortcutRegistrationState>().is_paused()
}

pub(crate) fn set_shortcuts_paused(app: &tauri::AppHandle, paused: bool) {
    app.state::<crate::ShortcutRegistrationState>()
        .set_paused(paused);
}

pub fn build_shortcut_handler(
    app_handle: tauri::AppHandle,
) -> impl Fn(&tauri::AppHandle, &Shortcut, tauri_plugin_global_shortcut::ShortcutEvent)
       + Send
       + Sync
       + 'static {
    let event_tracker = Arc::new(Mutex::new(ShortcutEventTracker::default()));
    move |_app, shortcut, event| {
        if shortcuts_paused(&app_handle) {
            return;
        }
        let handle = app_handle.clone();
        let event_shortcut = *shortcut;
        let guarded_at_event = app_handle.state::<OnboardingGuard>().is_active();
        let pipeline_state_at_event = app_handle
            .state::<pipeline::PipelineHandle>()
            .current_state();
        let event_generation = event_tracker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .record(
                event_shortcut.id,
                matches!(event.state, ShortcutState::Pressed),
            );
        match event.state {
            ShortcutState::Pressed => {
                let event_tracker = Arc::clone(&event_tracker);
                tauri::async_runtime::spawn(async move {
                    let onboarding_guard = handle.state::<OnboardingGuard>();
                    let config = match handle.state::<storage::ConfigManager>().load().await {
                        Ok(config) => config,
                        Err(error) => {
                            tracing::error!("Failed to load hotkey config: {}", error);
                            return;
                        }
                    };
                    let input_shortcut = parse_hotkey(&config.hotkey);
                    let screen_ocr_shortcut = parse_hotkey(&config.screen_ocr_hotkey);

                    // The guided tour must never start a real recording or OCR job. During the
                    // shortcut demonstration we forward a renderer-only signal instead.
                    if guarded_at_event || onboarding_guard.is_active() {
                        if input_shortcut
                            .as_ref()
                            .is_some_and(|shortcut| shortcut_matches(&event_shortcut, shortcut))
                        {
                            let _ = handle.emit("onboarding:shortcut", "input");
                        } else if screen_ocr_shortcut
                            .as_ref()
                            .is_some_and(|shortcut| shortcut_matches(&event_shortcut, shortcut))
                        {
                            let _ = handle.emit("onboarding:shortcut", "screen_ocr");
                        }
                        return;
                    }

                    if screen_ocr_shortcut
                        .as_ref()
                        .is_some_and(|shortcut| shortcut_matches(&event_shortcut, shortcut))
                    {
                        if onboarding_guard
                            .run_if_inactive(|| handle.emit("shortcut:screen_ocr", ()))
                            .is_none()
                        {
                            let _ = handle.emit("onboarding:shortcut", "screen_ocr");
                        }
                        return;
                    }

                    if !input_shortcut
                        .as_ref()
                        .is_some_and(|shortcut| shortcut_matches(&event_shortcut, shortcut))
                    {
                        return;
                    }

                    if guarded_at_event || onboarding_guard.is_active() {
                        let _ = handle.emit("onboarding:shortcut", "input");
                        return;
                    }

                    let hotkey_mode = handle
                        .state::<HotkeyModeCache>()
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    let pipeline = handle.state::<pipeline::PipelineHandle>();

                    if hotkey_mode == "toggle" {
                        if !pipeline::toggle_event_is_actionable(pipeline_state_at_event) {
                            return;
                        }
                        if let Err(e) = pipeline.toggle().await {
                            tracing::error!("Failed to toggle recording: {}", e);
                            let _ = handle.emit("pipeline:error", e.to_string());
                        }
                    } else {
                        let shortcut_id = event_shortcut.id;
                        let start_tracker = Arc::clone(&event_tracker);
                        if let Err(e) = pipeline
                            .start_if(move || {
                                start_tracker
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .matches(shortcut_id, event_generation, true)
                            })
                            .await
                        {
                            tracing::error!("Failed to start recording: {}", e);
                            let _ = handle.emit("pipeline:error", e.to_string());
                        }
                    }
                });
            }
            ShortcutState::Released => {
                let event_tracker = Arc::clone(&event_tracker);
                tauri::async_runtime::spawn(async move {
                    let onboarding_guard = handle.state::<OnboardingGuard>();
                    if guarded_at_event || onboarding_guard.is_active() {
                        return;
                    }
                    let config = match handle.state::<storage::ConfigManager>().load().await {
                        Ok(config) => config,
                        Err(error) => {
                            tracing::error!("Failed to load hotkey config: {}", error);
                            return;
                        }
                    };
                    let input_shortcut = parse_hotkey(&config.hotkey);
                    if !input_shortcut
                        .as_ref()
                        .is_some_and(|shortcut| shortcut_matches(&event_shortcut, shortcut))
                    {
                        return;
                    }

                    if onboarding_guard.is_active() {
                        return;
                    }

                    let hotkey_mode = handle
                        .state::<HotkeyModeCache>()
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    if hotkey_mode != "toggle" {
                        let pipeline = handle.state::<pipeline::PipelineHandle>();
                        let shortcut_id = event_shortcut.id;
                        if let Err(e) = pipeline
                            .stop_if(move || {
                                event_tracker
                                    .lock()
                                    .unwrap_or_else(|error| error.into_inner())
                                    .matches(shortcut_id, event_generation, false)
                            })
                            .await
                        {
                            tracing::error!("Failed to stop recording: {}", e);
                            let _ = handle.emit("pipeline:error", e.to_string());
                        }
                    }
                });
            }
        }
    }
}

pub fn parse_hotkey(s: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = s.split('+').map(|p| p.trim()).collect();
    if parts.is_empty() {
        return None;
    }

    let mut modifiers = Modifiers::empty();
    let key_str = parts.last()?;

    for &part in &parts[..parts.len() - 1] {
        match part.to_lowercase().as_str() {
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "shift" => modifiers |= Modifiers::SHIFT,
            "meta" | "super" | "win" | "cmd" => modifiers |= Modifiers::META,
            _ => return None,
        }
    }

    let code = match key_str.to_lowercase().as_str() {
        "space" => Code::Space,
        "tab" => Code::Tab,
        "enter" | "return" => Code::Enter,
        "backspace" => Code::Backspace,
        "escape" | "esc" => Code::Escape,
        "delete" => Code::Delete,
        "insert" => Code::Insert,
        "home" => Code::Home,
        "end" => Code::End,
        "pageup" => Code::PageUp,
        "pagedown" => Code::PageDown,
        "arrowup" | "up" => Code::ArrowUp,
        "arrowdown" | "down" => Code::ArrowDown,
        "arrowleft" | "left" => Code::ArrowLeft,
        "arrowright" | "right" => Code::ArrowRight,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        "a" => Code::KeyA,
        "b" => Code::KeyB,
        "c" => Code::KeyC,
        "d" => Code::KeyD,
        "e" => Code::KeyE,
        "f" => Code::KeyF,
        "g" => Code::KeyG,
        "h" => Code::KeyH,
        "i" => Code::KeyI,
        "j" => Code::KeyJ,
        "k" => Code::KeyK,
        "l" => Code::KeyL,
        "m" => Code::KeyM,
        "n" => Code::KeyN,
        "o" => Code::KeyO,
        "p" => Code::KeyP,
        "q" => Code::KeyQ,
        "r" => Code::KeyR,
        "s" => Code::KeyS,
        "t" => Code::KeyT,
        "u" => Code::KeyU,
        "v" => Code::KeyV,
        "w" => Code::KeyW,
        "x" => Code::KeyX,
        "y" => Code::KeyY,
        "z" => Code::KeyZ,
        "0" => Code::Digit0,
        "1" => Code::Digit1,
        "2" => Code::Digit2,
        "3" => Code::Digit3,
        "4" => Code::Digit4,
        "5" => Code::Digit5,
        "6" => Code::Digit6,
        "7" => Code::Digit7,
        "8" => Code::Digit8,
        "9" => Code::Digit9,
        "/" | "slash" => Code::Slash,
        "\\" | "backslash" => Code::Backslash,
        "." | "period" => Code::Period,
        "," | "comma" => Code::Comma,
        ";" | "semicolon" => Code::Semicolon,
        "'" | "quote" => Code::Quote,
        "`" | "backquote" => Code::Backquote,
        "-" | "minus" => Code::Minus,
        "=" | "equal" => Code::Equal,
        "[" | "bracketleft" => Code::BracketLeft,
        "]" | "bracketright" => Code::BracketRight,
        _ => return None,
    };

    let mods = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Some(Shortcut::new(mods, code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hotkey_ctrl_slash() {
        let s = parse_hotkey("Ctrl+/");
        assert!(s.is_some());
        let s = s.unwrap();
        assert_eq!(s.mods, Modifiers::CONTROL);
        assert_eq!(s.key, Code::Slash);
    }

    #[test]
    fn test_parse_hotkey_ctrl_shift_a() {
        let s = parse_hotkey("Ctrl+Shift+A");
        assert!(s.is_some());
        let s = s.unwrap();
        assert_eq!(s.mods, Modifiers::CONTROL | Modifiers::SHIFT);
        assert_eq!(s.key, Code::KeyA);
    }

    #[test]
    fn test_parse_hotkey_case_insensitive() {
        let s = parse_hotkey("cTrL+/");
        assert!(s.is_some());
        let s = s.unwrap();
        assert_eq!(s.mods, Modifiers::CONTROL);
        assert_eq!(s.key, Code::Slash);
    }

    #[test]
    fn test_parse_hotkey_option_slash() {
        let s = parse_hotkey("Option+/");
        assert!(s.is_some());
        let s = s.unwrap();
        assert_eq!(s.mods, Modifiers::ALT);
        assert_eq!(s.key, Code::Slash);
    }

    #[test]
    fn test_parse_hotkey_f_keys() {
        for (key, expected) in [("F1", Code::F1), ("F12", Code::F12)] {
            let s = parse_hotkey(&format!("Ctrl+{}", key));
            assert!(s.is_some(), "Failed to parse Ctrl+{}", key);
            assert_eq!(s.unwrap().key, expected);
        }
    }

    #[test]
    fn test_parse_hotkey_meta_modifier() {
        for name in ["Meta", "Super", "Win", "Cmd"] {
            let s = parse_hotkey(&format!("{}+A", name));
            assert!(s.is_some(), "Failed to parse {}+A", name);
            assert_eq!(s.unwrap().mods, Modifiers::SUPER);
        }
    }

    #[test]
    fn test_parse_hotkey_no_modifier() {
        let s = parse_hotkey("A");
        assert!(s.is_some());
        assert_eq!(s.unwrap().mods, Modifiers::empty());
    }

    #[test]
    fn test_parse_hotkey_invalid_key() {
        let s = parse_hotkey("Alt+InvalidKey");
        assert!(s.is_none());
    }

    #[test]
    fn test_parse_hotkey_empty_string() {
        let s = parse_hotkey("");
        assert!(s.is_none());
    }

    #[test]
    fn test_parse_hotkey_digits() {
        let s = parse_hotkey("Ctrl+0");
        assert!(s.is_some());
        assert_eq!(s.unwrap().key, Code::Digit0);

        let s = parse_hotkey("Ctrl+9");
        assert!(s.is_some());
        assert_eq!(s.unwrap().key, Code::Digit9);
    }

    #[test]
    fn test_parse_hotkey_navigation_keys() {
        for (key, expected) in [
            ("Enter", Code::Enter),
            ("Tab", Code::Tab),
            ("Escape", Code::Escape),
            ("Backspace", Code::Backspace),
            ("Delete", Code::Delete),
            ("Up", Code::ArrowUp),
            ("Down", Code::ArrowDown),
        ] {
            let s = parse_hotkey(&format!("Alt+{}", key));
            assert!(s.is_some(), "Failed to parse Alt+{}", key);
            assert_eq!(s.unwrap().key, expected);
        }
    }

    #[test]
    fn configured_shortcuts_reject_duplicate_bindings() {
        let mut config = storage::AppConfig::default();
        config.screen_ocr_hotkey = config.hotkey.clone();

        assert_eq!(
            configured_shortcuts(&config).unwrap_err(),
            "快速输入键和看窗口快捷键不能相同。"
        );
    }

    #[test]
    fn configured_shortcuts_describe_invalid_input_for_people() {
        let mut config = storage::AppConfig::default();
        config.hotkey = "Ctrl+InvalidKey".to_string();

        assert_eq!(
            configured_shortcuts(&config).unwrap_err(),
            "快速输入快捷键设置无效，请在设置中重新选择。"
        );
    }

    #[test]
    fn configured_shortcuts_describe_invalid_screen_ocr_for_people() {
        let mut config = storage::AppConfig::default();
        config.screen_ocr_hotkey = "Ctrl+InvalidKey".to_string();

        assert_eq!(
            configured_shortcuts(&config).unwrap_err(),
            "看窗口快捷键设置无效，请在设置中重新选择。"
        );
    }

    #[test]
    fn registration_failure_message_hides_native_details_when_all_fail() {
        let message =
            registration_failure_message(&[], &[ShortcutKind::Input, ShortcutKind::ScreenOcr]);

        assert_eq!(message, SHORTCUTS_UNAVAILABLE_MESSAGE);
        assert!(!message.contains("input"));
        assert!(!message.contains("screen_ocr"));
    }

    #[test]
    fn registration_failure_message_names_partial_failure_without_native_details() {
        let message =
            registration_failure_message(&[ShortcutKind::Input], &[ShortcutKind::ScreenOcr]);

        assert_eq!(
            message,
            "看窗口快捷键未启用，快速输入快捷键仍可使用。请在设置中更换未启用的快捷键后重试。"
        );
        assert!(!message.contains("screen_ocr"));
    }

    #[test]
    fn release_invalidates_a_pending_press_token() {
        let mut tracker = ShortcutEventTracker::default();
        let pressed = tracker.record(7, true);
        let released = tracker.record(7, false);

        assert!(!tracker.matches(7, pressed, true));
        assert!(tracker.matches(7, released, false));
    }

    #[test]
    fn a_new_press_invalidates_an_older_release_without_crossing_shortcuts() {
        let mut tracker = ShortcutEventTracker::default();
        let first_press = tracker.record(7, true);
        let old_release = tracker.record(7, false);
        let ocr_press = tracker.record(9, true);
        let latest_press = tracker.record(7, true);

        assert!(!tracker.matches(7, first_press, true));
        assert!(!tracker.matches(7, old_release, false));
        assert!(tracker.matches(7, latest_press, true));
        assert!(tracker.matches(9, ocr_press, true));
    }
}
