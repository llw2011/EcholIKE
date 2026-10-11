use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const HEADER_NAME: &str = "x-idempotency-key";
const STALE_OPERATION_SECS: i64 = 30 * 24 * 60 * 60;

#[derive(Clone)]
pub struct Registry {
    database_path: Arc<PathBuf>,
}

#[derive(Clone)]
pub(crate) struct PersistentOperation {
    registry: Registry,
    scope: String,
    semantic_fingerprint: String,
    root: String,
}

impl Registry {
    pub(crate) fn new(database_path: PathBuf) -> Result<Self, String> {
        let registry = Self {
            database_path: Arc::new(database_path),
        };
        registry.initialize()?;
        Ok(registry)
    }

    fn initialize(&self) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS client_idempotency_operation (
                    scope TEXT NOT NULL,
                    semantic_fingerprint TEXT NOT NULL,
                    operation_root TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state = 'pending'),
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (scope, semantic_fingerprint)
                );",
            )
            .map_err(registry_error)?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(self.database_path.as_ref()).map_err(registry_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(registry_error)?;
        Ok(connection)
    }

    pub(crate) fn acquire(
        &self,
        scope: &str,
        semantic_parts: &[&[u8]],
    ) -> Result<PersistentOperation, String> {
        let semantic_fingerprint = derived_key("semantic", semantic_parts);
        let now = unix_timestamp()?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(registry_error)?;
        transaction
            .execute(
                "DELETE FROM client_idempotency_operation
                 WHERE updated_at < ?1",
                params![now.saturating_sub(STALE_OPERATION_SECS)],
            )
            .map_err(registry_error)?;
        let existing = transaction
            .query_row(
                "SELECT operation_root
                 FROM client_idempotency_operation
                 WHERE scope = ?1 AND semantic_fingerprint = ?2",
                params![scope, semantic_fingerprint],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(registry_error)?;
        let root = match existing {
            Some(root) => {
                transaction
                    .execute(
                        "UPDATE client_idempotency_operation
                         SET updated_at = ?3
                         WHERE scope = ?1 AND semantic_fingerprint = ?2",
                        params![scope, semantic_fingerprint, now],
                    )
                    .map_err(registry_error)?;
                root
            }
            _ => {
                let root = new_key()?;
                transaction
                    .execute(
                        "INSERT INTO client_idempotency_operation
                           (scope, semantic_fingerprint, operation_root, state, updated_at)
                         VALUES (?1, ?2, ?3, 'pending', ?4)
                         ON CONFLICT(scope, semantic_fingerprint) DO UPDATE SET
                           operation_root = excluded.operation_root,
                           state = 'pending',
                           updated_at = excluded.updated_at",
                        params![scope, semantic_fingerprint, root, now],
                    )
                    .map_err(registry_error)?;
                root
            }
        };
        transaction.commit().map_err(registry_error)?;
        Ok(PersistentOperation {
            registry: self.clone(),
            scope: scope.to_string(),
            semantic_fingerprint,
            root,
        })
    }

    pub(crate) fn acquire_authenticated(
        &self,
        scope: &str,
        api_base_url: &str,
        token: &str,
        semantic_parts: &[&[u8]],
    ) -> Result<PersistentOperation, String> {
        let api_base_url = api_base_url.trim();
        let token = token.trim();
        if api_base_url.is_empty() || token.is_empty() {
            return Err("Network operation identity is incomplete".to_string());
        }

        let mut scoped_parts = Vec::with_capacity(semantic_parts.len() + 2);
        scoped_parts.push(api_base_url.as_bytes());
        scoped_parts.push(token.as_bytes());
        scoped_parts.extend_from_slice(semantic_parts);
        self.acquire(scope, &scoped_parts)
    }
}

impl PersistentOperation {
    pub(crate) fn root(&self) -> &str {
        &self.root
    }

    pub(crate) fn retire(&self) -> Result<(), String> {
        self.registry
            .connection()?
            .execute(
                "DELETE FROM client_idempotency_operation
                 WHERE scope = ?1 AND semantic_fingerprint = ?2 AND operation_root = ?3",
                params![self.scope, self.semantic_fingerprint, self.root],
            )
            .map(|_| ())
            .map_err(registry_error)
    }
}

impl Registry {
    pub(crate) fn acknowledge(&self, operation_root: &str) -> Result<(), String> {
        let root = operation_root.trim();
        if root.is_empty() {
            return Err("Network operation id is empty".to_string());
        }
        self.connection()?
            .execute(
                "DELETE FROM client_idempotency_operation WHERE operation_root = ?1",
                params![root],
            )
            .map(|_| ())
            .map_err(registry_error)
    }
}

pub(crate) fn response_retires_operation(status: reqwest::StatusCode, body: &[u8]) -> bool {
    if !matches!(
        status,
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE
    ) {
        return false;
    }
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("code")?.as_str().map(str::to_string))
        .is_some_and(|code| {
            matches!(
                code.as_str(),
                "idempotency_conflict" | "operation_result_expired"
            )
        })
}

pub(crate) fn error_retires_operation(error: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(error) else {
        return false;
    };
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .and_then(|status| reqwest::StatusCode::from_u16(status).ok());
    status.is_some_and(|status| response_retires_operation(status, error.as_bytes()))
}

fn unix_timestamp() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .ok_or_else(|| "System clock is unavailable for network operation recovery".to_string())
}

fn registry_error(error: rusqlite::Error) -> String {
    tracing::error!(%error, "Client idempotency registry failed");
    "Network operation recovery is unavailable".to_string()
}

#[derive(Debug)]
pub(crate) struct BufferedResponse {
    pub status: reqwest::StatusCode,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

pub(crate) struct Operation {
    key: String,
    deadline: Instant,
    attempt_timeout: Duration,
    ambiguous_retries_remaining: u8,
    status_retries_remaining: u8,
}

impl Operation {
    #[cfg(test)]
    pub(crate) fn new(attempt_timeout: Duration, retry_window: Duration) -> Result<Self, String> {
        Self::with_key(new_key()?, attempt_timeout, retry_window)
    }

    pub(crate) fn with_key(
        key: String,
        attempt_timeout: Duration,
        retry_window: Duration,
    ) -> Result<Self, String> {
        let deadline = Instant::now()
            .checked_add(attempt_timeout)
            .and_then(|deadline| deadline.checked_add(retry_window))
            .ok_or_else(|| "Network operation deadline is invalid".to_string())?;
        Ok(Self {
            key,
            deadline,
            attempt_timeout,
            ambiguous_retries_remaining: 2,
            status_retries_remaining: 3,
        })
    }

    pub(crate) fn prepare(
        &mut self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::RequestBuilder, String> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Network operation timed out".to_string());
        }
        Ok(request
            .header(HEADER_NAME, &self.key)
            .timeout(self.attempt_timeout.min(remaining)))
    }

    pub(crate) async fn retry_transport(&mut self, error: &reqwest::Error) -> bool {
        let ambiguous =
            error.is_timeout() || error.is_connect() || error.is_body() || error.is_decode();
        if !ambiguous {
            return false;
        }
        self.retry_ambiguous().await
    }

    pub(crate) async fn retry_ambiguous(&mut self) -> bool {
        if self.ambiguous_retries_remaining == 0 {
            return false;
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        let delay = Duration::from_millis(100);
        if remaining <= delay {
            return false;
        }
        self.ambiguous_retries_remaining -= 1;
        tokio::time::sleep(delay).await;
        true
    }

    pub(crate) async fn retry_response(
        &mut self,
        status: reqwest::StatusCode,
        headers: &reqwest::header::HeaderMap,
        body: &[u8],
    ) -> bool {
        if !matches!(
            status,
            reqwest::StatusCode::CONFLICT
                | reqwest::StatusCode::TOO_MANY_REQUESTS
                | reqwest::StatusCode::SERVICE_UNAVAILABLE
        ) {
            return false;
        }
        let Some(seconds) = headers
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
        else {
            return false;
        };
        let response_code = serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("code")?.as_str().map(str::to_string));
        let retryable_code = response_code
            .as_deref()
            .is_none_or(|code| matches!(code, "operation_in_progress" | "rate_limited"));
        if !retryable_code {
            return false;
        }
        if self.status_retries_remaining == 0 {
            return false;
        }
        let delay = Duration::from_secs(seconds).max(Duration::from_millis(50));
        if self.deadline.saturating_duration_since(Instant::now()) <= delay {
            return false;
        }
        self.status_retries_remaining -= 1;
        tokio::time::sleep(delay).await;
        true
    }
}

pub(crate) fn derived_key(namespace: &str, parts: &[&[u8]]) -> String {
    const FNV_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const FNV_PRIME: u128 = 0x0000000001000000000000000000013b;

    let mut hash = FNV_OFFSET;
    let mut update = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u128::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    update(namespace.as_bytes());
    for part in parts {
        update(&(part.len() as u64).to_be_bytes());
        update(part);
    }
    format!("echolike-{namespace}-{hash:032x}")
}

fn new_key() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    ))
}

#[cfg(windows)]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut core::ffi::c_void, length: u32) -> u8;
    }

    let ok = unsafe { rtl_gen_random(bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if ok == 0 {
        Err("Secure random key generation failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn fill_random(bytes: &mut [u8]) -> Result<(), String> {
    use std::io::Read as _;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .map_err(|_| "Secure random key generation failed".to_string())
}

#[cfg(not(any(windows, unix)))]
fn fill_random(_bytes: &mut [u8]) -> Result<(), String> {
    Err("Secure random key generation is unavailable".to_string())
}

#[cfg(test)]
pub(crate) async fn execute_buffered<F>(
    attempt_timeout: Duration,
    retry_window: Duration,
    max_body_bytes: usize,
    build: F,
) -> Result<BufferedResponse, String>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let operation = Operation::new(attempt_timeout, retry_window)?;
    execute_buffered_operation(operation, max_body_bytes, build).await
}

pub(crate) async fn execute_buffered_with_key<F>(
    key: String,
    attempt_timeout: Duration,
    retry_window: Duration,
    max_body_bytes: usize,
    build: F,
) -> Result<BufferedResponse, String>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let operation = Operation::with_key(key, attempt_timeout, retry_window)?;
    execute_buffered_operation(operation, max_body_bytes, build).await
}

async fn execute_buffered_operation<F>(
    mut operation: Operation,
    max_body_bytes: usize,
    mut build: F,
) -> Result<BufferedResponse, String>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    loop {
        let response = match operation.prepare(build())?.send().await {
            Ok(response) => response,
            Err(error) => {
                if operation.retry_transport(&error).await {
                    continue;
                }
                return Err(error.to_string());
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        if response
            .content_length()
            .is_some_and(|length| length > max_body_bytes as u64)
        {
            return Err("Network response exceeded the client limit".to_string());
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        let mut retry = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    if body.len().saturating_add(chunk.len()) > max_body_bytes {
                        return Err("Network response exceeded the client limit".to_string());
                    }
                    body.extend_from_slice(&chunk);
                }
                Err(error) => {
                    let retryable_response = if status.is_success() {
                        operation.retry_transport(&error).await
                    } else {
                        operation.retry_response(status, &headers, &[]).await
                    };
                    if retryable_response {
                        retry = true;
                        break;
                    }
                    return Err(error.to_string());
                }
            }
        }
        if retry {
            continue;
        }
        if operation.retry_response(status, &headers, &body).await {
            continue;
        }
        return Ok(BufferedResponse {
            status,
            headers,
            body,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    fn registry_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "echolike-idempotency-{label}-{}-{}.db",
            std::process::id(),
            new_key().unwrap()
        ))
    }

    fn accept_with_deadline(listener: &TcpListener) -> TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "expected another request"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        }
    }

    fn read_headers(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before request headers completed");
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                return String::from_utf8_lossy(&request[..end + 4]).to_ascii_lowercase();
            }
        }
    }

    fn idempotency_key(headers: &str) -> String {
        headers
            .lines()
            .find_map(|line| line.strip_prefix("x-idempotency-key:"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .expect("request should contain x-idempotency-key")
            .to_string()
    }

    #[test]
    fn generated_keys_are_unique_uuid_v4_values() {
        let first = new_key().unwrap();
        let second = new_key().unwrap();

        assert_ne!(first, second);
        assert_eq!(first.len(), 36);
        assert_eq!(&first[8..9], "-");
        assert_eq!(&first[13..14], "-");
        assert_eq!(&first[14..15], "4");
        assert_eq!(&first[18..19], "-");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(&first[23..24], "-");
        assert!(first
            .chars()
            .filter(|character| *character != '-')
            .all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn derived_child_keys_are_stable_and_domain_separated() {
        let first = derived_key("tts-chunk", &[b"draft", b"3", b"hello"]);
        let same = derived_key("tts-chunk", &[b"draft", b"3", b"hello"]);
        let other_index = derived_key("tts-chunk", &[b"draft", b"4", b"hello"]);
        let other_domain = derived_key("ocr-page", &[b"draft", b"3", b"hello"]);

        assert_eq!(first, same);
        assert_ne!(first, other_index);
        assert_ne!(first, other_domain);
        assert!(first.len() <= 128);
    }

    #[test]
    fn auth_and_quota_rejections_keep_the_pending_operation_root() {
        assert!(!response_retires_operation(
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"code":"unauthorized"}"#,
        ));
        assert!(!response_retires_operation(
            reqwest::StatusCode::FORBIDDEN,
            br#"{"code":"stt_quota_exceeded"}"#,
        ));
        assert!(response_retires_operation(
            reqwest::StatusCode::CONFLICT,
            br#"{"code":"idempotency_conflict"}"#,
        ));
    }

    #[test]
    fn pending_registry_survives_reopen_and_ack_or_retire_rotates_the_root() {
        let path = registry_path("lifecycle");
        let registry = Registry::new(path.clone()).unwrap();
        let first = registry.acquire("ocr", &[b"same payload"]).unwrap();
        let same_pending = registry.acquire("ocr", &[b"same payload"]).unwrap();
        assert_eq!(first.root(), same_pending.root());
        let different_action_scope = registry.acquire("markdown-ai", &[b"same payload"]).unwrap();
        assert_ne!(first.root(), different_action_scope.root());

        drop(registry);
        let reopened = Registry::new(path.clone()).unwrap();
        let after_restart = reopened.acquire("ocr", &[b"same payload"]).unwrap();
        assert_eq!(first.root(), after_restart.root());

        reopened.acknowledge(after_restart.root()).unwrap();
        let after_ack = reopened.acquire("ocr", &[b"same payload"]).unwrap();
        assert_ne!(first.root(), after_ack.root());

        after_ack.retire().unwrap();
        let after_retire = reopened.acquire("ocr", &[b"same payload"]).unwrap();
        assert_ne!(after_ack.root(), after_retire.root());
        drop(reopened);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn concurrent_acquire_has_one_pending_root_per_scope_and_semantic_identity() {
        let path = registry_path("concurrent");
        let registry = Registry::new(path.clone()).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(5));
        let workers = (0..4)
            .map(|_| {
                let registry = registry.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry
                        .acquire("tts", &[b"same action"])
                        .unwrap()
                        .root()
                        .to_string()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let roots = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert!(roots.iter().all(|root| root == &roots[0]));
        drop(registry);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn authenticated_pending_roots_are_isolated_by_backend_and_session() {
        let path = registry_path("authenticated-scope");
        let registry = Registry::new(path.clone()).unwrap();
        let first = registry
            .acquire_authenticated(
                "ocr",
                "https://first.example/echo-api",
                "first-session",
                &[b"same payload"],
            )
            .unwrap();
        let same = registry
            .acquire_authenticated(
                "ocr",
                "https://first.example/echo-api",
                "first-session",
                &[b"same payload"],
            )
            .unwrap();
        let other_session = registry
            .acquire_authenticated(
                "ocr",
                "https://first.example/echo-api",
                "second-session",
                &[b"same payload"],
            )
            .unwrap();
        let other_backend = registry
            .acquire_authenticated(
                "ocr",
                "https://second.example/echo-api",
                "first-session",
                &[b"same payload"],
            )
            .unwrap();

        assert_eq!(first.root(), same.root());
        assert_ne!(first.root(), other_session.root());
        assert_ne!(first.root(), other_backend.root());

        registry.acknowledge(other_session.root()).unwrap();
        assert_eq!(
            registry
                .acquire_authenticated(
                    "ocr",
                    "https://first.example/echo-api",
                    "first-session",
                    &[b"same payload"],
                )
                .unwrap()
                .root(),
            first.root()
        );

        drop(registry);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn response_body_disconnect_uses_bounded_retries_with_the_same_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let keys = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&keys);
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for attempt in 0..3 {
                let mut stream = accept_with_deadline(&listener);
                let headers = read_headers(&mut stream);
                seen.lock().unwrap().push(idempotency_key(&headers));
                if attempt < 2 {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncut",
                        )
                        .unwrap();
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .unwrap();
                }
            }
        });

        let client = reqwest::Client::new();
        let response =
            execute_buffered(Duration::from_secs(2), Duration::from_secs(2), 1024, || {
                client.get(format!("http://{address}/retry"))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.body, b"ok");
        let keys = keys.lock().unwrap();
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| key == &keys[0]));
    }

    #[tokio::test]
    async fn operation_in_progress_and_finalize_pending_reuse_the_same_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let keys = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&keys);
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            for attempt in 0..3 {
                let mut stream = accept_with_deadline(&listener);
                let headers = read_headers(&mut stream);
                seen.lock().unwrap().push(idempotency_key(&headers));
                if attempt == 0 {
                    stream
                        .write_all(b"HTTP/1.1 409 Conflict\r\nRetry-After: 0\r\nContent-Length: 32\r\nConnection: close\r\n\r\n{\"code\":\"operation_in_progress\"}")
                        .unwrap();
                } else if attempt == 1 {
                    stream
                        .write_all(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 32\r\nConnection: close\r\n\r\n{\"code\":\"operation_in_progress\"}")
                        .unwrap();
                } else {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .unwrap();
                }
            }
        });

        let client = reqwest::Client::new();
        let response =
            execute_buffered(Duration::from_secs(2), Duration::from_secs(2), 1024, || {
                client.get(format!("http://{address}/poll"))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status, reqwest::StatusCode::OK);
        let keys = keys.lock().unwrap();
        assert_eq!(keys.len(), 3);
        assert!(keys.iter().all(|key| key == &keys[0]));
    }

    #[tokio::test]
    async fn explicit_server_error_is_not_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(false).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(0_u32));
        let seen = Arc::clone(&requests);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_headers(&mut stream);
            *seen.lock().unwrap() += 1;
            stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfail")
                .unwrap();
        });

        let client = reqwest::Client::new();
        let response =
            execute_buffered(Duration::from_secs(2), Duration::from_secs(2), 1024, || {
                client.get(format!("http://{address}/fail"))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(*requests.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn truncated_explicit_server_error_is_not_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(0_u32));
        let seen = Arc::clone(&requests);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_headers(&mut stream);
            *seen.lock().unwrap() += 1;
            stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncut")
                .unwrap();
        });

        let client = reqwest::Client::new();
        let error = execute_buffered(Duration::from_secs(2), Duration::from_secs(2), 1024, || {
            client.get(format!("http://{address}/truncated-fail"))
        })
        .await
        .unwrap_err();
        server.join().unwrap();

        assert!(!error.is_empty());
        assert_eq!(*requests.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn retry_after_does_not_retry_an_unrelated_service_error() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(0_u32));
        let seen = Arc::clone(&requests);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_headers(&mut stream);
            *seen.lock().unwrap() += 1;
            let body = b"{\"code\":\"provider_failed\"}";
            write!(
                stream,
                "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });

        let client = reqwest::Client::new();
        let response =
            execute_buffered(Duration::from_secs(2), Duration::from_secs(2), 1024, || {
                client.get(format!("http://{address}/unrelated-503"))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status, reqwest::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(*requests.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn retry_after_polling_is_bounded_even_when_deadline_remains() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let keys = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&keys);
        let server = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let headers = read_headers(&mut stream);
                seen.lock().unwrap().push(idempotency_key(&headers));
                let body = b"{\"code\":\"operation_in_progress\"}";
                write!(
                    stream,
                    "HTTP/1.1 409 Conflict\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });

        let client = reqwest::Client::new();
        let response =
            execute_buffered(Duration::from_secs(2), Duration::from_secs(4), 1024, || {
                client.get(format!("http://{address}/bounded-poll"))
            })
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(response.status, reqwest::StatusCode::CONFLICT);
        let keys = keys.lock().unwrap();
        assert_eq!(keys.len(), 4);
        assert!(keys.iter().all(|key| key == &keys[0]));
    }

    #[tokio::test]
    async fn caller_supplied_child_key_is_sent_verbatim() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let child_key = derived_key("tts-chunk", &[b"parent", b"0", b"hello"]);
        let expected = child_key.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let headers = read_headers(&mut stream);
            assert_eq!(idempotency_key(&headers), expected);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });

        let client = reqwest::Client::new();
        let response = execute_buffered_with_key(
            child_key,
            Duration::from_secs(2),
            Duration::from_secs(2),
            1024,
            || client.get(format!("http://{address}/child")),
        )
        .await
        .unwrap();
        server.join().unwrap();

        assert_eq!(response.body, b"ok");
    }
}
