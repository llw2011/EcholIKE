use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::error::AppError;

use super::{SttConfig, SttProvider, TranscriptEvent};

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct DeepgramProvider {
    ws: Option<WsStream>,
}

impl Default for DeepgramProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl DeepgramProvider {
    pub fn new() -> Self {
        Self { ws: None }
    }

    fn build_url(config: &SttConfig) -> String {
        let lang = config.language.as_deref().unwrap_or("multi");
        format!(
            "wss://api.deepgram.com/v1/listen?\
             model=nova-3&\
             smart_format={}&\
             language={}&\
             punctuate=true&\
             utterances=true&\
             interim_results=true&\
             endpointing=150&\
             encoding=linear16&\
             sample_rate={}&\
             channels=1",
            config.smart_format, lang, config.sample_rate
        )
    }
}

fn parse_transcript_message(text: &str) -> Result<Option<TranscriptEvent>, AppError> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| AppError::Config(e.to_string()))?;

    if v.get("type").and_then(|t| t.as_str()) == Some("Error") {
        let msg = v["message"].as_str().unwrap_or("Unknown error").to_string();
        return Ok(Some(TranscriptEvent::Error { message: msg }));
    }

    let transcript = v["channel"]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if transcript.is_empty() {
        return Ok(None);
    }

    let is_final = v["is_final"].as_bool().unwrap_or(false);

    if is_final {
        let confidence = v["channel"]["alternatives"][0]["confidence"]
            .as_f64()
            .unwrap_or(0.0) as f32;

        return Ok(Some(TranscriptEvent::Final {
            text: transcript,
            confidence,
        }));
    }

    Ok(Some(TranscriptEvent::Partial { text: transcript }))
}

#[async_trait]
impl SttProvider for DeepgramProvider {
    async fn connect(&mut self, config: &SttConfig) -> Result<(), AppError> {
        let url = Self::build_url(config);

        let mut attempt = 0u32;
        loop {
            let request = http::Request::builder()
                .uri(&url)
                .header("Authorization", format!("Token {}", config.api_key))
                .header("Host", "api.deepgram.com")
                .header("Connection", "Upgrade")
                .header("Upgrade", "websocket")
                .header("Sec-WebSocket-Version", "13")
                .header(
                    "Sec-WebSocket-Key",
                    tokio_tungstenite::tungstenite::handshake::client::generate_key(),
                )
                .body(())
                .map_err(|e| AppError::Config(e.to_string()))?;

            match connect_async(request).await {
                Ok((ws, _)) => {
                    self.ws = Some(ws);
                    tracing::info!("Deepgram WebSocket connected");
                    return Ok(());
                }
                Err(e) if attempt < 2 => {
                    tracing::warn!("Deepgram connect failed (attempt {}/3): {}", attempt + 1, e);
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                }
                Err(e) => return Err(AppError::Network(e.to_string())),
            }
        }
    }

    async fn send_audio(&mut self, chunk: &[u8]) -> Result<(), AppError> {
        if let Some(ws) = &mut self.ws {
            ws.send(Message::Binary(chunk.to_vec()))
                .await
                .map_err(|e| AppError::Network(e.to_string()))?;
        }
        Ok(())
    }

    async fn recv_transcript(&mut self) -> Result<Option<TranscriptEvent>, AppError> {
        let ws = match &mut self.ws {
            Some(ws) => ws,
            None => return Ok(None),
        };

        match ws.next().await {
            Some(Ok(Message::Text(text))) => parse_transcript_message(&text),
            Some(Ok(Message::Close(_))) => {
                tracing::info!("Deepgram WebSocket closed");
                Ok(None)
            }
            Some(Err(e)) => {
                tracing::error!("Deepgram WebSocket error: {}", e);
                Ok(Some(TranscriptEvent::Error {
                    message: e.to_string(),
                }))
            }
            _ => Ok(None),
        }
    }

    async fn disconnect(&mut self) -> Result<Option<String>, AppError> {
        if let Some(ws) = &mut self.ws {
            let close_msg = serde_json::json!({"type": "CloseStream"});
            let _ = ws.send(Message::Text(close_msg.to_string())).await;
            let _ = ws.close(None).await;
        }
        self.ws = None;
        tracing::info!("Deepgram disconnected");
        Ok(None)
    }

    fn name(&self) -> &str {
        "Deepgram Nova-3"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_speech_final_message_as_final_transcript() {
        let message = serde_json::json!({
            "is_final": true,
            "speech_final": true,
            "channel": {
                "alternatives": [{
                    "transcript": "hello world",
                    "confidence": 0.97
                }]
            }
        })
        .to_string();

        let event = parse_transcript_message(&message).unwrap();

        match event {
            Some(TranscriptEvent::Final { text, confidence }) => {
                assert_eq!(text, "hello world");
                assert!((confidence - 0.97).abs() < f32::EPSILON);
            }
            other => panic!("expected final transcript, got {other:?}"),
        }
    }

    #[test]
    fn parses_empty_transcript_as_none() {
        let message = serde_json::json!({
            "is_final": true,
            "speech_final": true,
            "channel": {
                "alternatives": [{
                    "transcript": "",
                    "confidence": 0.0
                }]
            }
        })
        .to_string();

        assert!(parse_transcript_message(&message).unwrap().is_none());
    }
}
