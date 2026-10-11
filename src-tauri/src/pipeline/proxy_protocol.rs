use anyhow::Result;

pub(super) const PROXY_LLM_STREAM_MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub(super) struct IncompleteProxyLlmStream(pub(super) &'static str);

impl std::fmt::Display for IncompleteProxyLlmStream {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for IncompleteProxyLlmStream {}

#[derive(Debug)]
pub(super) struct BackendSttUserError(pub(super) &'static str);

impl std::fmt::Display for BackendSttUserError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("backend STT request rejected")
    }
}

impl std::error::Error for BackendSttUserError {}

pub(super) fn backend_stt_error_code(
    status: reqwest::StatusCode,
    body: &str,
) -> Option<&'static str> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Some("backend_auth_expired");
    }

    let response_code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("code")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        });
    match response_code.as_deref() {
        Some("stt_quota_exceeded") => return Some("stt_quota_exceeded"),
        Some("stt_invalid_key") => return Some("stt_invalid_key"),
        Some("stt_timeout") => return Some("stt_timeout"),
        Some("stt_no_speech_detected") => return Some("stt_no_speech_detected"),
        Some("stt_failed") => return Some("stt_failed"),
        _ => {}
    }

    (status == reqwest::StatusCode::FORBIDDEN).then_some("backend_stt_unavailable")
}

fn extract_proxy_llm_stream_content(line: &str) -> (String, String) {
    let data = line
        .strip_prefix("data: ")
        .or_else(|| line.strip_prefix("data:"))
        .map(str::trim);
    let Some(data) = data else {
        return (String::new(), String::new());
    };
    if data.is_empty() || data == "[DONE]" {
        return (String::new(), String::new());
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return (String::new(), String::new());
    };
    let delta = &value["choices"][0]["delta"];
    let content = delta["content"].as_str().unwrap_or_default().to_string();
    let reasoning = delta["reasoning_content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (content, reasoning)
}

pub(super) fn parse_complete_proxy_llm_stream(text: &str) -> Result<(Vec<String>, String)> {
    let mut content_chunks = Vec::new();
    let mut full_text = String::new();
    let mut reasoning_text = String::new();
    let mut done = false;
    for line in text.lines() {
        let data = line
            .strip_prefix("data: ")
            .or_else(|| line.strip_prefix("data:"))
            .map(str::trim);
        if data == Some("[DONE]") {
            done = true;
            break;
        }
        let (content, reasoning) = extract_proxy_llm_stream_content(line.trim());
        if !content.is_empty() {
            full_text.push_str(&content);
            content_chunks.push(content);
        }
        if !reasoning.is_empty() {
            reasoning_text.push_str(&reasoning);
        }
    }
    if !done {
        return Err(IncompleteProxyLlmStream("Cloud LLM stream ended before [DONE]").into());
    }
    if full_text.is_empty() && !reasoning_text.is_empty() {
        full_text = reasoning_text;
        content_chunks.push(full_text.clone());
    }
    Ok((content_chunks, full_text))
}

pub(super) fn wav_from_pcm_16khz_mono(pcm: &[u8]) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&32_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

pub(super) fn parse_proxy_stt_transcript(body: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(body)?;
    let transcript = value
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if transcript.is_empty() {
        return Err(BackendSttUserError("stt_no_speech_detected").into());
    }
    Ok(transcript)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_stt_http_access_errors_keep_account_semantics() {
        assert_eq!(
            backend_stt_error_code(reqwest::StatusCode::UNAUTHORIZED, "{}"),
            Some("backend_auth_expired")
        );
        assert_eq!(
            backend_stt_error_code(
                reqwest::StatusCode::FORBIDDEN,
                r#"{"code":"stt_quota_exceeded"}"#,
            ),
            Some("stt_quota_exceeded")
        );
        assert_eq!(
            backend_stt_error_code(reqwest::StatusCode::FORBIDDEN, r#"{"code":"forbidden"}"#),
            Some("backend_stt_unavailable")
        );
        assert_eq!(
            backend_stt_error_code(reqwest::StatusCode::TOO_MANY_REQUESTS, "{}"),
            None
        );
    }

    #[test]
    fn proxy_llm_stream_parser_extracts_content_and_reasoning() {
        let (content, reasoning) = extract_proxy_llm_stream_content(
            r#"data: {"choices":[{"delta":{"content":"hello"}}]}"#,
        );
        assert_eq!(content, "hello");
        assert!(reasoning.is_empty());

        let (content, reasoning) = extract_proxy_llm_stream_content(
            r#"data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#,
        );
        assert!(content.is_empty());
        assert_eq!(reasoning, "thinking");

        let (content, reasoning) = extract_proxy_llm_stream_content("data: [DONE]");
        assert!(content.is_empty());
        assert!(reasoning.is_empty());
    }

    #[test]
    fn complete_proxy_stream_preserves_multibyte_text_and_requires_done() {
        let stream = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n";
        let bytes = stream.as_bytes();
        let split_inside_chinese = bytes
            .windows("你".len())
            .position(|window| window == "你".as_bytes())
            .unwrap()
            + 1;
        let rebuilt = [
            &bytes[..split_inside_chinese],
            &bytes[split_inside_chinese..],
        ]
        .concat();
        let decoded = String::from_utf8(rebuilt).unwrap();
        let (chunks, full_text) = parse_complete_proxy_llm_stream(&decoded).unwrap();
        assert_eq!(chunks, vec!["你好"]);
        assert_eq!(full_text, "你好");

        let incomplete = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n";
        assert!(parse_complete_proxy_llm_stream(incomplete).is_err());
        assert_eq!(PROXY_LLM_STREAM_MAX_BYTES, 8 * 1024 * 1024);
    }

    #[test]
    fn wav_header_and_payload_match_16khz_mono_pcm_contract() {
        let wav = wav_from_pcm_16khz_mono(&[0x00, 0x80, 0xff, 0x7f]);

        assert_eq!(
            wav.as_slice(),
            &[
                0x52, 0x49, 0x46, 0x46, 0x28, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d,
                0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00,
                0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x04, 0x00,
                0x00, 0x00, 0x00, 0x80, 0xff, 0x7f,
            ]
        );
    }

    #[test]
    fn proxy_empty_transcript_uses_the_same_no_speech_code_as_local_stt() {
        let error = parse_proxy_stt_transcript(r#"{"text":"  "}"#).unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<BackendSttUserError>()
                .map(|error| error.0),
            Some("stt_no_speech_detected")
        );
        assert_eq!(
            parse_proxy_stt_transcript(r#"{"text":" 你好 "}"#).unwrap(),
            "你好"
        );
    }
}
