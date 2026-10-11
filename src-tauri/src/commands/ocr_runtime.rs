use serde::Deserialize;
use std::os::windows::process::CommandExt;
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{Mutex, MutexGuard},
    task::JoinHandle,
};

const ROUTER_PROTOCOL: &str = "paseo-router-json-v1";
const ROUTER_RESULT_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CLI_STDOUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLI_STDERR_BYTES: usize = 1024 * 1024;
const MAX_RESULT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const PDF_MAX_PAGES: u32 = 20;
const PDF_PAGE_LIMIT_SENTINEL: u32 = PDF_MAX_PAGES + 1;
const JOB_OWNER_MARKER: &str = ".echolike-ocr-job-v1";
const JOB_STALE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const CREATE_NO_WINDOW: u32 = 0x08000000;

static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static LOCAL_OCR_RUN: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalOcrOutput {
    pub text: String,
    pub route: &'static str,
    pub reason: String,
    pub warnings: Vec<String>,
    pub degraded: bool,
    pub page_count: Option<u32>,
}

struct RuntimePaths;

#[derive(Debug, Clone, PartialEq, Eq)]
struct OllamaTarget {
    host: String,
    port: u16,
    model: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RouterCapabilities {
    name: String,
    version: String,
    protocols: Vec<String>,
    result_formats: Vec<String>,
    tile_modes: Vec<String>,
    pipeline_owner: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RouterRoute {
    Direct,
    Tile,
    Pipeline,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct RouterTiles {
    total: u32,
    succeeded: u32,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RouterResult {
    version: u32,
    route: RouterRoute,
    reason: String,
    text: Option<String>,
    fallback_text: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
    tiles: Option<RouterTiles>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PipelineInputKind {
    Image,
    Pdf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PipelineOutput {
    text: String,
    page_count: Option<u32>,
    warnings: Vec<String>,
    degraded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StdoutMode {
    Capture,
    Discard,
}

#[derive(Debug, Default)]
struct BoundedBytes {
    bytes: Vec<u8>,
    truncated: bool,
}

fn acquire_local_ocr_run() -> Result<MutexGuard<'static, ()>, String> {
    let run = LOCAL_OCR_RUN
        .try_lock()
        .map_err(|_| "Another local OCR request is already running".to_string())?;
    let parent = std::env::temp_dir().join("EcholIKE").join("ocr");
    if parent.is_dir() {
        cleanup_stale_job_dirs(&parent, SystemTime::now(), JOB_STALE_AGE);
    }
    Ok(run)
}

pub(crate) fn validate_runtime_target(base_url: &str, model: &str) -> Result<(), String> {
    OllamaTarget::parse(base_url, model).map(|_| ())
}

struct OcrJobDir {
    root: PathBuf,
}

impl OcrJobDir {
    fn create() -> Result<Self, String> {
        let parent = std::env::temp_dir().join("EcholIKE").join("ocr");
        std::fs::create_dir_all(&parent)
            .map_err(|error| format!("Failed to prepare OCR temporary directory: {error}"))?;

        for _ in 0..8 {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let sequence = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = parent.join(format!("job-{}-{now}-{sequence}", std::process::id()));
            match std::fs::create_dir(&root) {
                Ok(()) => {
                    if let Err(error) = std::fs::write(root.join(JOB_OWNER_MARKER), b"1\n") {
                        let _ = std::fs::remove_dir_all(&root);
                        return Err(format!(
                            "Failed to mark the OCR temporary directory as owned: {error}"
                        ));
                    }
                    return Ok(Self { root });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("Failed to create OCR temporary directory: {error}"))
                }
            }
        }

        Err("Failed to allocate a unique OCR temporary directory".to_string())
    }

    fn input_path(&self, extension: &str) -> PathBuf {
        self.root.join(format!("input.{extension}"))
    }

    fn output_path(&self) -> PathBuf {
        self.root.join("output")
    }
}

impl Drop for OcrJobDir {
    fn drop(&mut self) {
        let is_owned_job = self
            .root
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with("job-"))
            && self
                .root
                .parent()
                .and_then(Path::file_name)
                .and_then(OsStr::to_str)
                == Some("ocr")
            && self.root.join(JOB_OWNER_MARKER).is_file();
        if is_owned_job {
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                tracing::warn!(path = %self.root.display(), error = %error, "Failed to remove OCR temporary directory");
            }
        }
    }
}

fn cleanup_stale_job_dirs(parent: &Path, now: SystemTime, minimum_age: Duration) {
    let entries = match std::fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::debug!(path = %parent.display(), error = %error, "Failed to inspect stale OCR jobs");
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let owned_name = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("job-"));
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_dir() => metadata,
            _ => continue,
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= minimum_age);
        if !owned_name || !stale || !path.join(JOB_OWNER_MARKER).is_file() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&path) {
            tracing::warn!(path = %path.display(), error = %error, "Failed to remove stale OCR temporary directory");
        }
    }
}

#[cfg(test)]
fn cleanup_stale_job_dirs_if_idle(parent: &Path, now: SystemTime, minimum_age: Duration) {
    if let Ok(idle_run) = LOCAL_OCR_RUN.try_lock() {
        cleanup_stale_job_dirs(parent, now, minimum_age);
        drop(idle_run);
    }
}

pub(crate) async fn probe_router_runtime(base_url: &str, model: &str) -> Result<(), String> {
    let _target = OllamaTarget::parse(base_url, model)?;
    let router_path = RuntimePaths::discover_router()?;
    let job = OcrJobDir::create()?;

    let router = run_checked_command(
        &router_path,
        [OsString::from("--capabilities"), OsString::from("json-v1")],
        &[],
        &job.root,
        StdoutMode::Capture,
        Some(PROBE_TIMEOUT),
        "Vision Router capability probe",
    )
    .await?;
    let capabilities = parse_router_capabilities(&router.stdout)?;
    validate_router_capabilities(&capabilities)
}

pub(crate) async fn probe_pipeline_runtime(base_url: &str, model: &str) -> Result<(), String> {
    let target = OllamaTarget::parse(base_url, model)?;
    let pipeline_path = RuntimePaths::discover_pipeline()?;
    let job = OcrJobDir::create()?;

    let pipeline = run_checked_command(
        &pipeline_path,
        [OsString::from("--version")],
        &target.pipeline_environment(),
        &job.root,
        StdoutMode::Capture,
        Some(PROBE_TIMEOUT),
        "GLM-OCR Pipeline probe",
    )
    .await?;
    let version = text_output(&pipeline.stdout, "GLM-OCR Pipeline version")?;
    if version.trim() != "glmocr-pipeline Windows-WSL bridge 1" {
        return Err("GLM-OCR Pipeline returned an unsupported bridge version".to_string());
    }

    let pipeline_help = run_checked_command(
        &pipeline_path,
        [OsString::from("--help")],
        &target.pipeline_environment(),
        &job.root,
        StdoutMode::Capture,
        Some(PROBE_TIMEOUT),
        "GLM-OCR Pipeline runtime probe",
    )
    .await?;
    let help = text_output(&pipeline_help.stdout, "GLM-OCR Pipeline help")?;
    if !help.contains("usage: glmocr parse")
        || !help.contains("--json-only")
        || !help.contains("--set KEY VALUE")
    {
        return Err("GLM-OCR Pipeline runtime did not expose the expected CLI".to_string());
    }

    Ok(())
}

pub(crate) async fn process_image(
    image_bytes: Vec<u8>,
    extension: &str,
    base_url: &str,
    model: &str,
) -> Result<LocalOcrOutput, String> {
    if image_bytes.is_empty() {
        return Err("OCR image is empty".to_string());
    }
    let _run = acquire_local_ocr_run()?;

    let target = OllamaTarget::parse(base_url, model)?;
    let router_path = RuntimePaths::discover_router()?;
    let job = OcrJobDir::create()?;
    let input = job.input_path(normalize_image_extension(extension));
    std::fs::write(&input, image_bytes)
        .map_err(|error| format!("Failed to stage OCR image: {error}"))?;

    // The current Windows→WSL adapter has no process-group cancellation contract.
    // Keep the Rust/UI lease until the real Router exits instead of timing out only
    // the Windows launcher and allowing an orphaned Linux OCR job to keep running.
    let router = run_checked_command(
        &router_path,
        [
            input.as_os_str().to_os_string(),
            OsString::from("--result-format"),
            OsString::from("json-v1"),
            OsString::from("--tile-mode"),
            OsString::from("auto"),
        ],
        &target.router_environment(),
        &job.root,
        StdoutMode::Capture,
        None,
        "Vision Router",
    )
    .await?;
    let route = parse_router_result(&router.stdout)?;

    match route.route {
        RouterRoute::Direct => output_from_router_text(route, "direct"),
        RouterRoute::Tile => output_from_router_text(route, "tile"),
        RouterRoute::Pipeline => {
            let fallback_text = route.fallback_text.clone().unwrap_or_default();
            let pipeline_result = match RuntimePaths::discover_pipeline() {
                Ok(pipeline_path) => {
                    run_pipeline(
                        &pipeline_path,
                        &target,
                        &job,
                        &input,
                        PipelineInputKind::Image,
                    )
                    .await
                }
                Err(error) => Err(error),
            };
            match pipeline_result {
                Ok(output) => {
                    let mut warnings = route.warnings;
                    warnings.extend(output.warnings);
                    Ok(LocalOcrOutput {
                        text: output.text,
                        route: "pipeline",
                        reason: route.reason,
                        warnings,
                        degraded: output.degraded,
                        page_count: output.page_count,
                    })
                }
                Err(error) if !fallback_text.trim().is_empty() => {
                    tracing::warn!(error = %error, "GLM-OCR Pipeline failed; using Router fallback text");
                    let mut warnings = route.warnings;
                    warnings.push("完整文档管线未完成，当前展示快速识别的降级结果。".to_string());
                    Ok(LocalOcrOutput {
                        text: fallback_text.trim().to_string(),
                        route: "direct",
                        reason: format!("pipeline-fallback:{}", route.reason),
                        warnings,
                        degraded: true,
                        page_count: Some(1),
                    })
                }
                Err(error) => Err(error),
            }
        }
    }
}

pub(crate) async fn process_pdf(
    pdf_bytes: Vec<u8>,
    base_url: &str,
    model: &str,
) -> Result<LocalOcrOutput, String> {
    if pdf_bytes.is_empty() {
        return Err("OCR PDF is empty".to_string());
    }
    let _run = acquire_local_ocr_run()?;

    let target = OllamaTarget::parse(base_url, model)?;
    let pipeline_path = RuntimePaths::discover_pipeline()?;
    let job = OcrJobDir::create()?;
    let input = job.input_path("pdf");
    std::fs::write(&input, pdf_bytes)
        .map_err(|error| format!("Failed to stage OCR PDF: {error}"))?;
    let output = run_pipeline(
        &pipeline_path,
        &target,
        &job,
        &input,
        PipelineInputKind::Pdf,
    )
    .await?;

    Ok(LocalOcrOutput {
        text: output.text,
        route: "pipeline",
        reason: "pdf-document".to_string(),
        warnings: output.warnings,
        degraded: output.degraded,
        page_count: output.page_count,
    })
}

impl RuntimePaths {
    fn bin_dir() -> Result<PathBuf, String> {
        let home = std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "Windows user profile is unavailable".to_string())?;
        Ok(home.join(".local").join("bin"))
    }

    fn discover_router() -> Result<PathBuf, String> {
        let router = Self::bin_dir()?.join("vision-router.cmd");
        if !router.is_file() {
            return Err("Vision Router is not installed for the current Windows user".to_string());
        }
        Ok(router)
    }

    fn discover_pipeline() -> Result<PathBuf, String> {
        let pipeline = Self::bin_dir()?.join("glmocr-pipeline.cmd");
        if !pipeline.is_file() {
            return Err(
                "GLM-OCR Pipeline is not installed for the current Windows user".to_string(),
            );
        }
        Ok(pipeline)
    }
}

impl OllamaTarget {
    fn parse(base_url: &str, model: &str) -> Result<Self, String> {
        let model = model.trim();
        if model.is_empty() {
            return Err("OCR model is empty".to_string());
        }

        let parsed = url::Url::parse(base_url.trim())
            .map_err(|error| format!("Invalid OCR base URL: {error}"))?;
        if parsed.scheme() != "http" {
            return Err("Enhanced local OCR currently requires an http Ollama URL".to_string());
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
        {
            return Err(
                "Enhanced local OCR requires an Ollama origin without credentials, path, query, or fragment"
                    .to_string(),
            );
        }
        let host = parsed
            .host_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "OCR base URL host is empty".to_string())?;
        let normalized_host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        let loopback = normalized_host.eq_ignore_ascii_case("localhost")
            || normalized_host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        if !loopback {
            return Err(
                "Enhanced local OCR requires a loopback Ollama address; remote plaintext hosts are not supported"
                    .to_string(),
            );
        }
        let port = parsed
            .port_or_known_default()
            .ok_or_else(|| "OCR base URL port is unavailable".to_string())?;

        Ok(Self {
            host: "127.0.0.1".to_string(),
            port,
            model: model.to_string(),
        })
    }

    fn router_environment(&self) -> Vec<(OsString, OsString)> {
        vec![
            (
                OsString::from("VISION_ROUTER_OLLAMA_HOST"),
                OsString::from(&self.host),
            ),
            (
                OsString::from("VISION_ROUTER_OLLAMA_PORT"),
                OsString::from(self.port.to_string()),
            ),
            (
                OsString::from("VISION_ROUTER_OLLAMA_MODEL"),
                OsString::from(&self.model),
            ),
        ]
    }

    fn pipeline_environment(&self) -> Vec<(OsString, OsString)> {
        vec![
            (
                OsString::from("GLMOCR_OCR_API_HOST"),
                OsString::from(&self.host),
            ),
            (
                OsString::from("GLMOCR_OCR_API_PORT"),
                OsString::from(self.port.to_string()),
            ),
            (
                OsString::from("GLMOCR_OCR_MODEL"),
                OsString::from(&self.model),
            ),
        ]
    }
}

#[derive(Debug)]
struct CheckedCommandOutput {
    stdout: Vec<u8>,
}

fn should_remove_runtime_environment(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name.starts_with("PASEO_")
        || name.starts_with("VISION_ROUTER_")
        || name.starts_with("GLMOCR_")
        || name.starts_with("OLLAMA_")
        || matches!(
            name.as_str(),
            "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY" | "WSLENV" | "ZHIPU_API_KEY"
        )
}

fn isolate_runtime_environment(command: &mut Command, environment: &[(OsString, OsString)]) {
    for (name, _) in std::env::vars_os() {
        if should_remove_runtime_environment(&name) {
            command.env_remove(name);
        }
    }
    command.envs(environment.iter().cloned());
    command
        .env("NO_PROXY", "*")
        .env("no_proxy", "*")
        .env("WSLENV", "NO_PROXY/u:no_proxy/u");
}

async fn read_stream_bounded<R>(
    mut reader: R,
    limit: usize,
    label: &str,
) -> Result<BoundedBytes, String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Failed to read {label}: {error}"))?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let retained = read.min(remaining);
        bytes.extend_from_slice(&buffer[..retained]);
        if retained < read {
            truncated = true;
        }
    }
    Ok(BoundedBytes { bytes, truncated })
}

async fn read_stream_tail_bounded<R>(
    mut reader: R,
    limit: usize,
    label: &str,
) -> Result<BoundedBytes, String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut truncated = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Failed to read {label}: {error}"))?;
        if read == 0 {
            break;
        }
        if limit == 0 {
            truncated = true;
            continue;
        }
        if read >= limit {
            bytes.clear();
            bytes.extend_from_slice(&buffer[read - limit..read]);
            truncated = true;
            continue;
        }
        let overflow = bytes.len().saturating_add(read).saturating_sub(limit);
        if overflow > 0 {
            bytes.drain(..overflow);
            truncated = true;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(BoundedBytes { bytes, truncated })
}

fn spawn_bounded_reader<R>(
    reader: R,
    limit: usize,
    label: &'static str,
    retain_tail: bool,
) -> JoinHandle<Result<BoundedBytes, String>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        if retain_tail {
            read_stream_tail_bounded(reader, limit, label).await
        } else {
            read_stream_bounded(reader, limit, label).await
        }
    })
}

async fn join_bounded_reader(
    mut reader: JoinHandle<Result<BoundedBytes, String>>,
    label: &str,
) -> Result<BoundedBytes, String> {
    match tokio::time::timeout(PIPE_DRAIN_TIMEOUT, &mut reader).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("{label} reader failed: {error}")),
        Err(_) => {
            reader.abort();
            let _ = reader.await;
            Err(format!("{label} did not close after the launcher exited"))
        }
    }
}

async fn terminate_direct_child(child: &mut Child) -> Result<(), String> {
    match child
        .try_wait()
        .map_err(|error| format!("Failed to inspect OCR launcher: {error}"))?
    {
        Some(_) => return Ok(()),
        None => child
            .start_kill()
            .map_err(|error| format!("Failed to terminate OCR launcher: {error}"))?,
    }

    child
        .wait()
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to reap OCR launcher: {error}"))
}

async fn discard_reader_after_termination(
    reader: JoinHandle<Result<BoundedBytes, String>>,
    label: &str,
) {
    if let Err(error) = join_bounded_reader(reader, label).await {
        tracing::debug!(error = %error, "OCR launcher stream did not close cleanly");
    }
}

async fn run_checked_command<I>(
    executable: &Path,
    args: I,
    environment: &[(OsString, OsString)],
    working_directory: &Path,
    stdout_mode: StdoutMode,
    timeout: Option<Duration>,
    label: &str,
) -> Result<CheckedCommandOutput, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(match stdout_mode {
            StdoutMode::Capture => Stdio::piped(),
            StdoutMode::Discard => Stdio::null(),
        })
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    isolate_runtime_environment(&mut command, environment);
    command.as_std_mut().creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {label}: {error}"))?;
    let stdout_reader = child
        .stdout
        .take()
        .map(|stdout| spawn_bounded_reader(stdout, MAX_CLI_STDOUT_BYTES, "OCR stdout", false));
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Failed to capture {label} diagnostics"))?;
    let stderr_reader = spawn_bounded_reader(stderr, MAX_CLI_STDERR_BYTES, "OCR stderr", true);

    let wait_result = if let Some(timeout) = timeout {
        match tokio::time::timeout(timeout, child.wait()).await {
            Ok(result) => result,
            Err(_) => {
                let cleanup = terminate_direct_child(&mut child).await.err();
                if let Some(reader) = stdout_reader {
                    discard_reader_after_termination(reader, "OCR stdout").await;
                }
                discard_reader_after_termination(stderr_reader, "OCR stderr").await;
                return Err(match cleanup {
                    Some(cleanup) => format!(
                        "{label} timed out after {} seconds; {cleanup}",
                        timeout.as_secs()
                    ),
                    None => format!("{label} timed out after {} seconds", timeout.as_secs()),
                });
            }
        }
    } else {
        child.wait().await
    };

    let status = match wait_result {
        Ok(status) => status,
        Err(error) => {
            let cleanup = terminate_direct_child(&mut child).await.err();
            if let Some(reader) = stdout_reader {
                discard_reader_after_termination(reader, "OCR stdout").await;
            }
            discard_reader_after_termination(stderr_reader, "OCR stderr").await;
            return Err(match cleanup {
                Some(cleanup) => format!("{label} failed while waiting: {error}; {cleanup}"),
                None => format!("{label} failed while waiting: {error}"),
            });
        }
    };

    let stdout = match stdout_reader {
        Some(reader) => join_bounded_reader(reader, "OCR stdout").await?,
        None => BoundedBytes::default(),
    };
    let stderr = join_bounded_reader(stderr_reader, "OCR stderr").await?;
    if status.success() && stdout.truncated {
        return Err(format!("{label} returned too much stdout output"));
    }
    if stderr.truncated {
        tracing::warn!(
            command = label,
            "OCR launcher diagnostics exceeded the retained tail limit"
        );
    }
    if !status.success() {
        let detail = diagnostic_tail(&stderr.bytes)
            .or_else(|| diagnostic_tail(&stdout.bytes))
            .unwrap_or_else(|| "no diagnostic output".to_string());
        return Err(format!(
            "{label} failed with exit code {}: {detail}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ));
    }

    Ok(CheckedCommandOutput {
        stdout: stdout.bytes,
    })
}

async fn run_pipeline(
    executable: &Path,
    target: &OllamaTarget,
    job: &OcrJobDir,
    input: &Path,
    input_kind: PipelineInputKind,
) -> Result<PipelineOutput, String> {
    let output_dir = job.output_path();
    std::fs::create_dir(&output_dir)
        .map_err(|error| format!("Failed to prepare GLM-OCR Pipeline output: {error}"))?;
    // See process_image: a real Pipeline run must own the lease until WSL exits.
    run_checked_command(
        executable,
        pipeline_arguments(input, &output_dir, input_kind),
        &target.pipeline_environment(),
        &job.root,
        StdoutMode::Discard,
        None,
        "GLM-OCR Pipeline",
    )
    .await?;

    read_pipeline_output(&output_dir, input_kind)
}

fn pipeline_arguments(
    input: &Path,
    output_dir: &Path,
    input_kind: PipelineInputKind,
) -> Vec<OsString> {
    let mut args = vec![
        input.as_os_str().to_os_string(),
        OsString::from("--output"),
        output_dir.as_os_str().to_os_string(),
        OsString::from("--no-layout-vis"),
        OsString::from("--log-level"),
        OsString::from("ERROR"),
    ];
    if input_kind == PipelineInputKind::Pdf {
        args.extend([
            OsString::from("--json-only"),
            OsString::from("--set"),
            OsString::from("pipeline.page_loader.pdf_max_pages"),
            OsString::from(PDF_PAGE_LIMIT_SENTINEL.to_string()),
        ]);
    }
    args
}

fn output_from_router_text(
    route: RouterResult,
    route_name: &'static str,
) -> Result<LocalOcrOutput, String> {
    let text = route.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err(format!("Vision Router returned empty {route_name} text"));
    }

    let mut warnings = route.warnings;
    let mut degraded = false;
    if route.route == RouterRoute::Tile {
        degraded = true;
        warnings.push("超宽或长图已分块识别，请重点核对跨分块边界的文字与表格。".to_string());
        let tiles = route
            .tiles
            .ok_or_else(|| "Vision Router tile result is missing tile counts".to_string())?;
        if tiles.total == 0 || tiles.succeeded == 0 || tiles.succeeded > tiles.total {
            return Err("Vision Router returned invalid tile counts".to_string());
        }
        if tiles.succeeded < tiles.total {
            warnings.push(format!(
                "分块识别仅完成 {}/{} 个区域，结果可能不完整。",
                tiles.succeeded, tiles.total
            ));
        }
    }

    Ok(LocalOcrOutput {
        text,
        route: route_name,
        reason: route.reason,
        warnings,
        degraded,
        page_count: Some(1),
    })
}

fn parse_router_capabilities(stdout: &[u8]) -> Result<RouterCapabilities, String> {
    let text = text_output(stdout, "Vision Router capabilities")?;
    serde_json::from_str(text.trim())
        .map_err(|error| format!("Vision Router capabilities are invalid JSON: {error}"))
}

fn validate_router_capabilities(capabilities: &RouterCapabilities) -> Result<(), String> {
    let compatible = capabilities.name == "vision-router"
        && !capabilities.version.trim().is_empty()
        && capabilities
            .protocols
            .iter()
            .any(|protocol| protocol == ROUTER_PROTOCOL)
        && capabilities
            .result_formats
            .iter()
            .any(|format| format == "json-v1")
        && capabilities.tile_modes.iter().any(|mode| mode == "auto")
        && capabilities.pipeline_owner == "caller";
    if compatible {
        Ok(())
    } else {
        Err("Vision Router capabilities are incompatible with EchoLike OCR".to_string())
    }
}

fn parse_router_result(stdout: &[u8]) -> Result<RouterResult, String> {
    let text = text_output(stdout, "Vision Router result")?;
    let result: RouterResult = serde_json::from_str(text.trim())
        .map_err(|error| format!("Vision Router result is invalid JSON: {error}"))?;
    if result.version != ROUTER_RESULT_VERSION {
        return Err(format!(
            "Vision Router result version {} is unsupported",
            result.version
        ));
    }
    Ok(result)
}

fn read_pipeline_output(
    output_dir: &Path,
    input_kind: PipelineInputKind,
) -> Result<PipelineOutput, String> {
    let result_root = output_dir.join("input");
    let json_path = result_root.join("input.json");
    let json = json_path
        .is_file()
        .then(|| read_bounded_text_file(&json_path, "GLM-OCR Pipeline JSON"))
        .transpose()?;

    let markdown = if input_kind == PipelineInputKind::Image {
        let markdown_path = result_root.join("input.md");
        markdown_path
            .is_file()
            .then(|| read_bounded_text_file(&markdown_path, "GLM-OCR Pipeline Markdown"))
            .transpose()?
    } else {
        None
    };

    pipeline_output_from_texts(json.as_deref(), markdown.as_deref(), input_kind)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PipelineJsonText {
    text: String,
    page_count: u32,
    empty_pages: Vec<u32>,
}

fn pipeline_output_from_texts(
    json: Option<&str>,
    markdown: Option<&str>,
    input_kind: PipelineInputKind,
) -> Result<PipelineOutput, String> {
    let parsed_json = json.map(pipeline_text_from_json);

    if input_kind == PipelineInputKind::Pdf {
        let parsed = parsed_json
            .ok_or_else(|| "GLM-OCR Pipeline PDF JSON artifact is missing".to_string())??;
        if parsed.page_count >= PDF_PAGE_LIMIT_SENTINEL {
            return Err(format!(
                "PDF exceeds the {PDF_MAX_PAGES}-page local OCR limit"
            ));
        }
        if parsed.text.trim().is_empty() {
            return Err("GLM-OCR Pipeline PDF JSON contains no usable text".to_string());
        }
        let degraded = !parsed.empty_pages.is_empty();
        let warnings = degraded
            .then(|| {
                format!(
                    "第 {} 页未提取到文字，可能是空白页或该页识别不完整。",
                    parsed
                        .empty_pages
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join("、")
                )
            })
            .into_iter()
            .collect();
        return Ok(PipelineOutput {
            text: parsed.text,
            page_count: Some(parsed.page_count),
            warnings,
            degraded,
        });
    }

    let mut json_error = None;
    if let Some(parsed) = parsed_json {
        match parsed {
            Ok(parsed) if !parsed.text.trim().is_empty() => {
                let degraded = !parsed.empty_pages.is_empty();
                let warnings = degraded
                    .then(|| {
                        format!(
                            "文档管线未能从第 {} 页提取文字，结果可能不完整。",
                            parsed
                                .empty_pages
                                .iter()
                                .map(u32::to_string)
                                .collect::<Vec<_>>()
                                .join("、")
                        )
                    })
                    .into_iter()
                    .collect();
                return Ok(PipelineOutput {
                    text: parsed.text,
                    page_count: Some(parsed.page_count),
                    warnings,
                    degraded,
                });
            }
            Ok(_) => json_error = Some("GLM-OCR Pipeline JSON contains no usable text".to_string()),
            Err(error) => json_error = Some(error),
        }
    }

    if let Some(markdown) = markdown {
        let text = strip_pipeline_image_links(markdown);
        if !text.is_empty() {
            return Ok(PipelineOutput {
                text,
                page_count: None,
                warnings: vec![
                    "文档管线的结构化结果不可用，当前展示 Markdown 降级结果。".to_string()
                ],
                degraded: true,
            });
        }
    }

    Err(json_error.unwrap_or_else(|| "GLM-OCR Pipeline did not produce usable text".to_string()))
}

fn pipeline_text_from_json(json: &str) -> Result<PipelineJsonText, String> {
    let pages = serde_json::from_str::<serde_json::Value>(json)
        .map_err(|error| format!("GLM-OCR Pipeline JSON is invalid: {error}"))?;
    let pages = pages
        .as_array()
        .filter(|pages| !pages.is_empty())
        .ok_or_else(|| "GLM-OCR Pipeline JSON contains no pages".to_string())?;
    let mut output = Vec::new();
    let mut empty_pages = Vec::new();

    for (page_index, page) in pages.iter().enumerate() {
        let regions = page
            .as_array()
            .ok_or_else(|| "GLM-OCR Pipeline JSON page is invalid".to_string())?;
        let mut contents = Vec::new();
        for (region_index, region) in regions.iter().enumerate() {
            let region = region.as_object().ok_or_else(|| {
                format!(
                    "GLM-OCR Pipeline JSON page {} region {} is invalid",
                    page_index + 1,
                    region_index + 1
                )
            })?;
            let label = region
                .get("label")
                .and_then(|value| value.as_str())
                .filter(|label| !label.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "GLM-OCR Pipeline JSON page {} region {} label is invalid",
                        page_index + 1,
                        region_index + 1
                    )
                })?;
            let content = region.get("content").ok_or_else(|| {
                format!(
                    "GLM-OCR Pipeline JSON page {} region {} content is invalid",
                    page_index + 1,
                    region_index + 1
                )
            })?;
            match content {
                serde_json::Value::String(content) if !content.trim().is_empty() => {
                    let content = strip_pipeline_image_links(content);
                    if !content.is_empty() {
                        contents.push(content);
                    }
                }
                serde_json::Value::Null if label == "image" => {}
                serde_json::Value::String(content)
                    if label == "image" && content.trim().is_empty() => {}
                _ => {
                    return Err(format!(
                        "GLM-OCR Pipeline JSON page {} region {} content is invalid",
                        page_index + 1,
                        region_index + 1
                    ))
                }
            }
        }
        if contents.is_empty() {
            empty_pages.push(page_index as u32 + 1);
            continue;
        }
        let body = contents.join("\n\n");
        if pages.len() > 1 {
            output.push(format!("## 第 {} 页\n\n{body}", page_index + 1));
        } else {
            output.push(body);
        }
    }

    Ok(PipelineJsonText {
        text: output.join("\n\n").trim().to_string(),
        page_count: pages.len() as u32,
        empty_pages,
    })
}

fn strip_pipeline_image_links(markdown: &str) -> String {
    markdown
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .filter(|line| !is_pipeline_owned_image_line(line))
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn is_pipeline_owned_image_line(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with("![") {
        return false;
    }
    let Some(destination_start) = trimmed.find("](") else {
        return false;
    };
    let Some(destination_end) = trimmed[destination_start + 2..].find(')') else {
        return false;
    };
    let destination_end = destination_start + 2 + destination_end;
    if !trimmed[destination_end + 1..].trim().is_empty() {
        return false;
    }
    let destination = trimmed[destination_start + 2..destination_end]
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(['<', '>'])
        .replace('\\', "/");
    destination
        .strip_prefix("./")
        .unwrap_or(&destination)
        .starts_with("imgs/")
}

fn read_bounded_text_file(path: &Path, label: &str) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Failed to inspect {label}: {error}"))?;
    if metadata.len() > MAX_RESULT_FILE_BYTES {
        return Err(format!("{label} is too large"));
    }
    std::fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))
}

fn normalize_image_extension(extension: &str) -> &'static str {
    match extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        "bmp" => "bmp",
        _ => "png",
    }
}

fn text_output<'a>(bytes: &'a [u8], label: &str) -> Result<&'a str, String> {
    std::str::from_utf8(bytes).map_err(|error| format!("{label} is not UTF-8: {error}"))
}

fn diagnostic_tail(bytes: &[u8]) -> Option<String> {
    let start = bytes.len().saturating_sub(4096);
    let text = String::from_utf8_lossy(&bytes[start..]).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_current_router_capability_contract() {
        let capabilities = parse_router_capabilities(
            br#"{"name":"vision-router","version":"1.0.0-paseo.3","protocols":["paseo-router-json-v1"],"resultFormats":["text","json-v1"],"tileModes":["auto","force","off"],"pipelineOwner":"caller"}"#,
        )
        .unwrap();

        assert!(validate_router_capabilities(&capabilities).is_ok());
    }

    #[test]
    fn rejects_a_router_that_does_not_leave_pipeline_ownership_to_the_caller() {
        let capabilities = RouterCapabilities {
            name: "vision-router".to_string(),
            version: "1".to_string(),
            protocols: vec![ROUTER_PROTOCOL.to_string()],
            result_formats: vec!["json-v1".to_string()],
            tile_modes: vec!["auto".to_string()],
            pipeline_owner: "router".to_string(),
        };

        assert!(validate_router_capabilities(&capabilities).is_err());
    }

    #[test]
    fn parses_direct_tile_and_pipeline_results() {
        let direct = parse_router_result(
            br#"{"version":1,"route":"direct","reason":"fast-pass-sufficient","text":"hello"}"#,
        )
        .unwrap();
        assert_eq!(direct.route, RouterRoute::Direct);

        let tile = parse_router_result(
            br#"{"version":1,"route":"tile","reason":"forced-wide","text":"hello","tiles":{"total":2,"succeeded":2}}"#,
        )
        .unwrap();
        assert_eq!(tile.tiles.unwrap().total, 2);

        let pipeline = parse_router_result(
            br#"{"version":1,"route":"pipeline","reason":"dense","fallbackText":"fallback","warnings":["notice"]}"#,
        )
        .unwrap();
        assert_eq!(pipeline.fallback_text.as_deref(), Some("fallback"));
    }

    #[test]
    fn rejects_unknown_router_result_versions() {
        let error =
            parse_router_result(br#"{"version":2,"route":"direct","reason":"new","text":"hello"}"#)
                .unwrap_err();
        assert!(error.contains("unsupported"));
    }

    #[test]
    fn marks_partial_tile_results_as_degraded() {
        let result = output_from_router_text(
            RouterResult {
                version: 1,
                route: RouterRoute::Tile,
                reason: "wide".to_string(),
                text: Some("partial".to_string()),
                fallback_text: None,
                warnings: Vec::new(),
                tiles: Some(RouterTiles {
                    total: 3,
                    succeeded: 2,
                }),
            },
            "tile",
        )
        .unwrap();

        assert!(result.degraded);
        assert_eq!(result.warnings.len(), 2);
    }

    #[test]
    fn marks_complete_tile_results_as_degraded_until_seam_stitching_is_guaranteed() {
        let result = output_from_router_text(
            RouterResult {
                version: 1,
                route: RouterRoute::Tile,
                reason: "wide".to_string(),
                text: Some("all tiles returned".to_string()),
                fallback_text: None,
                warnings: Vec::new(),
                tiles: Some(RouterTiles {
                    total: 3,
                    succeeded: 3,
                }),
            },
            "tile",
        )
        .unwrap();

        assert!(result.degraded);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("跨分块边界")));
    }

    #[test]
    fn parses_pipeline_pages_without_temporary_image_links() {
        let json = r##"[
          [{"label":"paragraph_title","content":"# 第一页"},{"label":"image","content":null}],
          [{"label":"text","content":"第二页正文"}]
        ]"##;

        let output = pipeline_text_from_json(json).unwrap();
        assert_eq!(output.page_count, 2);
        assert!(output.empty_pages.is_empty());
        assert_eq!(
            output.text,
            "## 第 1 页\n\n# 第一页\n\n## 第 2 页\n\n第二页正文"
        );
    }

    #[test]
    fn strips_only_pipeline_owned_image_links_from_markdown_fallback() {
        let markdown = [
            "![Image 0-0](imgs/cropped_page0_idx0.jpg)",
            "![](./imgs/cropped_page0_idx1.jpg)",
            "",
            "# 标题",
            "",
            "![External](https://example.com/image.png)",
        ]
        .join("\n");

        assert_eq!(
            strip_pipeline_image_links(&markdown),
            "# 标题\n\n![External](https://example.com/image.png)"
        );
    }

    #[test]
    fn parses_only_plain_http_ollama_origins() {
        let target = OllamaTarget::parse("http://127.0.0.1:11434/", "glm-ocr:latest").unwrap();
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 11434);

        let ipv6 = OllamaTarget::parse("http://[::1]:11434", "glm-ocr:latest").unwrap();
        assert_eq!(ipv6.host, "127.0.0.1");

        assert!(OllamaTarget::parse("https://localhost:11434", "glm-ocr").is_err());
        assert!(OllamaTarget::parse("http://localhost:11434/api", "glm-ocr").is_err());
        assert!(OllamaTarget::parse("http://user:pass@localhost:11434", "glm-ocr").is_err());
        assert!(OllamaTarget::parse("http://192.168.1.20:11434", "glm-ocr").is_err());
    }

    #[test]
    fn job_directory_is_removed_when_its_guard_drops() {
        let path = {
            let job = OcrJobDir::create().unwrap();
            let path = job.root.clone();
            std::fs::write(job.input_path("png"), b"image").unwrap();
            assert!(path.is_dir());
            path
        };

        assert!(!path.exists());
    }

    #[test]
    fn stale_cleanup_removes_only_marked_owned_job_directories() {
        let parent = std::env::temp_dir().join(format!(
            "echolike-ocr-cleanup-test-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let owned = parent.join("job-owned");
        let unmarked = parent.join("job-unmarked");
        let unrelated = parent.join("other-owned");
        for path in [&owned, &unmarked, &unrelated] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(owned.join(JOB_OWNER_MARKER), b"1\n").unwrap();
        std::fs::write(unrelated.join(JOB_OWNER_MARKER), b"1\n").unwrap();

        cleanup_stale_job_dirs(
            &parent,
            SystemTime::now() + Duration::from_secs(1),
            Duration::ZERO,
        );

        assert!(!owned.exists());
        assert!(unmarked.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn process_level_lease_rejects_concurrent_local_ocr_runs() {
        let first = loop {
            if let Ok(run) = acquire_local_ocr_run() {
                break run;
            }
            std::thread::yield_now();
        };
        assert!(acquire_local_ocr_run().is_err());

        let parent = std::env::temp_dir().join(format!(
            "echolike-ocr-active-cleanup-test-{}-{}",
            std::process::id(),
            JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let active = parent.join("job-active");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::write(active.join(JOB_OWNER_MARKER), b"1\n").unwrap();
        cleanup_stale_job_dirs_if_idle(
            &parent,
            SystemTime::now() + Duration::from_secs(1),
            Duration::ZERO,
        );
        assert!(active.exists());

        drop(first);
        cleanup_stale_job_dirs_if_idle(
            &parent,
            SystemTime::now() + Duration::from_secs(1),
            Duration::ZERO,
        );
        assert!(!active.exists());
        std::fs::remove_dir_all(parent).unwrap();
        assert!(acquire_local_ocr_run().is_ok());
    }

    #[test]
    fn removes_ambient_paseo_router_pipeline_and_proxy_environment() {
        for name in [
            "PASEO_WSL_DISTRO",
            "PASEO_PASSWORD",
            "VISION_ROUTER_FORCE_PIPELINE",
            "vision_router_tile_width",
            "GLMOCR_OCR_MODEL",
            "HTTP_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "NO_PROXY",
            "WSLENV",
            "ZHIPU_API_KEY",
        ] {
            assert!(
                should_remove_runtime_environment(OsStr::new(name)),
                "{name}"
            );
        }

        for name in ["PATH", "SYSTEMROOT", "USERPROFILE", "TEMP"] {
            assert!(
                !should_remove_runtime_environment(OsStr::new(name)),
                "{name}"
            );
        }
    }

    #[test]
    fn pdf_pipeline_arguments_pin_the_twenty_one_page_sentinel() {
        let args = pipeline_arguments(
            Path::new(r"C:\input.pdf"),
            Path::new(r"C:\output"),
            PipelineInputKind::Pdf,
        );
        let args = args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args
            .windows(3)
            .any(|window| { window == ["--set", "pipeline.page_loader.pdf_max_pages", "21",] }));
    }

    #[test]
    fn rejects_pdf_output_at_the_page_limit_sentinel() {
        let pages = (1..=PDF_PAGE_LIMIT_SENTINEL)
            .map(|page| serde_json::json!([{"label":"text","content": format!("page {page}")}]))
            .collect::<Vec<_>>();
        let json = serde_json::to_string(&pages).unwrap();

        let error =
            pipeline_output_from_texts(Some(&json), None, PipelineInputKind::Pdf).unwrap_err();
        assert!(error.contains("20-page"));
    }

    #[test]
    fn accepts_a_twenty_page_pdf_json_artifact() {
        let pages = (1..=PDF_MAX_PAGES)
            .map(|page| serde_json::json!([{"label":"text","content": format!("page {page}")}]))
            .collect::<Vec<_>>();
        let json = serde_json::to_string(&pages).unwrap();

        let output = pipeline_output_from_texts(Some(&json), None, PipelineInputKind::Pdf).unwrap();
        assert_eq!(output.page_count, Some(PDF_MAX_PAGES));
        assert!(!output.degraded);
    }

    #[test]
    fn keeps_a_pdf_with_a_blank_page_as_an_explicitly_degraded_result() {
        let json = serde_json::json!([
            [{"label": "text", "content": "first"}],
            [],
            [{"label": "text", "content": "third"}]
        ])
        .to_string();

        let output = pipeline_output_from_texts(Some(&json), None, PipelineInputKind::Pdf).unwrap();

        assert_eq!(output.page_count, Some(3));
        assert!(output.degraded);
        assert!(output.warnings.iter().any(|warning| warning.contains('2')));
        assert!(output.text.contains("## 第 1 页"));
        assert!(output.text.contains("## 第 3 页"));
    }

    #[test]
    fn rejects_a_pdf_when_every_page_is_blank() {
        let json = serde_json::json!([[], []]).to_string();

        let error =
            pipeline_output_from_texts(Some(&json), None, PipelineInputKind::Pdf).unwrap_err();

        assert!(error.contains("no usable text"));
    }

    #[test]
    fn rejects_malformed_regions_in_pipeline_json() {
        for json in [
            r#"[[{"label":"text","content":"valid"},42]]"#,
            r#"[[{"content":"missing label"}]]"#,
            r#"[[{"label":"text","content":null}]]"#,
            r#"[[{"label":"text","content":42}]]"#,
        ] {
            let error =
                pipeline_output_from_texts(Some(json), None, PipelineInputKind::Pdf).unwrap_err();
            assert!(error.contains("invalid"), "{error}");
        }
    }

    #[test]
    fn removes_pipeline_owned_image_links_from_structured_content() {
        let json = serde_json::json!([[{
            "label": "text",
            "content": "![crop](imgs/cropped_page0_idx0.jpg)\n\n正文"
        }]])
        .to_string();

        let output = pipeline_output_from_texts(Some(&json), None, PipelineInputKind::Pdf).unwrap();

        assert_eq!(output.text, "正文");
    }

    #[test]
    fn pdf_cannot_bypass_structured_output_with_markdown_fallback() {
        let error = pipeline_output_from_texts(
            Some("not-json"),
            Some("apparently usable markdown"),
            PipelineInputKind::Pdf,
        )
        .unwrap_err();

        assert!(error.contains("JSON"));
    }

    #[test]
    fn image_markdown_fallback_is_explicitly_degraded() {
        let output = pipeline_output_from_texts(
            Some("not-json"),
            Some("# fallback"),
            PipelineInputKind::Image,
        )
        .unwrap();

        assert_eq!(output.text, "# fallback");
        assert!(output.degraded);
        assert_eq!(output.page_count, None);
        assert!(!output.warnings.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bounded_reader_rejects_chatty_output_before_buffering_it_all() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(64);
        let writer_task = tokio::spawn(async move {
            writer.write_all(&[b'x'; 65]).await.unwrap();
        });

        let output = read_stream_bounded(reader, 64, "test output")
            .await
            .unwrap();
        writer_task.await.unwrap();
        assert_eq!(output.bytes.len(), 64);
        assert!(output.truncated);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bounded_tail_reader_keeps_the_latest_diagnostics() {
        use tokio::io::AsyncWriteExt;

        let (mut writer, reader) = tokio::io::duplex(32);
        let writer_task = tokio::spawn(async move {
            writer.write_all(b"0123456789").await.unwrap();
        });

        let output = read_stream_tail_bounded(reader, 4, "test diagnostics")
            .await
            .unwrap();
        writer_task.await.unwrap();
        assert_eq!(output.bytes, b"6789");
        assert!(output.truncated);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn command_timeout_kills_and_reaps_the_direct_windows_launcher() {
        let job = OcrJobDir::create().unwrap();
        let powershell = PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap())
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");

        let started = std::time::Instant::now();
        let error = run_checked_command(
            &powershell,
            [
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from("Start-Sleep -Seconds 5"),
            ],
            &[],
            &job.root,
            StdoutMode::Discard,
            Some(Duration::from_millis(50)),
            "timeout test",
        )
        .await
        .unwrap_err();

        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
