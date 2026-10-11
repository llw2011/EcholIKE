use crate::stt;

fn resolve_whisper_test_config(
    provider: &str,
    custom_base_url: Option<String>,
    custom_model: Option<String>,
) -> Result<stt::whisper_compat::WhisperCompatConfig, String> {
    if provider == stt::config::CUSTOM_WHISPER_PROVIDER {
        return stt::config::build_custom_whisper_config(
            custom_base_url.as_deref().unwrap_or_default(),
            custom_model.as_deref().unwrap_or_default(),
        );
    }

    stt::config::build_known_whisper_config(provider)
        .ok_or_else(|| format!("Unknown STT provider: {}", provider))
}

fn resolve_sensevoice_endpoint(custom_base_url: Option<String>) -> Result<String, String> {
    stt::config::normalize_sensevoice_endpoint(custom_base_url.as_deref().unwrap_or_default())
}

async fn post_sensevoice_probe(
    endpoint: String,
    client: &reqwest::Client,
) -> Result<reqwest::Response, String> {
    let silent_pcm = vec![0u8; 3200]; // 0.1s at 16kHz 16-bit mono
    let wav = stt::whisper_compat::WhisperCompatProvider::build_wav(&silent_pcm, 16000);

    let file_part = reqwest::multipart::Part::bytes(wav)
        .file_name("test.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("language", "auto");

    client
        .post(endpoint)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_custom_whisper_test_config() {
        let cfg = resolve_whisper_test_config(
            stt::config::CUSTOM_WHISPER_PROVIDER,
            Some("http://localhost:8000/v1".to_string()),
            Some("Systran/faster-whisper-large-v3".to_string()),
        )
        .unwrap();
        assert_eq!(
            cfg.endpoint,
            "http://localhost:8000/v1/audio/transcriptions"
        );
        assert!(!cfg.api_key_required);
    }

    #[test]
    fn custom_whisper_test_config_requires_model() {
        let err = resolve_whisper_test_config(
            stt::config::CUSTOM_WHISPER_PROVIDER,
            Some("http://localhost:8000/v1".to_string()),
            Some(" ".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("Model is required"));
    }

    #[test]
    fn resolves_sensevoice_endpoint() {
        let endpoint =
            resolve_sensevoice_endpoint(Some("http://127.0.0.1:9001".to_string())).unwrap();
        assert_eq!(endpoint, "http://127.0.0.1:9001/asr");
    }
}

#[tauri::command]
pub async fn bench_stt_connection(
    api_key: String,
    provider: String,
    custom_base_url: Option<String>,
    custom_model: Option<String>,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<u32, String> {
    if provider.is_empty() {
        return Err("No provider specified".to_string());
    }

    if stt::config::stt_provider_requires_api_key(&provider) && api_key.is_empty() {
        return Err("API key is empty".to_string());
    }

    let client = client.client()?;
    match provider.as_str() {
        "deepgram" => {
            let t0 = std::time::Instant::now();
            let resp = client
                .get("https://api.deepgram.com/v1/projects")
                .header("Authorization", format!("Token {}", api_key))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let elapsed = t0.elapsed().as_millis() as u32;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(elapsed)
        }
        "assemblyai" => {
            let t0 = std::time::Instant::now();
            let resp = client
                .get("https://api.assemblyai.com/v2/transcript?limit=1")
                .header("Authorization", api_key)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let elapsed = t0.elapsed().as_millis() as u32;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(elapsed)
        }
        stt::config::SENSEVOICE_PROVIDER => {
            let endpoint = resolve_sensevoice_endpoint(custom_base_url)?;
            let t0 = std::time::Instant::now();
            let resp = post_sensevoice_probe(endpoint, &client).await?;
            let elapsed = t0.elapsed().as_millis() as u32;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(elapsed)
        }
        _ => {
            let cfg = resolve_whisper_test_config(&provider, custom_base_url, custom_model)?;

            let silent_pcm = vec![0u8; 3200]; // 0.1s at 16kHz 16-bit mono
            let wav = stt::whisper_compat::WhisperCompatProvider::build_wav(&silent_pcm, 16000);

            let file_part = reqwest::multipart::Part::bytes(wav)
                .file_name("test.wav")
                .mime_str("audio/wav")
                .map_err(|e| e.to_string())?;
            let mut form = reqwest::multipart::Form::new()
                .text("model", cfg.model.clone())
                .part("file", file_part);
            for (key, value) in &cfg.extra_fields {
                form = form.text(key.clone(), value.clone());
            }

            let t0 = std::time::Instant::now();
            let mut request = client
                .post(&cfg.endpoint)
                .multipart(form)
                .timeout(std::time::Duration::from_secs(15));

            if !api_key.trim().is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }

            let resp = request.send().await.map_err(|e| e.to_string())?;
            let elapsed = t0.elapsed().as_millis() as u32;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(elapsed)
        }
    }
}
