use async_trait::async_trait;

use crate::error::AppError;

use super::{
    config, whisper_compat::WhisperCompatProvider, SttConfig, SttProvider, TranscriptEvent,
};

const MAX_AUDIO_BYTES: usize = 24 * 1024 * 1024;

/// Local SenseVoice/FunASR HTTP provider.
///
/// The local service exposes `POST /asr` with multipart fields:
/// - `file`: audio file
/// - `language`: optional language hint, defaults to `auto`
pub struct SenseVoiceProvider {
    endpoint: Option<String>,
    stt_config: Option<SttConfig>,
    audio_buffer: Vec<u8>,
    client: reqwest::Client,
}

impl SenseVoiceProvider {
    pub fn new() -> Self {
        Self {
            endpoint: None,
            stt_config: None,
            audio_buffer: Vec::new(),
            client: reqwest::Client::new(),
        }
    }

    pub fn with_client(client: reqwest::Client) -> Self {
        Self {
            endpoint: None,
            stt_config: None,
            audio_buffer: Vec::new(),
            client,
        }
    }
}

fn parse_sensevoice_text(body: &str) -> Result<String, AppError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| AppError::Config(e.to_string()))?;
    Ok(v["text"].as_str().unwrap_or("").trim().to_string())
}

#[async_trait]
impl SttProvider for SenseVoiceProvider {
    async fn connect(&mut self, config: &SttConfig) -> Result<(), AppError> {
        let endpoint = config::normalize_sensevoice_endpoint(
            config
                .local_base_url
                .as_deref()
                .unwrap_or(config::DEFAULT_SENSEVOICE_BASE_URL),
        )
        .map_err(AppError::Config)?;

        self.endpoint = Some(endpoint);
        self.stt_config = Some(config.clone());
        self.audio_buffer.clear();
        tracing::info!("SenseVoice local provider ready");
        Ok(())
    }

    async fn send_audio(&mut self, chunk: &[u8]) -> Result<(), AppError> {
        if self.audio_buffer.len() + chunk.len() > MAX_AUDIO_BYTES {
            return Err(AppError::Config(
                "SenseVoice: audio exceeds maximum length (~12 min)".to_string(),
            ));
        }
        self.audio_buffer.extend_from_slice(chunk);
        Ok(())
    }

    async fn recv_transcript(&mut self) -> Result<Option<TranscriptEvent>, AppError> {
        std::future::pending().await
    }

    async fn disconnect(&mut self) -> Result<Option<String>, AppError> {
        let config = match &self.stt_config {
            Some(c) => c.clone(),
            None => return Ok(None),
        };
        let endpoint = match &self.endpoint {
            Some(endpoint) => endpoint.clone(),
            None => return Ok(None),
        };

        if self.audio_buffer.is_empty() {
            tracing::info!("SenseVoice: no audio buffered, skipping");
            return Ok(None);
        }

        let audio_len_secs = self.audio_buffer.len() as f64 / (config.sample_rate as f64 * 2.0);
        let wav_data = WhisperCompatProvider::build_wav(&self.audio_buffer, config.sample_rate);
        self.audio_buffer.clear();
        tracing::info!("SenseVoice: sending {:.1}s of audio", audio_len_secs);

        let file_part = reqwest::multipart::Part::bytes(wav_data)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| AppError::Config(e.to_string()))?;

        let language = config.language.as_deref().unwrap_or("auto");
        let form = reqwest::multipart::Form::new()
            .part("file", file_part)
            .text("language", language.to_string());

        let resp = self
            .client
            .post(endpoint)
            .multipart(form)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            let truncate_at = body
                .char_indices()
                .take_while(|&(i, _)| i < 200)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(body.len());
            return Err(AppError::Api {
                status: status.as_u16(),
                body: body[..truncate_at].to_string(),
            });
        }

        let text = parse_sensevoice_text(&body)?;
        tracing::info!("SenseVoice transcription: {} chars", text.len());
        Ok(if text.is_empty() { None } else { Some(text) })
    }

    fn name(&self) -> &str {
        "SenseVoice Local"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_field() {
        let text = parse_sensevoice_text(r#"{"text":"你好","raw":"ignored"}"#).unwrap();
        assert_eq!(text, "你好");
    }

    #[tokio::test]
    async fn connect_uses_default_local_endpoint() {
        let mut provider = SenseVoiceProvider::new();
        provider.connect(&SttConfig::default()).await.unwrap();
        assert_eq!(
            provider.endpoint.as_deref(),
            Some("http://127.0.0.1:9001/asr")
        );
    }
}
