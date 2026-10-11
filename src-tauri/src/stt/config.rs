/// Shared STT provider configuration constants.
///
/// Eliminates the triple duplication of endpoint/model/extra_fields across:
/// - `stt::create_provider`
/// - STT connection checks
/// - `lib::bench_stt_connection`
///
use super::whisper_compat::WhisperCompatConfig;

pub const CUSTOM_WHISPER_PROVIDER: &str = "custom-whisper";
pub const SENSEVOICE_PROVIDER: &str = "sensevoice-local";
pub const CUSTOM_WHISPER_PRESET_SPEACHES: &str = "speaches";
pub const CUSTOM_WHISPER_PRESET_CUSTOM: &str = "custom";
pub const DEFAULT_CUSTOM_WHISPER_BASE_URL: &str = "http://localhost:8000/v1";
pub const DEFAULT_CUSTOM_WHISPER_MODEL: &str = "Systran/faster-whisper-large-v3";
pub const DEFAULT_SENSEVOICE_BASE_URL: &str = "http://127.0.0.1:9001";

/// Configuration for a Whisper-compatible STT provider.
#[allow(clippy::doc_lazy_continuation)]
pub struct SttProviderConfig {
    pub endpoint: &'static str,
    pub model: &'static str,
    pub extra_fields: &'static [(&'static str, &'static str)],
}

/// Returns the endpoint, model name, and any extra form fields for a given
/// Whisper-compatible STT provider.
pub fn get_whisper_config(provider: &str) -> Option<SttProviderConfig> {
    match provider {
        "glm-asr" => Some(SttProviderConfig {
            endpoint: "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions",
            model: "glm-asr-2512",
            extra_fields: &[("stream", "false")],
        }),
        "openai-whisper" => Some(SttProviderConfig {
            endpoint: "https://api.openai.com/v1/audio/transcriptions",
            model: "whisper-1",
            extra_fields: &[],
        }),
        "groq-whisper" => Some(SttProviderConfig {
            endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
            model: "whisper-large-v3-turbo",
            extra_fields: &[],
        }),
        "siliconflow" => Some(SttProviderConfig {
            endpoint: "https://api.siliconflow.cn/v1/audio/transcriptions",
            model: "FunAudioLLM/SenseVoiceSmall",
            extra_fields: &[],
        }),
        _ => None,
    }
}

pub fn normalize_custom_whisper_endpoint(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL is required for Local / Custom Whisper".to_string());
    }

    let parsed =
        url::Url::parse(trimmed).map_err(|_| "Base URL must be a valid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Base URL must start with http:// or https://".to_string());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Base URL must not contain credentials, query, or fragment".to_string());
    }

    if trimmed.ends_with("/audio/transcriptions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{}/audio/transcriptions", trimmed))
    }
}

pub fn normalize_sensevoice_endpoint(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        DEFAULT_SENSEVOICE_BASE_URL
    } else {
        trimmed
    };

    let parsed = url::Url::parse(base).map_err(|_| "SenseVoice URL must be a valid URL")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("SenseVoice URL must start with http:// or https://".to_string());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("SenseVoice URL must not contain credentials, query, or fragment".to_string());
    }

    if base.ends_with("/asr") {
        Ok(base.to_string())
    } else {
        Ok(format!("{}/asr", base))
    }
}

pub fn build_custom_whisper_config(
    base_url: &str,
    model: &str,
) -> Result<WhisperCompatConfig, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Model is required for Local / Custom Whisper".to_string());
    }

    Ok(WhisperCompatConfig {
        provider_name: CUSTOM_WHISPER_PROVIDER.to_string(),
        endpoint: normalize_custom_whisper_endpoint(base_url)?,
        model: model.to_string(),
        extra_fields: vec![],
        api_key_required: false,
    })
}

pub fn build_known_whisper_config(provider: &str) -> Option<WhisperCompatConfig> {
    let cfg = get_whisper_config(provider)?;
    Some(WhisperCompatConfig {
        provider_name: provider.to_string(),
        endpoint: cfg.endpoint.to_string(),
        model: cfg.model.to_string(),
        extra_fields: cfg
            .extra_fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        api_key_required: true,
    })
}

pub fn stt_provider_requires_api_key(provider: &str) -> bool {
    provider != CUSTOM_WHISPER_PROVIDER && provider != SENSEVOICE_PROVIDER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glm_asr_config() {
        let cfg = get_whisper_config("glm-asr").unwrap();
        assert!(cfg.endpoint.contains("bigmodel.cn"));
        assert_eq!(cfg.model, "glm-asr-2512");
        assert!(cfg.extra_fields.contains(&("stream", "false")));
    }

    #[test]
    fn test_openai_whisper_config() {
        let cfg = get_whisper_config("openai-whisper").unwrap();
        assert!(cfg.endpoint.contains("api.openai.com"));
        assert_eq!(cfg.model, "whisper-1");
        assert!(cfg.extra_fields.is_empty());
    }

    #[test]
    fn test_groq_whisper_config() {
        let cfg = get_whisper_config("groq-whisper").unwrap();
        assert!(cfg.endpoint.contains("api.groq.com"));
        assert_eq!(cfg.model, "whisper-large-v3-turbo");
        assert!(cfg.extra_fields.is_empty());
    }

    #[test]
    fn test_siliconflow_config() {
        let cfg = get_whisper_config("siliconflow").unwrap();
        assert!(cfg.endpoint.contains("siliconflow"));
        assert_eq!(cfg.model, "FunAudioLLM/SenseVoiceSmall");
        assert!(cfg.extra_fields.is_empty());
    }

    #[test]
    fn test_unknown_provider_returns_none() {
        assert!(get_whisper_config("unknown").is_none());
    }

    #[test]
    fn test_deepgram_not_in_whisper_config() {
        assert!(get_whisper_config("deepgram").is_none());
    }

    #[test]
    fn test_assemblyai_not_in_whisper_config() {
        assert!(get_whisper_config("assemblyai").is_none());
    }

    #[test]
    fn test_normalize_custom_whisper_base_url() {
        let endpoint = normalize_custom_whisper_endpoint("http://localhost:8000/v1").unwrap();
        assert_eq!(endpoint, "http://localhost:8000/v1/audio/transcriptions");
    }

    #[test]
    fn test_normalize_custom_whisper_full_endpoint() {
        let endpoint =
            normalize_custom_whisper_endpoint("http://localhost:8000/v1/audio/transcriptions")
                .unwrap();
        assert_eq!(endpoint, "http://localhost:8000/v1/audio/transcriptions");
    }

    #[test]
    fn test_custom_whisper_rejects_empty_base_url() {
        let err = normalize_custom_whisper_endpoint("   ").unwrap_err();
        assert!(err.contains("Base URL is required"));
    }

    #[test]
    fn test_custom_whisper_rejects_non_http_url() {
        let err = normalize_custom_whisper_endpoint("file:///tmp/server").unwrap_err();
        assert!(err.contains("http://"));
    }

    #[test]
    fn test_custom_whisper_rejects_credentials_and_query() {
        assert!(normalize_custom_whisper_endpoint("https://user:password@example.test/v1").is_err());
        assert!(normalize_custom_whisper_endpoint("https://example.test/v1?token=secret").is_err());
    }

    #[test]
    fn test_normalize_sensevoice_base_url() {
        let endpoint = normalize_sensevoice_endpoint("http://127.0.0.1:9001").unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:9001/asr");
    }

    #[test]
    fn test_normalize_sensevoice_full_endpoint() {
        let endpoint = normalize_sensevoice_endpoint("http://127.0.0.1:9001/asr").unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:9001/asr");
    }

    #[test]
    fn test_sensevoice_rejects_credentials_and_query() {
        assert!(normalize_sensevoice_endpoint("https://user:password@example.test").is_err());
        assert!(normalize_sensevoice_endpoint("https://example.test?token=secret").is_err());
    }

    #[test]
    fn test_sensevoice_does_not_require_api_key() {
        assert!(!stt_provider_requires_api_key(SENSEVOICE_PROVIDER));
    }

    #[test]
    fn test_build_custom_whisper_config() {
        let cfg = build_custom_whisper_config(
            "http://localhost:8000/v1",
            "Systran/faster-whisper-large-v3",
        )
        .unwrap();
        assert_eq!(cfg.provider_name, CUSTOM_WHISPER_PROVIDER);
        assert_eq!(
            cfg.endpoint,
            "http://localhost:8000/v1/audio/transcriptions"
        );
        assert_eq!(cfg.model, "Systran/faster-whisper-large-v3");
        assert!(!cfg.api_key_required);
    }

    #[test]
    fn test_build_custom_whisper_config_requires_model() {
        let err = build_custom_whisper_config("http://localhost:8000/v1", "  ").unwrap_err();
        assert!(err.contains("Model is required"));
    }
}
