use crate::{storage, CloseToTrayCache, HotkeyModeCache};
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use url::Url;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::GlobalFree;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Networking::WinHttp::{
    WinHttpGetIEProxyConfigForCurrentUser, WINHTTP_CURRENT_USER_IE_PROXY_CONFIG,
};

fn emit_config_patch(app: &tauri::AppHandle, patch: &Value) {
    if patch.as_object().is_some_and(|object| !object.is_empty()) {
        let _ = app.emit("config:patch", patch.clone());
    }
}

fn config_patch_between(previous: &storage::AppConfig, next: &storage::AppConfig) -> Value {
    let before = serde_json::to_value(previous).unwrap_or_default();
    let after = serde_json::to_value(next).unwrap_or_default();
    let mut patch = Map::new();

    if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
        for (key, value) in after {
            if before.get(key) != Some(value) {
                patch.insert(key.clone(), value.clone());
            }
        }
    }

    Value::Object(patch)
}

fn update_runtime_caches(
    hotkey_mode_cache: &HotkeyModeCache,
    close_tray_cache: &CloseToTrayCache,
    config: &storage::AppConfig,
) {
    *hotkey_mode_cache
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = config.hotkey_mode.clone();
    *close_tray_cache.0.lock().unwrap_or_else(|e| e.into_inner()) = config.close_to_tray;
}

pub(crate) fn synchronize_auto_start(
    app: &tauri::AppHandle,
    config: &storage::AppConfig,
) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let enabled = autolaunch.is_enabled().map_err(|error| error.to_string())?;
    if config.auto_start == enabled {
        return Ok(());
    }
    if config.auto_start {
        autolaunch.enable().map_err(|error| error.to_string())
    } else {
        autolaunch.disable().map_err(|error| error.to_string())
    }
}

fn format_proxy_url(parsed: &Url) -> Option<String> {
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.trim();
    if host.is_empty() {
        return None;
    }

    let mut value = format!("{}://", parsed.scheme());
    if !parsed.username().is_empty() {
        value.push_str(parsed.username());
        if let Some(password) = parsed.password() {
            value.push(':');
            value.push_str(password);
        }
        value.push('@');
    }
    if host.contains(':') && !host.starts_with('[') {
        value.push('[');
        value.push_str(host);
        value.push(']');
    } else {
        value.push_str(host);
    }
    if let Some(port) = parsed.port() {
        value.push(':');
        value.push_str(&port.to_string());
    }
    Some(value)
}

fn normalize_http_proxy_candidate(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&candidate).ok()?;
    format_proxy_url(&parsed)
}

fn http_proxy_from_system_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('=') {
        for entry in trimmed.split(';') {
            let Some((kind, target)) = entry.split_once('=') else {
                continue;
            };
            if kind.trim().eq_ignore_ascii_case("http") {
                return normalize_http_proxy_candidate(target);
            }
        }
        return None;
    }
    normalize_http_proxy_candidate(trimmed)
}

fn proxy_from_environment() -> Option<String> {
    ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find_map(|value| normalize_http_proxy_candidate(&value))
}

#[cfg(target_os = "windows")]
fn winhttp_string(value: windows_sys::core::PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }

    unsafe {
        let mut len = 0;
        while *value.add(len) != 0 {
            len += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(value, len));
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    }
}

#[cfg(target_os = "windows")]
fn free_winhttp_string(value: windows_sys::core::PWSTR) {
    if !value.is_null() {
        unsafe {
            let _ = GlobalFree(value.cast());
        }
    }
}

#[cfg(target_os = "windows")]
fn proxy_from_winhttp_ie_settings() -> Option<String> {
    let mut config: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = unsafe { std::mem::zeroed() };
    unsafe {
        if WinHttpGetIEProxyConfigForCurrentUser(&mut config) == 0 {
            return None;
        }
    }

    let proxy = winhttp_string(config.lpszProxy)
        .as_deref()
        .and_then(http_proxy_from_system_value);

    free_winhttp_string(config.lpszAutoConfigUrl);
    free_winhttp_string(config.lpszProxy);
    free_winhttp_string(config.lpszProxyBypass);

    proxy
}

#[cfg(target_os = "windows")]
fn read_windows_internet_setting(name: &str) -> Option<String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            name,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let field = parts.next()?;
        if !field.eq_ignore_ascii_case(name) {
            return None;
        }
        parts.last().map(ToString::to_string)
    })
}

#[cfg(target_os = "windows")]
fn windows_proxy_enabled(value: &str) -> bool {
    let trimmed = value.trim();
    if let Some(hex) = trimmed.strip_prefix("0x") {
        return u32::from_str_radix(hex, 16).is_ok_and(|value| value != 0);
    }
    trimmed.parse::<u32>().is_ok_and(|value| value != 0)
}

#[cfg(target_os = "windows")]
fn proxy_from_windows_settings() -> Option<String> {
    let enabled = read_windows_internet_setting("ProxyEnable")?;
    if !windows_proxy_enabled(&enabled) {
        return None;
    }
    let proxy_server = read_windows_internet_setting("ProxyServer")?;
    http_proxy_from_system_value(&proxy_server)
}

#[tauri::command]
pub async fn get_config_snapshot(
    state: tauri::State<'_, storage::ConfigManager>,
) -> Result<storage::AppConfigSnapshot, String> {
    state
        .load_snapshot()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn choose_usage_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
    network_client: tauri::State<'_, crate::network::NetworkClient>,
    source: String,
) -> Result<storage::AppConfig, String> {
    if source != "local" && source != "backend" {
        return Err(format!("unsupported usage mode: {source}"));
    }
    let _mutation_guard = mutation_lock.0.lock().await;
    let pipeline = app.state::<crate::pipeline::PipelineHandle>();
    if pipeline.has_in_flight_operation()
        || pipeline.current_state() != crate::pipeline::PipelineState::Idle
    {
        return Err("请先结束当前录音或文字处理任务，再切换使用方式。".to_string());
    }

    let (previous, next) = state
        .update(move |config| {
            config.config_source = source;
            config.onboarding_version = config
                .onboarding_version
                .max(storage::CURRENT_ONBOARDING_VERSION);
        })
        .await
        .map_err(|error| error.to_string())?;
    network_client.refresh(&next);
    emit_config_patch(&app, &config_patch_between(&previous, &next));
    Ok(next)
}

#[tauri::command]
pub fn detect_system_http_proxy() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    if let Some(proxy) = proxy_from_winhttp_ie_settings() {
        return Ok(Some(proxy));
    }

    #[cfg(target_os = "windows")]
    if let Some(proxy) = proxy_from_windows_settings() {
        return Ok(Some(proxy));
    }

    Ok(proxy_from_environment())
}

#[tauri::command]
pub async fn update_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
    hotkey_mode_cache: tauri::State<'_, HotkeyModeCache>,
    close_tray_cache: tauri::State<'_, CloseToTrayCache>,
    network_client: tauri::State<'_, crate::network::NetworkClient>,
    base_config: storage::AppConfig,
    config: storage::AppConfig,
) -> Result<storage::AppConfig, String> {
    let _mutation_guard = mutation_lock.0.lock().await;
    let (previous, config) = state
        .save_changes(&base_config, &config)
        .await
        .map_err(|error| error.to_string())?;

    update_runtime_caches(&hotkey_mode_cache, &close_tray_cache, &config);
    network_client.refresh(&config);

    let patch = config_patch_between(&previous, &config);
    emit_config_patch(&app, &patch);
    if previous.capsule_auto_hide != config.capsule_auto_hide
        || previous.ui_language != config.ui_language
        || previous.close_to_tray != config.close_to_tray
    {
        crate::refresh_tray(&app);
    }

    Ok(config)
}

pub(crate) async fn save_capsule_auto_hide(
    app: &tauri::AppHandle,
    state: &storage::ConfigManager,
    enabled: bool,
) -> Result<(), String> {
    let mutation_lock = app.state::<storage::ConfigMutationLock>();
    let _mutation_guard = mutation_lock.0.lock().await;
    let config = state.load().await.map_err(|e| e.to_string())?;
    if config.capsule_auto_hide == enabled {
        return Ok(());
    }
    state
        .update(move |current| current.capsule_auto_hide = enabled)
        .await
        .map_err(|e| e.to_string())?;
    let patch = json!({ "capsule_auto_hide": enabled });
    emit_config_patch(app, &patch);
    crate::refresh_tray(app);
    Ok(())
}

#[tauri::command]
pub async fn set_auto_start(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, storage::ConfigManager>,
    mutation_lock: tauri::State<'_, storage::ConfigMutationLock>,
    enabled: bool,
) -> Result<(), String> {
    let _mutation_guard = mutation_lock.0.lock().await;
    let config = config_state.load().await.map_err(|e| e.to_string())?;
    let autolaunch = app.autolaunch();
    let was_enabled = autolaunch.is_enabled().map_err(|e| e.to_string())?;
    if was_enabled != enabled {
        if enabled {
            autolaunch.enable().map_err(|e| e.to_string())?;
        } else {
            autolaunch.disable().map_err(|e| e.to_string())?;
        }
    }

    if config.auto_start != enabled {
        if let Err(error) = config_state
            .update(move |current| current.auto_start = enabled)
            .await
        {
            let rollback = if was_enabled != enabled {
                if was_enabled {
                    autolaunch.enable()
                } else {
                    autolaunch.disable()
                }
                .map_err(|rollback_error| rollback_error.to_string())
            } else {
                Ok(())
            };
            return match rollback {
                Ok(()) => Err(error.to_string()),
                Err(rollback_error) => Err(format!(
                    "{}; auto-start rollback also failed: {rollback_error}",
                    error
                )),
            };
        }
        emit_config_patch(&app, &json!({ "auto_start": enabled }));
    }

    Ok(())
}

#[tauri::command]
pub async fn set_capsule_auto_hide(
    app: tauri::AppHandle,
    state: tauri::State<'_, storage::ConfigManager>,
    enabled: bool,
) -> Result<(), String> {
    save_capsule_auto_hide(&app, &state, enabled).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_patch_between_only_includes_changed_fields() {
        let previous = storage::AppConfig::default();
        let mut next = previous.clone();
        next.hotkey = "Ctrl+Shift+A".to_string();
        next.screen_ocr_hotkey = "Ctrl+Shift+O".to_string();
        next.polish_enabled = !previous.polish_enabled;
        next.config_source = "local".to_string();
        next.mute_system_audio_during_recording = true;

        let patch = config_patch_between(&previous, &next);

        assert_eq!(patch["hotkey"], json!("Ctrl+Shift+A"));
        assert!(patch.get("screen_ocr_hotkey").is_none());
        assert_eq!(patch["polish_enabled"], json!(next.polish_enabled));
        assert_eq!(patch["config_source"], json!("local"));
        assert_eq!(patch["mute_system_audio_during_recording"], json!(true));
        assert!(patch.get("llm_model").is_none());
    }

    #[test]
    fn config_patch_between_is_empty_for_equal_configs() {
        let config = storage::AppConfig::default();

        let patch = config_patch_between(&config, &config);

        assert!(patch.as_object().is_some_and(|object| object.is_empty()));
    }

    #[test]
    fn parses_windows_http_proxy_mapping() {
        assert_eq!(
            http_proxy_from_system_value("http=127.0.0.1:7890;https=127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            http_proxy_from_system_value("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            http_proxy_from_system_value("socks=127.0.0.1:1080").as_deref(),
            None
        );
    }
}
