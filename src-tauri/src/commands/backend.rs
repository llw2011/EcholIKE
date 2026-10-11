use serde::{Deserialize, Serialize};
use url::Url;

const MARKDOWN_SPEECH_CHUNK_MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const PROXY_JSON_MAX_BYTES: usize = 8 * 1024 * 1024;
const PROXY_TTS_MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const PROXY_RETRY_WINDOW: std::time::Duration = std::time::Duration::from_secs(45);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendAuthResult {
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTtsResult {
    pub audio_bytes: Vec<u8>,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTextResult {
    pub text: String,
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiErrorBody {
    code: Option<String>,
    message: Option<String>,
    error: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsDiagnosticResult {
    pub ok: bool,
    pub stage: String,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub message: String,
    pub request_id: Option<String>,
    pub mime_type: Option<String>,
    pub audio_bytes: Option<usize>,
    pub elapsed_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

fn tts_diagnostic_operation_id(succeeded_with_audio: bool, operation_id: &str) -> Option<String> {
    succeeded_with_audio.then(|| operation_id.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct StructuredBackendError {
    service: String,
    status: u16,
    code: Option<String>,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "requestId")]
    request_id: Option<String>,
}

fn http_url(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let parsed = Url::parse(trimmed).map_err(|_| format!("{label}地址不正确。"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{label}地址必须使用 http 或 https。"));
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!("{label}地址不能包含凭据、查询参数或片段。"));
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn proxy_endpoint(api_base_url: &str, path: &str) -> Result<String, String> {
    Ok(format!(
        "{}/{}",
        http_url(api_base_url, "后台")?,
        path.trim_start_matches('/')
    ))
}

fn ask_messages(question: &str, context: Option<String>) -> Vec<serde_json::Value> {
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
            "content": question.trim(),
        }),
    ]
}

fn auth_token_from_body(body: &serde_json::Value) -> Option<String> {
    let session = body.get("session");
    let data = body.get("data");
    let data_session = data.and_then(|value| value.get("session"));
    [
        body.get("token"),
        session.and_then(|value| value.get("token")),
        data.and_then(|value| value.get("token")),
        data_session.and_then(|value| value.get("token")),
    ]
    .into_iter()
    .flatten()
    .filter_map(serde_json::Value::as_str)
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn backend_error_details(
    status: reqwest::StatusCode,
    text: &str,
    fallback: &str,
) -> (Option<String>, String, Option<String>) {
    if let Ok(body) = serde_json::from_str::<ApiErrorBody>(text) {
        let request_id = body
            .request_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if body
            .code
            .as_deref()
            .is_some_and(|code| code.ends_with("_quota_exceeded"))
        {
            return (body.code, "quota exceeded".to_string(), request_id);
        }
        if let Some(message) = body
            .message
            .or(body.error)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return (body.code, message, request_id);
        }
        if let Some(code) = body
            .code
            .map(|value| value.replace('_', " "))
            .filter(|value| !value.trim().is_empty())
        {
            return (Some(code.replace(' ', "_")), code, request_id);
        }
    }

    let body = text.trim();
    if body.is_empty() {
        (None, format!("HTTP {}", status.as_u16()), None)
    } else if body.len() <= 240 {
        (None, format!("HTTP {} {}", status.as_u16(), body), None)
    } else {
        (None, fallback.to_string(), None)
    }
}

fn backend_error_message(status: reqwest::StatusCode, text: &str, fallback: &str) -> String {
    let (_, message, _) = backend_error_details(status, text, fallback);
    message
}

pub(super) fn structured_backend_error(
    service: &str,
    status: reqwest::StatusCode,
    text: &str,
    fallback: &str,
) -> String {
    let (code, message, request_id) = backend_error_details(status, text, fallback);
    serde_json::to_string(&StructuredBackendError {
        service: service.to_string(),
        status: status.as_u16(),
        code,
        message,
        request_id,
    })
    .unwrap_or_else(|_| fallback.to_string())
}

#[tauri::command]
pub fn acknowledge_idempotent_operation(
    operation_id: String,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<(), String> {
    registry.acknowledge(&operation_id)
}

#[tauri::command]
pub async fn backend_auth_sign_in(
    auth_url: String,
    email: String,
    password: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<BackendAuthResult, String> {
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("请填写后台账号和密码。".to_string());
    }

    let client = client.client()?;
    let response = client
        .post(http_url(&auth_url, "后台授权")?)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "email": email, "password": password }))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let header_token = response
        .headers()
        .get("set-auth-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(backend_error_message(status, &text, "后台授权失败。"));
    }

    let body = serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null);
    let token = header_token
        .or_else(|| auth_token_from_body(&body))
        .ok_or_else(|| "后台未返回桌面授权令牌。".to_string())?;

    Ok(BackendAuthResult { token })
}

#[tauri::command]
pub async fn ask_proxy_llm_once(
    api_base_url: String,
    token: String,
    question: String,
    context: Option<String>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<ProxyTextResult, String> {
    ask_proxy_llm_once_inner(
        api_base_url,
        token,
        question,
        context,
        "home-ask".to_string(),
        client.inner(),
        registry.inner(),
    )
    .await
}

pub(crate) async fn ask_proxy_llm_once_inner(
    api_base_url: String,
    token: String,
    question: String,
    context: Option<String>,
    operation_scope: String,
    client: &crate::network::NetworkClient,
    registry: &crate::idempotency::Registry,
) -> Result<ProxyTextResult, String> {
    if question.trim().is_empty() {
        return Err("问题内容为空。".to_string());
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("后台授权已失效，请重新登录。".to_string());
    }

    let client = client.client()?;
    let endpoint = proxy_endpoint(&api_base_url, "/proxy/llm")?;
    let body = serde_json::json!({
        "messages": ask_messages(&question, context),
    });
    let semantic_body = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
    let persistent_operation = registry.acquire_authenticated(
        &operation_scope,
        &api_base_url,
        &token,
        &[&semantic_body],
    )?;
    let response = crate::idempotency::execute_buffered_with_key(
        persistent_operation.root().to_string(),
        std::time::Duration::from_secs(90),
        PROXY_RETRY_WINDOW,
        PROXY_JSON_MAX_BYTES,
        || {
            client
                .post(&endpoint)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .json(&body)
        },
    )
    .await?;

    let status = response.status;
    let text = String::from_utf8(response.body)
        .map_err(|_| "Backend answer was not valid UTF-8".to_string())?;
    if !status.is_success() {
        if crate::idempotency::response_retires_operation(status, text.as_bytes()) {
            persistent_operation.retire()?;
        }
        return Err(backend_error_message(status, &text, "后台问答失败。"));
    }

    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| "后台问答返回格式异常，请稍后重试。".to_string())?;
    let answer = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "后台问答没有返回内容。".to_string())?;
    Ok(ProxyTextResult {
        text: answer.to_string(),
        operation_id: persistent_operation.root().to_string(),
    })
}

#[tauri::command]
pub async fn proxy_tts_once(
    api_base_url: String,
    token: String,
    text: String,
    voice: Option<String>,
    playback_lease_id: Option<u64>,
    window: tauri::WebviewWindow,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
    owners: tauri::State<'_, crate::process_ownership::ProcessOwners>,
) -> Result<ProxyTtsResult, String> {
    if let Some(lease_id) = playback_lease_id {
        if !owners.begin_tts_generation(lease_id, window.label()) {
            return Err("TTS 播放所有权已失效。".to_string());
        }
    }
    let result = proxy_tts_once_inner(
        api_base_url,
        token,
        text,
        voice,
        client.inner(),
        registry.inner(),
    )
    .await;
    if let Some(lease_id) = playback_lease_id {
        let _ = owners.finish_tts_generation(lease_id, result.is_ok());
    }
    result
}

async fn proxy_tts_once_inner(
    api_base_url: String,
    token: String,
    text: String,
    voice: Option<String>,
    client: &crate::network::NetworkClient,
    registry: &crate::idempotency::Registry,
) -> Result<ProxyTtsResult, String> {
    proxy_tts_with_options(
        api_base_url,
        token,
        text,
        voice,
        None,
        None,
        None,
        std::time::Duration::from_secs(90),
        None,
        Some(registry),
        client,
    )
    .await
}

pub(crate) async fn proxy_tts_wav_chunk(
    api_base_url: String,
    token: String,
    text: String,
    voice: Option<String>,
    speed_milli: u16,
    idempotency_key: String,
    client: &crate::network::NetworkClient,
) -> Result<Vec<u8>, String> {
    let result = proxy_tts_with_options(
        api_base_url,
        token,
        text,
        voice,
        Some("wav"),
        Some(f64::from(speed_milli) / 1_000.0),
        Some(MARKDOWN_SPEECH_CHUNK_MAX_AUDIO_BYTES),
        std::time::Duration::from_secs(130),
        Some(idempotency_key),
        None,
        client,
    )
    .await?;
    Ok(result.audio_bytes)
}

#[allow(clippy::too_many_arguments)]
async fn proxy_tts_with_options(
    api_base_url: String,
    token: String,
    text: String,
    voice: Option<String>,
    format: Option<&str>,
    speed: Option<f64>,
    max_audio_bytes: Option<usize>,
    timeout: std::time::Duration,
    idempotency_key: Option<String>,
    registry: Option<&crate::idempotency::Registry>,
    client: &crate::network::NetworkClient,
) -> Result<ProxyTtsResult, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可朗读的文本。".to_string());
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("后台授权已失效，请重新登录。".to_string());
    }

    let mut body = serde_json::json!({ "text": text });
    if let Some(voice) = voice
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        body["voice"] = serde_json::json!(voice);
    }
    if let Some(format) = format {
        body["format"] = serde_json::json!(format);
    }
    if let Some(speed) = speed {
        body["speed"] = serde_json::json!(speed);
    }

    let client = client.client()?;
    let endpoint = proxy_endpoint(&api_base_url, "/proxy/tts")?;
    let audio_limit = max_audio_bytes.unwrap_or(PROXY_TTS_MAX_AUDIO_BYTES);
    let persistent_operation = match (idempotency_key.as_ref(), registry) {
        (None, Some(registry)) => {
            let semantic_body = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
            Some(registry.acquire_authenticated("tts", &api_base_url, &token, &[&semantic_body])?)
        }
        (None, None) => return Err("TTS operation recovery is unavailable".to_string()),
        (Some(_), _) => None,
    };
    let operation_key = idempotency_key.unwrap_or_else(|| {
        persistent_operation
            .as_ref()
            .expect("persistent operation was acquired")
            .root()
            .to_string()
    });
    let operation_id = persistent_operation
        .as_ref()
        .map(|operation| operation.root().to_string());
    let build = || {
        client
            .post(&endpoint)
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .json(&body)
    };
    let response = crate::idempotency::execute_buffered_with_key(
        operation_key,
        timeout,
        PROXY_RETRY_WINDOW,
        audio_limit,
        build,
    )
    .await?;

    let status = response.status;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&response.body);
        if crate::idempotency::response_retires_operation(status, text.as_bytes()) {
            if let Some(operation) = &persistent_operation {
                operation.retire()?;
            }
        }
        return Err(structured_backend_error(
            "tts",
            status,
            text.as_ref(),
            "TTS 朗读失败。",
        ));
    }

    let mime_type = response
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("audio/mpeg")
        .to_string();
    let audio_bytes = response.body;
    if audio_bytes.is_empty() {
        return Err("TTS 没有返回可播放音频。".to_string());
    }

    Ok(ProxyTtsResult {
        audio_bytes,
        mime_type,
        operation_id,
    })
}

#[tauri::command]
pub async fn diagnose_tts_proxy(
    api_base_url: String,
    token: String,
    text: String,
    voice: Option<String>,
    client: tauri::State<'_, crate::network::NetworkClient>,
    registry: tauri::State<'_, crate::idempotency::Registry>,
) -> Result<TtsDiagnosticResult, String> {
    let started = std::time::Instant::now();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(TtsDiagnosticResult {
            ok: false,
            stage: "input".to_string(),
            http_status: None,
            code: Some("validation_failed".to_string()),
            message: "没有可朗读的文本。".to_string(),
            request_id: None,
            mime_type: None,
            audio_bytes: None,
            elapsed_ms: started.elapsed().as_millis(),
            operation_id: None,
        });
    }
    let token = token.trim().to_string();
    if token.is_empty() {
        return Ok(TtsDiagnosticResult {
            ok: false,
            stage: "auth".to_string(),
            http_status: None,
            code: Some("unauthorized".to_string()),
            message: "后台授权已失效，请重新登录。".to_string(),
            request_id: None,
            mime_type: None,
            audio_bytes: None,
            elapsed_ms: started.elapsed().as_millis(),
            operation_id: None,
        });
    }

    let endpoint = proxy_endpoint(&api_base_url, "/proxy/tts")?;
    let mut body = serde_json::json!({ "text": text });
    if let Some(voice) = voice
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        body["voice"] = serde_json::json!(voice);
    }

    let client = client.client()?;
    let semantic_body = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
    let persistent_operation = registry.acquire_authenticated(
        "tts-diagnostic",
        &api_base_url,
        &token,
        &[&semantic_body],
    )?;
    let operation_id = persistent_operation.root().to_string();
    let response = match crate::idempotency::execute_buffered_with_key(
        persistent_operation.root().to_string(),
        std::time::Duration::from_secs(120),
        PROXY_RETRY_WINDOW,
        PROXY_TTS_MAX_AUDIO_BYTES,
        || {
            client
                .post(&endpoint)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .json(&body)
        },
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            return Ok(TtsDiagnosticResult {
                ok: false,
                stage: "network".to_string(),
                http_status: None,
                code: Some("network_error".to_string()),
                message: error,
                request_id: None,
                mime_type: None,
                audio_bytes: None,
                elapsed_ms: started.elapsed().as_millis(),
                operation_id: tts_diagnostic_operation_id(false, &operation_id),
            });
        }
    };

    let status = response.status;
    let mime_type = response
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if !status.is_success() {
        let body = String::from_utf8_lossy(&response.body);
        if crate::idempotency::response_retires_operation(status, body.as_bytes()) {
            persistent_operation.retire()?;
        }
        let (code, message, request_id) = backend_error_details(status, &body, "TTS 朗读失败。");
        return Ok(TtsDiagnosticResult {
            ok: false,
            stage: "http".to_string(),
            http_status: Some(status.as_u16()),
            code,
            message,
            request_id,
            mime_type,
            audio_bytes: None,
            elapsed_ms: started.elapsed().as_millis(),
            operation_id: tts_diagnostic_operation_id(false, &operation_id),
        });
    }

    let audio_bytes = response.body.len();
    Ok(TtsDiagnosticResult {
        ok: audio_bytes > 0,
        stage: if audio_bytes > 0 { "audio" } else { "empty" }.to_string(),
        http_status: Some(status.as_u16()),
        code: None,
        message: if audio_bytes > 0 {
            "TTS 代理返回了可播放音频。"
        } else {
            "TTS 代理返回了空音频。"
        }
        .to_string(),
        request_id: None,
        mime_type,
        audio_bytes: Some(audio_bytes),
        elapsed_ms: started.elapsed().as_millis(),
        operation_id: tts_diagnostic_operation_id(audio_bytes > 0, &operation_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_auth_token_from_common_body_shapes() {
        assert_eq!(
            auth_token_from_body(&serde_json::json!({ "token": "root-token" })).as_deref(),
            Some("root-token")
        );
        assert_eq!(
            auth_token_from_body(
                &serde_json::json!({ "data": { "session": { "token": "nested-token" } } })
            )
            .as_deref(),
            Some("nested-token")
        );
    }

    #[test]
    fn backend_error_maps_quota_code_to_readable_raw_message() {
        let message = backend_error_message(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            r#"{"code":"tts_quota_exceeded","message":"TTS quota exceeded"}"#,
            "TTS 朗读失败。",
        );

        assert_eq!(message, "quota exceeded");
    }

    #[test]
    fn structured_backend_error_preserves_ocr_diagnostics() {
        let error = structured_backend_error(
            "ocr",
            reqwest::StatusCode::GATEWAY_TIMEOUT,
            r#"{"code":"ocr_timeout","message":"Cloud OCR timed out","requestId":"req-123"}"#,
            "OCR 识别失败。",
        );
        let value: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(value["service"], "ocr");
        assert_eq!(value["status"], 504);
        assert_eq!(value["code"], "ocr_timeout");
        assert_eq!(value["message"], "Cloud OCR timed out");
        assert_eq!(value["requestId"], "req-123");
        assert!(!error.contains("OCR proxy HTTP"));
    }

    #[test]
    fn proxy_llm_messages_keep_context_inside_one_system_message() {
        let messages = ask_messages("说重点", Some("屏幕 OCR:\n订单页面".to_string()));

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "说重点");
        assert!(messages[0]["content"]
            .as_str()
            .is_some_and(|value| value.contains("屏幕 OCR")));
    }

    #[test]
    fn proxy_endpoint_requires_http_url() {
        assert_eq!(
            proxy_endpoint("https://example.com/echo-api/", "/proxy/tts").unwrap(),
            "https://example.com/echo-api/proxy/tts"
        );
        assert!(proxy_endpoint("file:///tmp", "/proxy/tts").is_err());
    }

    #[test]
    fn tts_diagnostic_exposes_an_ack_only_after_nonempty_audio() {
        assert_eq!(
            tts_diagnostic_operation_id(true, "operation-root"),
            Some("operation-root".to_string())
        );
        assert_eq!(tts_diagnostic_operation_id(false, "operation-root"), None);
    }
}
