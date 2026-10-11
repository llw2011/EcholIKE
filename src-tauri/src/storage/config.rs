use super::atomic_file::{atomic_write_with, replace_file_atomically};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

pub const DEFAULT_NETWORK_PROXY_BYPASS: &str =
    "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const APP_CONFIG_STORE_FILE: &str = "app-config-v2.json";
const APP_CONFIG_SCHEMA: &str = "echolike.app-config";
const APP_CONFIG_SCHEMA_VERSION: u32 = 2;
pub const CURRENT_ONBOARDING_VERSION: u32 = 1;

#[derive(Default)]
pub struct ConfigMutationLock(pub tokio::sync::Mutex<()>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub config_source: String,
    pub onboarding_version: u32,
    pub stt_provider: String,
    pub stt_api_key: String,
    pub stt_custom_api_key: String,
    pub stt_language: String,
    pub stt_custom_preset: String,
    pub stt_custom_base_url: String,
    pub stt_custom_model: String,
    pub llm_provider: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub llm_base_url: String,
    pub ocr_base_url: String,
    pub ocr_model: String,
    pub polish_enabled: bool,
    pub translate_enabled: bool,
    pub target_lang: String,
    pub hotkey: String,
    pub screen_ocr_hotkey: String,
    pub hotkey_mode: String,
    pub output_mode: String,
    pub selected_text_enabled: bool,
    pub theme: String,
    pub theme_profile: String,
    pub auto_start: bool,
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub max_recording_seconds: u32,
    pub mute_system_audio_during_recording: bool,
    pub ui_language: String,
    pub capsule_auto_hide: bool,
    pub capsule_style: String,
    pub network_proxy_enabled: bool,
    pub network_proxy_url: String,
    pub network_proxy_bypass: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            config_source: "backend".to_string(),
            onboarding_version: 0,
            stt_provider: "glm-asr".to_string(),
            stt_api_key: String::new(),
            stt_custom_api_key: String::new(),
            stt_language: "multi".to_string(),
            stt_custom_preset: crate::stt::config::CUSTOM_WHISPER_PRESET_SPEACHES.to_string(),
            stt_custom_base_url: crate::stt::config::DEFAULT_CUSTOM_WHISPER_BASE_URL.to_string(),
            stt_custom_model: crate::stt::config::DEFAULT_CUSTOM_WHISPER_MODEL.to_string(),
            llm_provider: "openrouter".to_string(),
            llm_api_key: String::new(),
            llm_model: "google/gemini-2.5-flash".to_string(),
            llm_base_url: "https://openrouter.ai/api/v1".to_string(),
            ocr_base_url: "http://127.0.0.1:11434".to_string(),
            ocr_model: "glm-ocr:latest".to_string(),
            polish_enabled: true,
            translate_enabled: false,
            target_lang: "en".to_string(),
            #[cfg(target_os = "macos")]
            hotkey: "Option+/".to_string(),
            #[cfg(not(target_os = "macos"))]
            hotkey: "Ctrl+/".to_string(),
            #[cfg(target_os = "macos")]
            screen_ocr_hotkey: "Option+Shift+O".to_string(),
            #[cfg(not(target_os = "macos"))]
            screen_ocr_hotkey: "Ctrl+Shift+O".to_string(),
            hotkey_mode: "hold".to_string(),
            output_mode: "keyboard".to_string(),
            selected_text_enabled: false,
            theme: "system".to_string(),
            theme_profile: "echo".to_string(),
            auto_start: false,
            close_to_tray: true,
            start_minimized: false,
            max_recording_seconds: 30,
            mute_system_audio_during_recording: false,
            ui_language: "zh".to_string(),
            capsule_auto_hide: false,
            capsule_style: "classic".to_string(),
            network_proxy_enabled: false,
            network_proxy_url: String::new(),
            network_proxy_bypass: DEFAULT_NETWORK_PROXY_BYPASS.to_string(),
        }
    }
}

impl AppConfig {
    pub fn new_install_default() -> Self {
        Self {
            capsule_auto_hide: true,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppConfigOrigin {
    Persisted,
    CreatedNew,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigSnapshot {
    pub config: AppConfig,
    pub origin: AppConfigOrigin,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AppConfigEnvelope {
    schema: String,
    schema_version: u32,
    config: AppConfig,
}

#[derive(Debug)]
enum AppConfigFileRead {
    Missing,
    Valid(AppConfig),
    Invalid(anyhow::Error),
    Unreadable(anyhow::Error),
}

fn parse_app_config(bytes: &[u8]) -> Result<AppConfig> {
    let envelope: AppConfigEnvelope =
        serde_json::from_slice(bytes).context("parse app config v2 envelope")?;
    anyhow::ensure!(
        envelope.schema == APP_CONFIG_SCHEMA,
        "unsupported app config schema {:?}",
        envelope.schema
    );
    anyhow::ensure!(
        envelope.schema_version == APP_CONFIG_SCHEMA_VERSION,
        "unsupported app config schema version {}",
        envelope.schema_version
    );
    Ok(envelope.config)
}

fn classify_app_config_read(
    path: &Path,
    read_result: std::io::Result<Vec<u8>>,
) -> AppConfigFileRead {
    let bytes = match read_result {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return AppConfigFileRead::Missing;
        }
        Err(error) => {
            return AppConfigFileRead::Unreadable(anyhow::anyhow!(
                "read app config v2 at {}: {error}",
                path.display()
            ));
        }
    };

    match parse_app_config(&bytes) {
        Ok(config) => AppConfigFileRead::Valid(config),
        Err(error) => AppConfigFileRead::Invalid(
            error.context(format!("validate app config v2 at {}", path.display())),
        ),
    }
}

fn read_app_config(path: &Path) -> AppConfigFileRead {
    classify_app_config_read(path, fs::read(path))
}

fn serialize_app_config_envelope(config: &AppConfig, path: &Path) -> Result<Vec<u8>> {
    let envelope = AppConfigEnvelope {
        schema: APP_CONFIG_SCHEMA.to_string(),
        schema_version: APP_CONFIG_SCHEMA_VERSION,
        config: config.clone(),
    };
    serde_json::to_vec_pretty(&envelope)
        .with_context(|| format!("serialize app config v2 envelope {}", path.display()))
}

fn persist_app_config(path: &Path, config: &AppConfig) -> Result<()> {
    let bytes = serialize_app_config_envelope(config, path)?;
    atomic_write_with(path, &bytes, replace_file_atomically)
}

fn load_or_initialize_app_config(path: &Path) -> Result<AppConfigSnapshot> {
    match read_app_config(path) {
        AppConfigFileRead::Valid(config) => Ok(AppConfigSnapshot {
            config,
            origin: AppConfigOrigin::Persisted,
        }),
        AppConfigFileRead::Missing => {
            let config = AppConfig::new_install_default();
            persist_app_config(path, &config).with_context(|| {
                format!(
                    "initialize app config v2 before confirming first run at {}",
                    path.display()
                )
            })?;
            match read_app_config(path) {
                AppConfigFileRead::Valid(read_back) if read_back == config => {
                    Ok(AppConfigSnapshot {
                        config,
                        origin: AppConfigOrigin::CreatedNew,
                    })
                }
                AppConfigFileRead::Valid(_) => anyhow::bail!(
                    "app config v2 changed during initialization at {}",
                    path.display()
                ),
                other => anyhow::bail!(
                    "app config v2 could not be read back after initialization at {}: {other:?}",
                    path.display()
                ),
            }
        }
        AppConfigFileRead::Invalid(error) | AppConfigFileRead::Unreadable(error) => Err(error),
    }
}

fn persist_config_transaction(
    cache: &Mutex<Option<AppConfigSnapshot>>,
    mutate: impl FnOnce(&mut AppConfig),
    persist: impl FnOnce(&AppConfig) -> Result<()>,
) -> Result<(AppConfig, AppConfig)> {
    let mut cache = cache.lock().unwrap_or_else(|error| error.into_inner());
    let previous = cache
        .as_ref()
        .map(|snapshot| snapshot.config.clone())
        .context("app config transaction started before initial load")?;
    let mut config = previous.clone();
    mutate(&mut config);
    persist(&config)?;
    *cache = Some(AppConfigSnapshot {
        config: config.clone(),
        origin: AppConfigOrigin::Persisted,
    });
    Ok((previous, config))
}

fn merge_user_config_changes(current: &mut AppConfig, base: &AppConfig, requested: &AppConfig) {
    macro_rules! merge_fields {
        ($($field:ident),+ $(,)?) => {
            $(
                if base.$field != requested.$field {
                    current.$field = requested.$field.clone();
                }
            )+
        };
    }

    // First-run progress and fields with native side effects are deliberately excluded.
    // Their commands mutate the locked current snapshot directly instead of replaying a renderer
    // copy of the whole config.
    merge_fields!(
        config_source,
        stt_provider,
        stt_api_key,
        stt_custom_api_key,
        stt_language,
        stt_custom_preset,
        stt_custom_base_url,
        stt_custom_model,
        llm_provider,
        llm_api_key,
        llm_model,
        llm_base_url,
        ocr_base_url,
        ocr_model,
        polish_enabled,
        translate_enabled,
        target_lang,
        hotkey_mode,
        output_mode,
        selected_text_enabled,
        theme,
        theme_profile,
        close_to_tray,
        start_minimized,
        max_recording_seconds,
        mute_system_audio_during_recording,
        ui_language,
        capsule_style,
        network_proxy_enabled,
        network_proxy_url,
        network_proxy_bypass,
    );
}

// App config v2 lives in one atomically replaced file. Earlier file namespaces are never read.

pub struct ConfigManager {
    app_handle: tauri::AppHandle,
    cache: Mutex<Option<AppConfigSnapshot>>,
}

impl ConfigManager {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle,
            cache: Mutex::new(None),
        }
    }

    pub async fn load_snapshot(&self) -> Result<AppConfigSnapshot> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(snapshot) = cache.clone() {
            return Ok(snapshot);
        }

        let data_dir = self
            .app_handle
            .path()
            .app_data_dir()
            .context("resolve app data directory while loading app config")?;
        let snapshot = load_or_initialize_app_config(&data_dir.join(APP_CONFIG_STORE_FILE))?;
        *cache = Some(snapshot.clone());
        Ok(snapshot)
    }

    pub async fn load(&self) -> Result<AppConfig> {
        self.load_snapshot().await.map(|snapshot| snapshot.config)
    }

    pub async fn update(
        &self,
        mutate: impl FnOnce(&mut AppConfig),
    ) -> Result<(AppConfig, AppConfig)> {
        self.load_snapshot().await?;
        let data_dir = self
            .app_handle
            .path()
            .app_data_dir()
            .context("resolve app data directory while saving app config")?;
        persist_config_transaction(&self.cache, mutate, |config| {
            persist_app_config(&data_dir.join(APP_CONFIG_STORE_FILE), config)
        })
    }

    pub async fn save_changes(
        &self,
        base: &AppConfig,
        requested: &AppConfig,
    ) -> Result<(AppConfig, AppConfig)> {
        let base = base.clone();
        let requested = requested.clone();
        self.update(move |current| merge_user_config_changes(current, &base, &requested))
            .await
    }

    pub fn current(&self) -> Option<AppConfig> {
        self.cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|snapshot| snapshot.config.clone())
    }
}

#[cfg(test)]
mod tests;
