use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Emitter;
use url::Url;

const OCR_DOCUMENT_CONTRACT: &str = "ocr-document-v1";
const DESKTOP_AUTH_STATE_CHANGED_EVENT: &str = "desktop-auth:state-changed";
const DESKTOP_BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(75);
const DESKTOP_BOOTSTRAP_MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct OtaUpdateStatus {
    pub app_name: String,
    pub current_version: String,
    pub latest_version: String,
    pub auto_update: bool,
    pub update_available: bool,
    pub force_update: bool,
    pub download_url: Option<String>,
    pub sha256: Option<String>,
    pub release_notes: Option<String>,
    pub message: String,
    pub checked_at: String,
}

#[tauri::command]
pub async fn check_ota_update(
    update_url: String,
    current_version: String,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<OtaUpdateStatus, String> {
    let mut url = Url::parse(update_url.trim()).map_err(|_| "更新检测地址无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("更新检测地址必须使用 http 或 https。".to_string());
    }
    if url.username() != "" || url.password().is_some() || url.fragment().is_some() {
        return Err("更新检测地址不能包含凭据或片段。".to_string());
    }
    url.set_query(None);

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("version", current_version.trim());
        query.append_pair("platform", current_platform());
        query.append_pair("arch", current_arch());
        query.append_pair("channel", "stable");
    }

    let client = client.client()?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("更新检测失败：HTTP {}", status.as_u16()));
    }

    response
        .json::<OtaUpdateStatus>()
        .await
        .map_err(|_| "更新检测返回格式无效。".to_string())
}

#[tauri::command]
pub async fn fetch_desktop_bootstrap(
    bootstrap_url: String,
    current_version: String,
    auth_token: Option<String>,
    client: tauri::State<'_, crate::network::NetworkClient>,
) -> Result<serde_json::Value, String> {
    let client = client.client()?;
    fetch_desktop_bootstrap_with_client(
        &client,
        &bootstrap_url,
        &current_version,
        auth_token.as_deref(),
    )
    .await
}

async fn fetch_desktop_bootstrap_with_client(
    client: &reqwest::Client,
    bootstrap_url: &str,
    current_version: &str,
    auth_token: Option<&str>,
) -> Result<serde_json::Value, String> {
    fetch_desktop_bootstrap_with_client_and_timeout(
        client,
        bootstrap_url,
        current_version,
        auth_token,
        DESKTOP_BOOTSTRAP_TIMEOUT,
    )
    .await
}

fn desktop_bootstrap_client_error(
    code: &str,
    stage: &str,
    message: String,
    status: Option<reqwest::StatusCode>,
) -> String {
    serde_json::json!({
        "service": "desktop-bootstrap",
        "status": status.map(|value| value.as_u16()),
        "code": code,
        "message": message,
        "requestId": null,
        "stage": stage,
    })
    .to_string()
}

async fn fetch_desktop_bootstrap_with_client_and_timeout(
    client: &reqwest::Client,
    bootstrap_url: &str,
    current_version: &str,
    auth_token: Option<&str>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let url = desktop_bootstrap_request_url(bootstrap_url, current_version)?;
    let mut request = client.get(url);
    if let Some(token) = auth_token.map(str::trim) {
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
    }

    let mut response = request.timeout(timeout).send().await.map_err(|error| {
        desktop_bootstrap_client_error(
            if error.is_timeout() {
                "desktop_bootstrap_timeout"
            } else {
                "desktop_bootstrap_transport"
            },
            "transport",
            if error.is_timeout() {
                "桌面策略同步超时。".to_string()
            } else {
                format!("桌面策略网络请求失败：{error}")
            },
            None,
        )
    })?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > DESKTOP_BOOTSTRAP_MAX_RESPONSE_BYTES as u64)
    {
        return Err(desktop_bootstrap_client_error(
            "desktop_bootstrap_response_too_large",
            "response",
            "桌面策略响应超过大小限制。".to_string(),
            Some(status),
        ));
    }

    let mut body = Vec::new();
    loop {
        let chunk = response.chunk().await.map_err(|error| {
            desktop_bootstrap_client_error(
                if error.is_timeout() {
                    "desktop_bootstrap_timeout"
                } else {
                    "desktop_bootstrap_transport"
                },
                "transport",
                if error.is_timeout() {
                    "桌面策略响应读取超时。".to_string()
                } else {
                    "桌面策略响应读取中断。".to_string()
                },
                Some(status),
            )
        })?;
        let Some(chunk) = chunk else { break };
        if body.len().saturating_add(chunk.len()) > DESKTOP_BOOTSTRAP_MAX_RESPONSE_BYTES {
            return Err(desktop_bootstrap_client_error(
                "desktop_bootstrap_response_too_large",
                "response",
                "桌面策略响应超过大小限制。".to_string(),
                Some(status),
            ));
        }
        body.extend_from_slice(&chunk);
    }

    if !status.is_success() {
        return Err(super::backend::structured_backend_error(
            "desktop-bootstrap",
            status,
            &String::from_utf8_lossy(&body),
            "桌面策略同步失败。",
        ));
    }

    serde_json::from_slice::<serde_json::Value>(&body).map_err(|_| {
        desktop_bootstrap_client_error(
            "desktop_bootstrap_invalid_response",
            "response",
            "桌面策略返回格式无效。".to_string(),
            Some(status),
        )
    })
}

fn desktop_bootstrap_request_url(
    bootstrap_url: &str,
    current_version: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(bootstrap_url.trim()).map_err(|_| "桌面策略地址无效。".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("桌面策略地址必须使用 http 或 https。".to_string());
    }
    if url.username() != "" || url.password().is_some() || url.fragment().is_some() {
        return Err("桌面策略地址不能包含凭据或片段。".to_string());
    }
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("version", current_version.trim());
        query.append_pair("platform", current_platform());
        query.append_pair("arch", current_arch());
        query.append_pair("channel", "stable");
        query.append_pair("docContracts", OCR_DOCUMENT_CONTRACT);
    }
    Ok(url)
}

#[tauri::command]
pub fn load_desktop_auth_snapshot(
    app_handle: tauri::AppHandle,
) -> Result<crate::storage::DesktopAuthSnapshot, String> {
    crate::storage::load_desktop_auth_snapshot(&app_handle).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn confirm_desktop_auth_runtime(
    app_handle: tauri::AppHandle,
    runtime_fence: tauri::State<'_, crate::storage::DesktopAuthRuntimeFence>,
    expected_generation: u64,
    expected_authority_token: Option<String>,
) -> Result<bool, String> {
    let snapshot = crate::storage::load_desktop_auth_snapshot(&app_handle)
        .map_err(|error| error.to_string())?;
    let matches = snapshot.generation == expected_generation
        && snapshot.authority_token.as_deref()
            == expected_authority_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
    if matches {
        runtime_fence.confirm(&snapshot);
        emit_desktop_auth_state_changed(&app_handle, true);
    }
    Ok(matches)
}

#[tauri::command]
pub fn invalidate_desktop_auth_runtime(
    runtime_fence: tauri::State<'_, crate::storage::DesktopAuthRuntimeFence>,
    expected_generation: u64,
    expected_authority_token: Option<String>,
) -> bool {
    runtime_fence.invalidate_if_matches(expected_generation, expected_authority_token.as_deref())
}

#[tauri::command]
pub fn begin_desktop_auth_candidate(
    app_handle: tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<String>,
) -> Result<Option<crate::storage::DesktopAuthSnapshot>, String> {
    let snapshot = crate::storage::begin_desktop_auth_candidate(
        &app_handle,
        expected_generation,
        expected_authority_token.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    emit_desktop_auth_state_changed(&app_handle, snapshot.is_some());
    Ok(snapshot)
}

#[tauri::command]
pub fn begin_desktop_auth_candidate_for_login(
    app_handle: tauri::AppHandle,
    expected_generation: Option<u64>,
    expected_authority_token: Option<String>,
    next_authority_token: String,
) -> Result<Option<crate::storage::DesktopAuthSnapshot>, String> {
    let snapshot = crate::storage::begin_desktop_auth_candidate_for_login(
        &app_handle,
        expected_generation,
        expected_authority_token.as_deref(),
        &next_authority_token,
    )
    .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

#[tauri::command]
pub fn commit_desktop_auth_candidate(
    app_handle: tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<String>,
    expected_raw_cached_auth_token: Option<String>,
    bootstrap: serde_json::Value,
) -> Result<Option<crate::storage::DesktopAuthSnapshot>, String> {
    let cache = desktop_bootstrap_cache(&app_handle, bootstrap, expected_authority_token.clone());
    let snapshot = crate::storage::commit_desktop_auth_candidate(
        &app_handle,
        expected_generation,
        expected_authority_token.as_deref(),
        expected_raw_cached_auth_token.as_deref(),
        cache,
    )
    .map_err(|error| error.to_string())?;
    emit_desktop_auth_state_changed(&app_handle, snapshot.is_some());
    Ok(snapshot)
}

#[tauri::command]
pub fn clear_desktop_auth_authority(
    app_handle: tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<String>,
) -> Result<Option<crate::storage::DesktopAuthSnapshot>, String> {
    let snapshot = crate::storage::clear_desktop_auth_authority(
        &app_handle,
        expected_generation,
        expected_authority_token.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    emit_desktop_auth_state_changed(&app_handle, snapshot.is_some());
    Ok(snapshot)
}

pub(crate) fn emit_desktop_auth_state_changed(app_handle: &tauri::AppHandle, changed: bool) {
    if changed {
        if let Err(error) = app_handle.emit(DESKTOP_AUTH_STATE_CHANGED_EVENT, ()) {
            tracing::warn!("Desktop auth state event delivery failed: {error}");
        }
    }
}

fn desktop_bootstrap_cache(
    app_handle: &tauri::AppHandle,
    bootstrap: serde_json::Value,
    auth_token: Option<String>,
) -> crate::storage::DesktopBootstrapCache {
    crate::storage::DesktopBootstrapCache {
        package_version: app_handle.package_info().version.to_string(),
        bootstrap,
        auth_token: auth_token
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        cached_at: chrono::Utc::now().to_rfc3339(),
    }
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn current_arch() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        "x86_64"
    }
    #[cfg(target_arch = "aarch64")]
    {
        "aarch64"
    }
    #[cfg(target_arch = "x86")]
    {
        "i686"
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "x86")))]
    {
        "all"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_one_bootstrap_response(
        status: reqwest::StatusCode,
        body: serde_json::Value,
    ) -> (String, std::thread::JoinHandle<String>) {
        serve_one_bootstrap_response_after(status, body, Duration::ZERO)
    }

    fn serve_one_bootstrap_response_after(
        status: reqwest::StatusCode,
        body: serde_json::Value,
        delay: Duration,
    ) -> (String, std::thread::JoinHandle<String>) {
        serve_one_bootstrap_raw_response_after(status, serde_json::to_string(&body).unwrap(), delay)
    }

    fn serve_one_bootstrap_raw_response_after(
        status: reqwest::StatusCode,
        body: String,
        delay: Duration,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "client closed before request headers completed");
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|value| value == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                body.len(),
                body
            );
            std::thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8(request).unwrap()
        });

        (
            format!("http://{address}/echo-api/desktop/bootstrap"),
            server,
        )
    }

    fn serve_one_bootstrap_headers_then_body(
        status: reqwest::StatusCode,
        body: String,
        declared_length: usize,
        body_delay: Duration,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0, "client closed before request headers completed");
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|value| value == b"\r\n\r\n") {
                    break;
                }
            }
            let headers = format!(
                "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                status.as_u16(),
                status.canonical_reason().unwrap_or("Unknown"),
                declared_length,
            );
            stream.write_all(headers.as_bytes()).unwrap();
            stream.flush().unwrap();
            std::thread::sleep(body_delay);
            let _ = stream.write_all(body.as_bytes());
            String::from_utf8(request).unwrap()
        });

        (
            format!("http://{address}/echo-api/desktop/bootstrap"),
            server,
        )
    }

    #[test]
    fn desktop_bootstrap_url_declares_the_pdf_document_contract_once() {
        let url = desktop_bootstrap_request_url(
            "https://example.test/echo-api/desktop/bootstrap?source=desktop&docContracts=wrong",
            "0.2.9",
        )
        .unwrap();
        let pairs = url.query_pairs().collect::<Vec<_>>();

        assert!(pairs
            .iter()
            .any(|(key, value)| key == "version" && value == "0.2.9"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "platform" && value == current_platform()));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "arch" && value == current_arch()));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "channel" && value == "stable"));
        assert_eq!(
            pairs
                .iter()
                .filter(|(key, value)| { key == "docContracts" && value == "ocr-document-v1" })
                .count(),
            1
        );
        assert!(!pairs
            .iter()
            .any(|(key, value)| key == "docContracts" && value == "wrong"));
    }

    #[test]
    fn desktop_bootstrap_timeout_covers_the_server_capability_probe_budget() {
        assert_eq!(DESKTOP_BOOTSTRAP_TIMEOUT, Duration::from_secs(75));
        assert_eq!(DESKTOP_BOOTSTRAP_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
    }

    #[tokio::test]
    async fn bootstrap_timeout_is_structured_as_a_retryable_transport_failure() {
        let body = serde_json::json!({ "schemaVersion": 1 }).to_string();
        let (url, server) = serve_one_bootstrap_headers_then_body(
            reqwest::StatusCode::OK,
            body.clone(),
            body.len(),
            Duration::from_millis(100),
        );
        let client = reqwest::Client::new();

        let error = fetch_desktop_bootstrap_with_client_and_timeout(
            &client,
            &url,
            env!("CARGO_PKG_VERSION"),
            Some("session-token"),
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(diagnostic["service"], "desktop-bootstrap");
        assert_eq!(diagnostic["status"], 200);
        assert_eq!(diagnostic["code"], "desktop_bootstrap_timeout");
        assert_eq!(diagnostic["stage"], "transport");
        assert!(!error.contains("session-token"));
    }

    #[tokio::test]
    async fn bootstrap_truncated_body_is_structured_as_a_retryable_transport_failure() {
        let body = serde_json::json!({ "schemaVersion": 1 }).to_string();
        let (url, server) = serve_one_bootstrap_headers_then_body(
            reqwest::StatusCode::OK,
            body.clone(),
            body.len() + 10,
            Duration::ZERO,
        );
        let client = reqwest::Client::new();

        let error = fetch_desktop_bootstrap_with_client_and_timeout(
            &client,
            &url,
            env!("CARGO_PKG_VERSION"),
            Some("session-token"),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(diagnostic["service"], "desktop-bootstrap");
        assert_eq!(diagnostic["status"], 200);
        assert_eq!(diagnostic["code"], "desktop_bootstrap_transport");
        assert_eq!(diagnostic["stage"], "transport");
        assert!(!error.contains("session-token"));
    }

    #[tokio::test]
    async fn bootstrap_invalid_json_is_structured_as_a_non_retryable_response_failure() {
        let (url, server) = serve_one_bootstrap_raw_response_after(
            reqwest::StatusCode::OK,
            "{invalid-bootstrap".to_string(),
            Duration::ZERO,
        );
        let client = reqwest::Client::new();

        let error = fetch_desktop_bootstrap_with_client(
            &client,
            &url,
            env!("CARGO_PKG_VERSION"),
            Some("session-token"),
        )
        .await
        .unwrap_err();
        server.join().unwrap();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert_eq!(diagnostic["service"], "desktop-bootstrap");
        assert_eq!(diagnostic["status"], 200);
        assert_eq!(diagnostic["code"], "desktop_bootstrap_invalid_response");
        assert_eq!(diagnostic["stage"], "response");
        assert!(!error.contains("session-token"));
    }

    #[tokio::test]
    async fn bootstrap_http_error_preserves_structured_auth_diagnostics() {
        let (url, server) = serve_one_bootstrap_response(
            reqwest::StatusCode::UNAUTHORIZED,
            serde_json::json!({
                "error": "Authentication required",
                "code": "unauthorized",
                "requestId": "req-bootstrap-401"
            }),
        );
        let client = reqwest::Client::new();

        let error = fetch_desktop_bootstrap_with_client(
            &client,
            &url,
            env!("CARGO_PKG_VERSION"),
            Some("expired-session-token"),
        )
        .await
        .unwrap_err();
        let request = server.join().unwrap();
        let diagnostic: serde_json::Value = serde_json::from_str(&error).unwrap();

        assert!(request.contains("authorization: Bearer expired-session-token"));
        assert_eq!(diagnostic["service"], "desktop-bootstrap");
        assert_eq!(diagnostic["status"], 401);
        assert_eq!(diagnostic["code"], "unauthorized");
        assert_eq!(diagnostic["requestId"], "req-bootstrap-401");
        assert!(!error.contains("expired-session-token"));
    }

    #[tokio::test]
    async fn bootstrap_success_contract_remains_the_json_body() {
        let expected = serde_json::json!({
            "schemaVersion": 1,
            "user": { "email": "user@example.com" },
            "policy": { "remoteConfigDelivery": "startup" }
        });
        let (url, server) = serve_one_bootstrap_response(reqwest::StatusCode::OK, expected.clone());
        let client = reqwest::Client::new();

        let actual =
            fetch_desktop_bootstrap_with_client(&client, &url, env!("CARGO_PKG_VERSION"), None)
                .await
                .unwrap();
        server.join().unwrap();

        assert_eq!(actual, expected);
    }
}
