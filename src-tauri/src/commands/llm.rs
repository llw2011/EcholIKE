fn build_chat_messages(question: &str, context: Option<String>) -> Vec<serde_json::Value> {
    let mut system_prompt =
        "You are EcholIKE, a desktop assistant. Answer directly, keep it practical, and avoid unnecessary fluff."
            .to_string();
    if let Some(context) = context.filter(|value| !value.trim().is_empty()) {
        system_prompt.push_str("\n\nCurrent desktop context:\n");
        system_prompt.push_str(context.trim());
    }

    vec![
        serde_json::json!({
            "role": "system",
            "content": system_prompt,
        }),
        serde_json::json!({
            "role": "user",
            "content": question.trim()
        }),
    ]
}

fn extract_chat_answer(body: &serde_json::Value) -> Option<String> {
    body.get("choices")
        .and_then(|value| value.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
                .or_else(|| choice.get("text").and_then(|text| text.as_str()))
        })
        .or_else(|| {
            body.get("message")
                .and_then(|message| message.get("content"))
                .and_then(|content| content.as_str())
        })
        .or_else(|| body.get("response").and_then(|response| response.as_str()))
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn llm_provider_requires_api_key(provider: &str) -> bool {
    provider != "ollama"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatProtocol {
    OpenAiCompatible,
    OllamaNative,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatEndpoint {
    url: String,
    protocol: ChatProtocol,
}

fn http_base_url(base_url: &str) -> Result<String, String> {
    if base_url.trim().is_empty() {
        return Err("Base URL is empty".to_string());
    }

    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("Invalid base URL: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Base URL must use http or https scheme".to_string());
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Base URL must not contain credentials, query, or fragment".to_string());
    }

    Ok(trimmed.to_string())
}

fn url_origin(base_url: &str) -> Result<String, String> {
    let mut parsed =
        url::Url::parse(&http_base_url(base_url)?).map_err(|e| format!("Invalid base URL: {e}"))?;
    parsed.set_path("");
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn ollama_openai_base_url(base_url: &str) -> Result<String, String> {
    let base = http_base_url(base_url)?;
    let parsed = url::Url::parse(&base).map_err(|e| format!("Invalid base URL: {e}"))?;
    let path = parsed.path().trim_end_matches('/');

    if path.is_empty() || path == "/api" || path == "/v" {
        Ok(format!("{}/v1", url_origin(&base)?))
    } else {
        Ok(base)
    }
}

fn openai_base_url(provider: &str, base_url: &str) -> Result<String, String> {
    if provider == "ollama" {
        ollama_openai_base_url(base_url)
    } else {
        http_base_url(base_url)
    }
}

fn chat_endpoints(provider: &str, base_url: &str) -> Result<Vec<ChatEndpoint>, String> {
    let mut endpoints = vec![ChatEndpoint {
        url: format!("{}/chat/completions", openai_base_url(provider, base_url)?),
        protocol: ChatProtocol::OpenAiCompatible,
    }];

    if provider == "ollama" {
        let native = ChatEndpoint {
            url: format!("{}/api/chat", url_origin(base_url)?),
            protocol: ChatProtocol::OllamaNative,
        };
        if endpoints.iter().all(|endpoint| endpoint.url != native.url) {
            endpoints.push(native);
        }
    }

    Ok(endpoints)
}

fn models_urls(provider: &str, base_url: &str) -> Result<Vec<String>, String> {
    let mut urls = vec![format!("{}/models", openai_base_url(provider, base_url)?)];

    if provider == "ollama" {
        let native = format!("{}/api/tags", url_origin(base_url)?);
        if !urls.contains(&native) {
            urls.push(native);
        }
    }

    Ok(urls)
}

fn chat_body(
    endpoint: &ChatEndpoint,
    model: &str,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
    temperature: Option<f64>,
) -> serde_json::Value {
    match endpoint.protocol {
        ChatProtocol::OpenAiCompatible => {
            let mut body = serde_json::json!({
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "stream": false
            });
            if let Some(temperature) = temperature {
                body["temperature"] = serde_json::json!(temperature);
            }
            body
        }
        ChatProtocol::OllamaNative => {
            let mut body = serde_json::json!({
                "model": model,
                "messages": messages,
                "stream": false,
                "options": {
                    "num_predict": max_tokens
                }
            });
            if let Some(temperature) = temperature {
                body["options"]["temperature"] = serde_json::json!(temperature);
            }
            body
        }
    }
}

fn extract_model_names(body: &serde_json::Value) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();

    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                models.push(id.to_string());
            }
        }
    } else if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                models.push(name.to_string());
            }
        }
    }

    models.sort();
    models
}

#[tauri::command]
pub async fn fetch_llm_models(
    api_key: String,
    provider: String,
    base_url: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<Vec<String>, String> {
    if base_url.is_empty() {
        return Ok(vec![]);
    }

    let client = client.client()?;
    let mut last_error: Option<String> = None;

    for url in models_urls(&provider, &base_url)? {
        let mut request = client.get(&url).timeout(std::time::Duration::from_secs(10));
        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key));
        }

        match request.send().await {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
                let models = extract_model_names(&body);
                if !models.is_empty() {
                    return Ok(models);
                }
            }
            Ok(_) => {}
            Err(e) => last_error = Some(e.to_string()),
        }
    }

    if let Some(error) = last_error {
        Err(error)
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
pub async fn bench_llm_connection(
    api_key: String,
    provider: String,
    base_url: String,
    model: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<u32, String> {
    if provider.is_empty() {
        return Err("No provider specified".to_string());
    }

    if llm_provider_requires_api_key(&provider) && api_key.is_empty() {
        return Err("API key or base URL is empty".to_string());
    }

    let client = client.client()?;
    let mut last_error: Option<String> = None;
    for endpoint in chat_endpoints(&provider, &base_url)? {
        let body = chat_body(
            &endpoint,
            &model,
            vec![serde_json::json!({"role": "user", "content": "hi"})],
            1,
            None,
        );
        let t0 = std::time::Instant::now();
        let mut request = client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(15));
        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key));
        }
        match request.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(t0.elapsed().as_millis() as u32),
            Ok(resp) => last_error = Some(format!("HTTP {}", resp.status())),
            Err(e) => last_error = Some(e.to_string()),
        }
    }

    Err(last_error.unwrap_or_else(|| "LLM test failed".to_string()))
}

#[tauri::command]
pub async fn ask_llm_once(
    question: String,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
    context: Option<String>,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<String, String> {
    ask_llm_once_inner(
        question,
        provider,
        api_key,
        base_url,
        model,
        context,
        client.inner(),
    )
    .await
}

pub(crate) async fn ask_llm_once_inner(
    question: String,
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
    context: Option<String>,
    client: &crate::network::NetworkClient,
) -> Result<String, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("Question is empty".to_string());
    }

    if llm_provider_requires_api_key(&provider) && api_key.is_empty() {
        return Err("API key is empty".to_string());
    }
    let client = client.client()?;
    let mut last_error: Option<String> = None;
    for endpoint in chat_endpoints(&provider, &base_url)? {
        let body = chat_body(
            &endpoint,
            &model,
            build_chat_messages(question, context.clone()),
            512,
            Some(0.2),
        );
        let mut request = client
            .post(&endpoint.url)
            .header("Content-Type", "application/json")
            .json(&body)
            .timeout(std::time::Duration::from_secs(30));
        if !api_key.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", api_key));
        }
        let resp = match request.send().await {
            Ok(resp) => resp,
            Err(e) => {
                last_error = Some(e.to_string());
                continue;
            }
        };

        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            last_error = Some(format!("HTTP {}: {}", status, text));
            continue;
        }

        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(answer) = extract_chat_answer(&value) {
            return Ok(answer);
        }
        last_error = Some("No answer returned from model".to_string());
    }

    Err(last_error.unwrap_or_else(|| "No answer returned from model".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_openai_chat_answer() {
        let body = serde_json::json!({
            "choices": [
                {
                    "message": {
                        "content": " EcholIKE answer "
                    }
                }
            ]
        });

        assert_eq!(
            extract_chat_answer(&body).as_deref(),
            Some("EcholIKE answer")
        );
    }

    #[test]
    fn chat_messages_include_optional_desktop_context() {
        let messages = build_chat_messages("what is this?", Some("Code / main.rs".to_string()));

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .is_some_and(|text| text.contains("Code / main.rs")));
        assert_eq!(messages[1]["content"], "what is this?");
    }

    #[test]
    fn chat_messages_keep_single_system_message_for_llama_cpp_templates() {
        let messages = build_chat_messages("again", Some("window ocr".to_string()));

        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == "system")
                .count(),
            1
        );
    }

    #[test]
    fn ollama_provider_does_not_require_api_key() {
        assert!(!llm_provider_requires_api_key("ollama"));
        assert!(llm_provider_requires_api_key("openrouter"));
    }

    #[test]
    fn openai_urls_trim_trailing_slashes() {
        assert_eq!(
            chat_endpoints("openrouter", "https://example.test/v1/")
                .unwrap()
                .first()
                .map(|endpoint| endpoint.url.as_str()),
            Some("https://example.test/v1/chat/completions")
        );
        assert_eq!(
            models_urls("openrouter", "https://example.test/v1/").unwrap(),
            vec!["https://example.test/v1/models".to_string()]
        );
    }

    #[test]
    fn ollama_urls_normalize_host_and_v_typo() {
        assert_eq!(
            chat_endpoints("ollama", "http://localhost:11434")
                .unwrap()
                .first()
                .map(|endpoint| endpoint.url.as_str()),
            Some("http://localhost:11434/v1/chat/completions")
        );
        assert_eq!(
            chat_endpoints("ollama", "http://localhost:11434/v")
                .unwrap()
                .first()
                .map(|endpoint| endpoint.url.as_str()),
            Some("http://localhost:11434/v1/chat/completions")
        );
        assert_eq!(
            models_urls("ollama", "http://localhost:11434/v1").unwrap(),
            vec![
                "http://localhost:11434/v1/models".to_string(),
                "http://localhost:11434/api/tags".to_string()
            ]
        );
    }

    #[test]
    fn ollama_chat_endpoints_keep_native_fallback() {
        assert_eq!(
            chat_endpoints("ollama", "http://localhost:11434/v1").unwrap(),
            vec![
                ChatEndpoint {
                    url: "http://localhost:11434/v1/chat/completions".to_string(),
                    protocol: ChatProtocol::OpenAiCompatible,
                },
                ChatEndpoint {
                    url: "http://localhost:11434/api/chat".to_string(),
                    protocol: ChatProtocol::OllamaNative,
                }
            ]
        );
    }

    #[test]
    fn legacy_chat_url_test_keeps_openai_shape() {
        assert_eq!(
            chat_endpoints("openrouter", "https://example.test/v1/")
                .unwrap()
                .first()
                .map(|endpoint| endpoint.url.as_str())
                .unwrap(),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn rejects_non_http_base_url() {
        assert!(chat_endpoints("openrouter", "file:///tmp/model").is_err());
    }

    #[test]
    fn rejects_credentialed_or_parameterized_base_url() {
        assert!(chat_endpoints("openrouter", "https://user:password@example.test/v1").is_err());
        assert!(chat_endpoints("openrouter", "https://example.test/v1?token=secret").is_err());
    }

    #[test]
    fn extracts_openai_and_ollama_model_lists() {
        let openai = serde_json::json!({
            "data": [
                { "id": "z-model" },
                { "id": "a-model" }
            ]
        });
        assert_eq!(
            extract_model_names(&openai),
            vec!["a-model".to_string(), "z-model".to_string()]
        );

        let ollama = serde_json::json!({
            "models": [
                { "name": "local-model" }
            ]
        });
        assert_eq!(
            extract_model_names(&ollama),
            vec!["local-model".to_string()]
        );
    }

    #[test]
    fn extracts_ollama_native_chat_answer() {
        let ollama = serde_json::json!({
            "message": {
                "role": "assistant",
                "content": " local answer "
            },
            "done": true
        });
        assert_eq!(
            extract_chat_answer(&ollama),
            Some("local answer".to_string())
        );
    }
}
