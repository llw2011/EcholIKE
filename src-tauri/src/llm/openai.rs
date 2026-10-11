use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::Client;

use crate::error::AppError;

use super::{prompt, ChunkCallback, LlmConfig, LlmProvider, PolishRequest, PolishResponse};

pub struct OpenAiProvider {
    client: Client,
    provider_name: String,
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiProvider {
    pub fn new() -> Self {
        Self::with_client_for_provider("openai", Client::new())
    }

    pub fn with_client(client: Client) -> Self {
        Self::with_client_for_provider("openai", client)
    }

    pub fn with_client_for_provider(provider_name: &str, client: Client) -> Self {
        Self {
            client,
            provider_name: provider_name.to_string(),
        }
    }
}

fn http_base_url(base_url: &str) -> Result<String, AppError> {
    if base_url.trim().is_empty() {
        return Err(AppError::Config("LLM base URL is empty".to_string()));
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed)
        .map_err(|e| AppError::Config(format!("Invalid LLM base URL: {e}")))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(AppError::Config(
            "LLM base URL must use http or https scheme".to_string(),
        ));
    }

    Ok(trimmed.to_string())
}

fn url_origin(base_url: &str) -> Result<String, AppError> {
    let mut parsed = url::Url::parse(&http_base_url(base_url)?)
        .map_err(|e| AppError::Config(format!("Invalid LLM base URL: {e}")))?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn ollama_openai_base_url(base_url: &str) -> Result<String, AppError> {
    let base = http_base_url(base_url)?;
    let parsed = url::Url::parse(&base)
        .map_err(|e| AppError::Config(format!("Invalid LLM base URL: {e}")))?;
    let path = parsed.path().trim_end_matches('/');

    if path.is_empty() || path == "/api" || path == "/v" {
        Ok(format!("{}/v1", url_origin(&base)?))
    } else {
        Ok(base)
    }
}

fn openai_chat_url(provider_name: &str, base_url: &str) -> Result<String, AppError> {
    let base = if provider_name == "ollama" {
        ollama_openai_base_url(base_url)?
    } else {
        http_base_url(base_url)?
    };
    Ok(format!("{}/chat/completions", base))
}

fn extract_non_stream_answer(value: &serde_json::Value) -> String {
    value["choices"][0]["message"]["content"]
        .as_str()
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
        })
        .or_else(|| value.get("response").and_then(|response| response.as_str()))
        .unwrap_or("")
        .to_string()
}

fn normalized_translation_text(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || ('\u{3400}'..='\u{9fff}').contains(ch))
        .flat_map(char::to_lowercase)
        .collect()
}

fn count_latin_letters(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_ascii_alphabetic()).count()
}

fn count_chinese_characters(text: &str) -> usize {
    text.chars()
        .filter(|ch| ('\u{3400}'..='\u{9fff}').contains(ch))
        .count()
}

fn translation_output_needs_retry(source: &str, output: &str, target_lang: &str) -> bool {
    let normalized_source = normalized_translation_text(source);
    let normalized_output = normalized_translation_text(output);
    if normalized_output.is_empty() {
        return true;
    }
    let lowercase_output = output.to_ascii_lowercase();
    if output.contains("无法翻译")
        || output.contains("不能翻译")
        || output.contains("无法完成翻译")
        || lowercase_output.contains("cannot translate")
        || lowercase_output.contains("unable to translate")
        || lowercase_output.contains("can't translate")
    {
        return true;
    }
    if normalized_source.len() >= 8 && normalized_source == normalized_output {
        return true;
    }
    if normalized_source.len() >= 8
        && normalized_output.contains(&normalized_source)
        && normalized_output.len() <= normalized_source.len() + 24
    {
        return true;
    }

    match target_lang.trim().to_ascii_lowercase().as_str() {
        "zh" => count_latin_letters(source) >= 8 && count_chinese_characters(output) < 2,
        "en" => count_chinese_characters(source) >= 2 && count_latin_letters(output) < 4,
        _ => false,
    }
}

impl OpenAiProvider {
    async fn ollama_native_answer(
        &self,
        config: &LlmConfig,
        messages: Vec<serde_json::Value>,
        temperature: f64,
        disable_thinking: bool,
    ) -> Result<String, AppError> {
        let mut body = serde_json::json!({
            "model": config.model,
            "messages": messages,
            "stream": false,
            "options": {
                "num_predict": config.max_tokens,
                "temperature": temperature
            }
        });
        if disable_thinking {
            body["think"] = serde_json::json!(false);
        }

        let mut request = self
            .client
            .post(format!("{}/api/chat", url_origin(&config.base_url)?))
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(30));
        if !config.api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", config.api_key));
        }

        let resp = request.send().await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AppError::Api {
                status: status.as_u16(),
                body: text,
            });
        }

        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| AppError::Api {
            status: 200,
            body: e.to_string(),
        })?;
        Ok(extract_non_stream_answer(&value).trim().to_string())
    }

    async fn polish_ollama_native(
        &self,
        config: &LlmConfig,
        messages: Vec<serde_json::Value>,
        on_chunk: Option<&ChunkCallback>,
    ) -> Result<PolishResponse, AppError> {
        let text = self
            .ollama_native_answer(config, messages, config.temperature, false)
            .await?;
        if let Some(callback) = on_chunk {
            callback(&text);
        }

        Ok(PolishResponse {
            polished_text: text,
        })
    }

    async fn translate_ollama_native(
        &self,
        config: &LlmConfig,
        req: &PolishRequest,
        mut messages: Vec<serde_json::Value>,
        on_chunk: Option<&ChunkCallback>,
    ) -> Result<PolishResponse, AppError> {
        let source = req
            .selected_text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(&req.raw_text);
        let retry_instruction = prompt::translation_retry_instruction(&req.target_lang)
            .ok_or_else(|| AppError::Config("Invalid translation target language".to_string()))?;

        for attempt in 0..3 {
            let temperature = if attempt == 0 { 0.1 } else { 0.0 };
            let text = self
                .ollama_native_answer(config, messages.clone(), temperature, true)
                .await?;
            if !translation_output_needs_retry(source, &text, &req.target_lang) {
                if let Some(callback) = on_chunk {
                    callback(&text);
                }
                return Ok(PolishResponse {
                    polished_text: text,
                });
            }

            tracing::warn!(
                "Ollama translation output failed validation (attempt {}/3)",
                attempt + 1
            );
            if !text.is_empty() {
                messages.push(serde_json::json!({ "role": "assistant", "content": text }));
            }
            messages.push(serde_json::json!({
                "role": "user",
                "content": retry_instruction,
            }));
        }

        Err(AppError::Config(
            "Local model did not produce a valid translation after 3 attempts".to_string(),
        ))
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    async fn polish(
        &self,
        config: &LlmConfig,
        req: &PolishRequest,
        on_chunk: Option<&ChunkCallback>,
    ) -> Result<PolishResponse, AppError> {
        let has_selected_text = req
            .selected_text
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty());

        let system_prompt = prompt::build_system_prompt(
            req.app_type,
            &req.dictionary,
            req.translate_enabled,
            &req.target_lang,
            has_selected_text,
        );

        let mut messages = vec![serde_json::json!({ "role": "system", "content": system_prompt })];
        if has_selected_text {
            messages.push(serde_json::json!({
                "role": "user",
                "content": format!("<selected_text>\n{}\n</selected_text>", req.selected_text.as_ref().unwrap())
            }));
        }
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("<transcription>\n{}\n</transcription>", req.raw_text)
        }));

        if self.provider_name == "ollama"
            && req.translate_enabled
            && prompt::translation_language_name(&req.target_lang).is_some()
        {
            return self
                .translate_ollama_native(config, req, messages, on_chunk)
                .await;
        }

        let mut body = serde_json::json!({
            "model": config.model,
            "messages": messages.clone(),
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "stream": on_chunk.is_some()
        });

        // GLM-4.7/4.5/5 default to thinking mode, but without explicitly enabling it
        // the API may return content in reasoning_content only, leaving content empty.
        // Explicitly enable thinking so both fields are properly populated.
        // Thinking mode also requires temperature >= 0.6 (recommended 1.0).
        if config.model.starts_with("glm-") {
            if let Some(obj) = body.as_object_mut() {
                obj.insert(
                    "thinking".to_string(),
                    serde_json::json!({"type": "enabled"}),
                );
                obj.insert("temperature".to_string(), serde_json::json!(1.0));
                obj.insert("top_p".to_string(), serde_json::json!(0.95));
            }
        }

        // Retry the initial connection (not once streaming starts)
        #[allow(unused_assignments)]
        let mut response = None;
        let mut last_error: Option<AppError> = None;
        let mut attempt = 0u32;

        loop {
            let mut request = self
                .client
                .post(openai_chat_url(&self.provider_name, &config.base_url)?)
                .header("Content-Type", "application/json")
                .json(&body)
                .timeout(std::time::Duration::from_secs(15));
            if !config.api_key.trim().is_empty() {
                request = request.header("Authorization", format!("Bearer {}", config.api_key));
            }

            match request.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        response = Some(resp);
                        break;
                    } else if status.as_u16() >= 500 && attempt < 2 {
                        let body_text = resp.text().await.unwrap_or_default();
                        tracing::warn!(
                            "LLM server error {} (attempt {}/3), retrying",
                            status,
                            attempt + 1
                        );
                        last_error = Some(AppError::Api {
                            status: status.as_u16(),
                            body: body_text,
                        });
                        attempt += 1;
                        tokio::time::sleep(std::time::Duration::from_millis(
                            1000 * 2u64.pow(attempt - 1),
                        ))
                        .await;
                        continue;
                    } else {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        if self.provider_name == "ollama" {
                            match self
                                .polish_ollama_native(config, messages.clone(), on_chunk)
                                .await
                            {
                                Ok(response) => return Ok(response),
                                Err(error) => {
                                    tracing::warn!("Ollama native chat fallback failed: {}", error);
                                }
                            }
                        }
                        // Truncate at a valid UTF-8 char boundary to avoid panic on multi-byte chars
                        let truncate_at = text
                            .char_indices()
                            .take_while(|&(i, _)| i < 200)
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(text.len());
                        let sanitized = &text[..truncate_at];
                        return Err(AppError::Api {
                            status: status.as_u16(),
                            body: sanitized.to_string(),
                        });
                    }
                }
                Err(e) if e.is_timeout() && attempt < 2 => {
                    tracing::warn!(
                        "LLM connection timeout (attempt {}/3), retrying",
                        attempt + 1
                    );
                    last_error = Some(e.into());
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                    continue;
                }
                Err(e) if e.is_connect() && attempt < 2 => {
                    tracing::warn!(
                        "LLM connection failed (attempt {}/3), retrying",
                        attempt + 1
                    );
                    last_error = Some(e.into());
                    attempt += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        1000 * 2u64.pow(attempt - 1),
                    ))
                    .await;
                    continue;
                }
                Err(e) => return Err(e.into()),
            }
        }

        let response = response.ok_or_else(|| last_error.unwrap())?;

        if let Some(callback) = on_chunk {
            // Streaming mode
            let mut full_text = String::new();
            let mut reasoning_text = String::new();
            let mut stream = response.bytes_stream();

            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));

                // Process SSE lines
                while let Some(line_end) = buffer.find('\n') {
                    let line = buffer[..line_end].trim().to_string();
                    buffer = buffer[line_end + 1..].to_string();

                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            break;
                        }
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                            let delta = &v["choices"][0]["delta"];

                            if let Some(content) = delta["content"].as_str() {
                                if !content.is_empty() {
                                    full_text.push_str(content);
                                    callback(content);
                                }
                            }

                            // Collect reasoning_content as fallback for thinking-mode models
                            // where all output may land in this field instead of content
                            if let Some(rc) = delta["reasoning_content"].as_str() {
                                if !rc.is_empty() {
                                    reasoning_text.push_str(rc);
                                }
                            }
                        }
                    }
                }
            }

            // If content was empty but reasoning_content had text, use it as output.
            // This handles GLM thinking-mode where the API puts all output in reasoning_content.
            if full_text.is_empty() && !reasoning_text.is_empty() {
                tracing::warn!(
                    "LLM content empty, using reasoning_content ({} chars) as output",
                    reasoning_text.len()
                );
                callback(&reasoning_text);
                full_text = reasoning_text;
            } else if full_text.is_empty() {
                tracing::error!("LLM streaming returned no content and no reasoning_content");
            }

            Ok(PolishResponse {
                polished_text: full_text,
            })
        } else {
            // Non-streaming mode
            let v: serde_json::Value = response.json().await?;
            let text = extract_non_stream_answer(&v);

            if text.is_empty() {
                tracing::warn!("LLM non-streaming returned empty content");
            }

            Ok(PolishResponse {
                polished_text: text,
            })
        }
    }

    fn name(&self) -> &str {
        "OpenAI"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_openai_chat_url_accepts_host_v_and_v1() {
        assert_eq!(
            openai_chat_url("ollama", "http://localhost:11434").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_url("ollama", "http://localhost:11434/v").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_url("ollama", "http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn extracts_ollama_native_non_stream_answer() {
        let value = serde_json::json!({
            "message": { "content": " native answer " },
            "done": true
        });
        assert_eq!(extract_non_stream_answer(&value), " native answer ");
    }

    #[test]
    fn detects_unchanged_or_wrong_script_translations() {
        let english = "Please send the final report tomorrow.";
        assert!(translation_output_needs_retry(english, english, "zh"));
        assert!(translation_output_needs_retry(
            english,
            "Please send the report tomorrow morning.",
            "zh"
        ));
        assert!(translation_output_needs_retry(
            english,
            "无法翻译：Please send the final report tomorrow.",
            "zh"
        ));
        assert!(!translation_output_needs_retry(
            english,
            "请明天发送最终报告。",
            "zh"
        ));

        let chinese = "请明天发送最终报告。";
        assert!(translation_output_needs_retry(chinese, chinese, "en"));
        assert!(!translation_output_needs_retry(
            chinese,
            "Please send the final report tomorrow.",
            "en"
        ));
    }
}
