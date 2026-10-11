use super::atomic_file::{atomic_write_with, replace_file_atomically};
use super::RUNTIME_STATE_STORE_FILE;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
const DESKTOP_AUTH_STATE_FILE: &str = "desktop-auth-state-v1.json";
const DESKTOP_AUTH_STATE_SCHEMA: &str = "echolike.desktop-auth-state";
const DESKTOP_AUTH_STATE_SCHEMA_VERSION: u32 = 1;
static DESKTOP_AUTH_STATE_LOCK: Mutex<()> = Mutex::new(());
static DESKTOP_AUTH_GENERATION_FLOOR: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopBootstrapCache {
    pub package_version: String,
    pub bootstrap: serde_json::Value,
    pub auth_token: Option<String>,
    pub cached_at: String,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DesktopAuthState {
    generation: u64,
    authority_token: Option<String>,
    cache: Option<DesktopBootstrapCache>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DesktopAuthStateEnvelope {
    schema: String,
    schema_version: u32,
    checksum: String,
    state: DesktopAuthState,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopAuthSnapshot {
    pub generation: u64,
    pub authority_token: Option<String>,
    pub cache: Option<DesktopBootstrapCache>,
    pub raw_cached_auth_token: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct DesktopAuthRuntimeIdentity {
    generation: u64,
    authority_token: Option<String>,
}

#[derive(Default)]
pub struct DesktopAuthRuntimeFence {
    confirmed: Mutex<Option<DesktopAuthRuntimeIdentity>>,
}

impl DesktopAuthRuntimeFence {
    pub fn confirm(&self, snapshot: &DesktopAuthSnapshot) {
        *self
            .confirmed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(DesktopAuthRuntimeIdentity {
            generation: snapshot.generation,
            authority_token: snapshot.authority_token.clone(),
        });
    }

    pub fn invalidate_if_matches(
        &self,
        expected_generation: u64,
        expected_authority_token: Option<&str>,
    ) -> bool {
        let expected = DesktopAuthRuntimeIdentity {
            generation: expected_generation,
            authority_token: normalized_auth_token_owned(expected_authority_token),
        };
        let mut confirmed = self
            .confirmed
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if confirmed.as_ref() != Some(&expected) {
            return false;
        }
        *confirmed = None;
        true
    }

    pub fn matches(&self, snapshot: &DesktopAuthSnapshot) -> bool {
        self.confirmed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .is_some_and(|identity| {
                identity.generation == snapshot.generation
                    && identity.authority_token == snapshot.authority_token
            })
    }
}

fn bootstrap_cache_matches_package(cache: &DesktopBootstrapCache, package_version: &str) -> bool {
    cache.package_version == package_version
}

fn normalized_auth_token(auth_token: Option<&str>) -> Option<&str> {
    auth_token.map(str::trim).filter(|value| !value.is_empty())
}

fn normalized_auth_token_owned(auth_token: Option<&str>) -> Option<String> {
    normalized_auth_token(auth_token).map(ToString::to_string)
}

fn desktop_bootstrap_user_email(bootstrap: &serde_json::Value) -> Result<Option<&str>> {
    match bootstrap.pointer("/user/email") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(email)) => {
            Ok(Some(email.trim()).filter(|value| !value.is_empty()))
        }
        Some(_) => anyhow::bail!("desktop bootstrap user email has an invalid type"),
    }
}

fn bootstrap_generated_at(
    bootstrap: &serde_json::Value,
) -> Result<chrono::DateTime<chrono::FixedOffset>> {
    let generated_at = bootstrap
        .get("generatedAt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("desktop bootstrap is missing generatedAt")?;
    chrono::DateTime::parse_from_rfc3339(generated_at)
        .context("desktop bootstrap generatedAt is invalid")
}

fn validate_desktop_bootstrap_cache(cache: &DesktopBootstrapCache) -> Result<()> {
    anyhow::ensure!(
        !cache.package_version.trim().is_empty(),
        "desktop bootstrap cache package version is empty"
    );
    anyhow::ensure!(
        normalized_auth_token(cache.auth_token.as_deref()) == cache.auth_token.as_deref(),
        "desktop bootstrap cache auth identity is not normalized"
    );
    anyhow::ensure!(
        normalized_auth_token(cache.auth_token.as_deref()).is_some()
            == desktop_bootstrap_user_email(&cache.bootstrap)?.is_some(),
        "desktop bootstrap cache auth identity does not match its user"
    );
    bootstrap_generated_at(&cache.bootstrap)?;
    chrono::DateTime::parse_from_rfc3339(cache.cached_at.trim())
        .context("desktop bootstrap cache timestamp is invalid")?;
    Ok(())
}

fn validate_desktop_auth_state(state: &DesktopAuthState) -> Result<()> {
    anyhow::ensure!(
        normalized_auth_token(state.authority_token.as_deref()) == state.authority_token.as_deref(),
        "desktop auth authority is not normalized"
    );
    if let Some(cache) = &state.cache {
        validate_desktop_bootstrap_cache(cache)?;
        anyhow::ensure!(
            normalized_auth_token(cache.auth_token.as_deref()) == state.authority_token.as_deref(),
            "desktop bootstrap cache identity does not match native authority"
        );
    }
    Ok(())
}

fn desktop_auth_checksum(state: &DesktopAuthState) -> Result<String> {
    const CRC32_POLYNOMIAL: u32 = 0xedb8_8320;
    let bytes =
        serde_json::to_vec(state).context("serialize desktop auth state checksum payload")?;
    let mut checksum = u32::MAX;
    for byte in bytes {
        checksum ^= u32::from(byte);
        for _ in 0..u8::BITS {
            let least_significant_bit = checksum & 1;
            checksum >>= 1;
            if least_significant_bit != 0 {
                checksum ^= CRC32_POLYNOMIAL;
            }
        }
    }
    Ok(format!("{:08x}", !checksum))
}

fn serialize_desktop_auth_state_envelope(state: &DesktopAuthState) -> Result<Vec<u8>> {
    validate_desktop_auth_state(state)?;
    let envelope = DesktopAuthStateEnvelope {
        schema: DESKTOP_AUTH_STATE_SCHEMA.to_string(),
        schema_version: DESKTOP_AUTH_STATE_SCHEMA_VERSION,
        checksum: desktop_auth_checksum(state)?,
        state: state.clone(),
    };
    serde_json::to_vec_pretty(&envelope).context("serialize desktop auth state envelope")
}

fn parse_desktop_auth_state_envelope(bytes: &[u8]) -> Result<DesktopAuthState> {
    let envelope: DesktopAuthStateEnvelope =
        serde_json::from_slice(bytes).context("parse desktop auth state envelope")?;
    anyhow::ensure!(
        envelope.schema == DESKTOP_AUTH_STATE_SCHEMA,
        "unexpected desktop auth state schema"
    );
    anyhow::ensure!(
        envelope.schema_version == DESKTOP_AUTH_STATE_SCHEMA_VERSION,
        "unsupported desktop auth state schema version"
    );
    anyhow::ensure!(
        envelope.checksum == desktop_auth_checksum(&envelope.state)?,
        "desktop auth state checksum mismatch"
    );
    validate_desktop_auth_state(&envelope.state)?;
    Ok(envelope.state)
}

fn read_desktop_auth_state(path: &Path) -> Result<Option<DesktopAuthState>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read desktop auth state at {}", path.display()))
        }
    };
    parse_desktop_auth_state_envelope(&bytes)
        .with_context(|| format!("validate desktop auth state at {}", path.display()))
        .map(Some)
}

fn persist_desktop_auth_state_with(
    path: &Path,
    state: &DesktopAuthState,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<()> {
    let bytes = serialize_desktop_auth_state_envelope(state)?;
    atomic_write_with(path, &bytes, replace)
}

fn persist_desktop_auth_state(path: &Path, state: &DesktopAuthState) -> Result<()> {
    persist_desktop_auth_state_with(path, state, replace_file_atomically)
}

fn legacy_desktop_auth_state(value: Option<serde_json::Value>) -> DesktopAuthState {
    let authority_token = value
        .as_ref()
        .and_then(|value| value.get("authToken"))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| normalized_auth_token_owned(Some(value)));
    let cache = value
        .and_then(|value| serde_json::from_value::<DesktopBootstrapCache>(value).ok())
        .filter(|cache| validate_desktop_bootstrap_cache(cache).is_ok())
        .filter(|cache| {
            normalized_auth_token(cache.auth_token.as_deref()) == authority_token.as_deref()
        });
    DesktopAuthState {
        generation: 0,
        authority_token,
        cache,
    }
}

fn load_or_migrate_desktop_auth_state(
    path: &Path,
    legacy: impl FnOnce() -> Result<Option<serde_json::Value>>,
) -> Result<DesktopAuthState> {
    if let Some(state) = read_desktop_auth_state(path)? {
        observe_desktop_auth_generation(state.generation);
        return Ok(state);
    }
    let state = legacy_desktop_auth_state(legacy()?);
    persist_desktop_auth_state(path, &state)
        .with_context(|| format!("migrate desktop auth state to {}", path.display()))?;
    let read_back =
        read_desktop_auth_state(path)?.context("desktop auth state is missing after migration")?;
    anyhow::ensure!(
        read_back == state,
        "desktop auth state changed during migration"
    );
    observe_desktop_auth_generation(read_back.generation);
    Ok(read_back)
}

fn desktop_auth_snapshot(state: &DesktopAuthState, package_version: &str) -> DesktopAuthSnapshot {
    let raw_cached_auth_token = state
        .cache
        .as_ref()
        .and_then(|cache| normalized_auth_token_owned(cache.auth_token.as_deref()));
    let cache = state
        .cache
        .as_ref()
        .filter(|cache| bootstrap_cache_matches_package(cache, package_version))
        .filter(|cache| {
            normalized_auth_token(cache.auth_token.as_deref()) == state.authority_token.as_deref()
        })
        .cloned();
    DesktopAuthSnapshot {
        generation: state.generation,
        authority_token: state.authority_token.clone(),
        cache,
        raw_cached_auth_token,
    }
}

fn next_desktop_auth_generation(generation: u64) -> Result<u64> {
    generation
        .checked_add(1)
        .context("desktop auth generation is exhausted")
}

fn observe_desktop_auth_generation(generation: u64) {
    DESKTOP_AUTH_GENERATION_FLOOR.fetch_max(generation, Ordering::SeqCst);
}

fn recovered_desktop_auth_generation(expected_generation: Option<u64>) -> u64 {
    expected_generation
        .unwrap_or_default()
        .max(DESKTOP_AUTH_GENERATION_FLOOR.load(Ordering::SeqCst))
}

fn load_desktop_auth_snapshot_at(
    path: &Path,
    package_version: &str,
    legacy: impl FnOnce() -> Result<Option<serde_json::Value>>,
) -> Result<DesktopAuthSnapshot> {
    let _guard = DESKTOP_AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let state = load_or_migrate_desktop_auth_state(path, legacy)?;
    Ok(desktop_auth_snapshot(&state, package_version))
}

fn begin_desktop_auth_candidate_at(
    path: &Path,
    package_version: &str,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
    legacy: impl FnOnce() -> Result<Option<serde_json::Value>>,
) -> Result<Option<DesktopAuthSnapshot>> {
    let _guard = DESKTOP_AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = load_or_migrate_desktop_auth_state(path, legacy)?;
    if state.generation != expected_generation
        || state.authority_token.as_deref() != normalized_auth_token(expected_authority_token)
    {
        return Ok(None);
    }
    state.generation = next_desktop_auth_generation(state.generation)?;
    persist_desktop_auth_state(path, &state)?;
    observe_desktop_auth_generation(state.generation);
    Ok(Some(desktop_auth_snapshot(&state, package_version)))
}

fn begin_desktop_auth_candidate_for_login_at(
    path: &Path,
    package_version: &str,
    expected_generation: Option<u64>,
    expected_authority_token: Option<&str>,
    next_authority_token: &str,
) -> Result<Option<DesktopAuthSnapshot>> {
    let _guard = DESKTOP_AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let next_authority_token = normalized_auth_token_owned(Some(next_authority_token))
        .context("verified desktop login returned an empty auth token")?;
    let mut state = match read_desktop_auth_state(path) {
        Ok(Some(state)) => {
            observe_desktop_auth_generation(state.generation);
            if expected_generation != Some(state.generation)
                || state.authority_token.as_deref()
                    != normalized_auth_token(expected_authority_token)
            {
                return Ok(None);
            }
            state
        }
        Ok(None) | Err(_) => DesktopAuthState {
            generation: recovered_desktop_auth_generation(expected_generation),
            ..DesktopAuthState::default()
        },
    };
    state.generation = next_desktop_auth_generation(state.generation)?;
    state.authority_token = Some(next_authority_token);
    state.cache = None;
    persist_desktop_auth_state(path, &state)?;
    observe_desktop_auth_generation(state.generation);
    Ok(Some(desktop_auth_snapshot(&state, package_version)))
}

fn commit_desktop_auth_candidate_at(
    path: &Path,
    package_version: &str,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
    expected_raw_cached_auth_token: Option<&str>,
    replacement: DesktopBootstrapCache,
    legacy: impl FnOnce() -> Result<Option<serde_json::Value>>,
) -> Result<Option<DesktopAuthSnapshot>> {
    let _guard = DESKTOP_AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = load_or_migrate_desktop_auth_state(path, legacy)?;
    let expected_authority_token = normalized_auth_token(expected_authority_token);
    if state.generation != expected_generation
        || state.authority_token.as_deref() != expected_authority_token
        || state
            .cache
            .as_ref()
            .and_then(|cache| normalized_auth_token(cache.auth_token.as_deref()))
            != normalized_auth_token(expected_raw_cached_auth_token)
    {
        return Ok(None);
    }
    validate_desktop_bootstrap_cache(&replacement)?;
    anyhow::ensure!(
        replacement.package_version == package_version,
        "desktop bootstrap replacement package version does not match runtime"
    );
    anyhow::ensure!(
        normalized_auth_token(replacement.auth_token.as_deref()) == expected_authority_token,
        "desktop bootstrap replacement identity does not match native authority"
    );
    state.generation = next_desktop_auth_generation(state.generation)?;
    state.cache = Some(replacement);
    persist_desktop_auth_state(path, &state)?;
    observe_desktop_auth_generation(state.generation);
    Ok(Some(desktop_auth_snapshot(&state, package_version)))
}

fn clear_desktop_auth_authority_at(
    path: &Path,
    package_version: &str,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
    legacy: impl FnOnce() -> Result<Option<serde_json::Value>>,
) -> Result<Option<DesktopAuthSnapshot>> {
    let _guard = DESKTOP_AUTH_STATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut state = load_or_migrate_desktop_auth_state(path, legacy)?;
    if state.generation != expected_generation
        || state.authority_token.as_deref() != normalized_auth_token(expected_authority_token)
    {
        return Ok(None);
    }
    state.generation = next_desktop_auth_generation(state.generation)?;
    state.authority_token = None;
    state.cache = None;
    persist_desktop_auth_state(path, &state)?;
    observe_desktop_auth_generation(state.generation);
    Ok(Some(desktop_auth_snapshot(&state, package_version)))
}

fn desktop_auth_state_path(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    app_handle
        .path()
        .app_data_dir()
        .context("resolve app data directory for desktop auth state")
        .map(|directory| directory.join(DESKTOP_AUTH_STATE_FILE))
}

fn legacy_desktop_bootstrap_cache_value(
    app_handle: &tauri::AppHandle,
) -> Result<Option<serde_json::Value>> {
    let store = app_handle
        .store(RUNTIME_STATE_STORE_FILE)
        .map_err(|error| anyhow::anyhow!("Failed to open legacy runtime store: {}", error))?;
    Ok(store.get("desktop_bootstrap_cache"))
}

pub fn load_desktop_auth_snapshot(app_handle: &tauri::AppHandle) -> Result<DesktopAuthSnapshot> {
    let path = desktop_auth_state_path(app_handle)?;
    let package_version = app_handle.package_info().version.to_string();
    load_desktop_auth_snapshot_at(&path, &package_version, || {
        legacy_desktop_bootstrap_cache_value(app_handle)
    })
}

pub fn begin_desktop_auth_candidate(
    app_handle: &tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
) -> Result<Option<DesktopAuthSnapshot>> {
    let path = desktop_auth_state_path(app_handle)?;
    let package_version = app_handle.package_info().version.to_string();
    begin_desktop_auth_candidate_at(
        &path,
        &package_version,
        expected_generation,
        expected_authority_token,
        || legacy_desktop_bootstrap_cache_value(app_handle),
    )
}

pub fn begin_desktop_auth_candidate_for_login(
    app_handle: &tauri::AppHandle,
    expected_generation: Option<u64>,
    expected_authority_token: Option<&str>,
    next_authority_token: &str,
) -> Result<Option<DesktopAuthSnapshot>> {
    let path = desktop_auth_state_path(app_handle)?;
    let package_version = app_handle.package_info().version.to_string();
    begin_desktop_auth_candidate_for_login_at(
        &path,
        &package_version,
        expected_generation,
        expected_authority_token,
        next_authority_token,
    )
}

pub fn commit_desktop_auth_candidate(
    app_handle: &tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
    expected_raw_cached_auth_token: Option<&str>,
    replacement: DesktopBootstrapCache,
) -> Result<Option<DesktopAuthSnapshot>> {
    let path = desktop_auth_state_path(app_handle)?;
    let package_version = app_handle.package_info().version.to_string();
    commit_desktop_auth_candidate_at(
        &path,
        &package_version,
        expected_generation,
        expected_authority_token,
        expected_raw_cached_auth_token,
        replacement,
        || legacy_desktop_bootstrap_cache_value(app_handle),
    )
}

pub fn clear_desktop_auth_authority(
    app_handle: &tauri::AppHandle,
    expected_generation: u64,
    expected_authority_token: Option<&str>,
) -> Result<Option<DesktopAuthSnapshot>> {
    let path = desktop_auth_state_path(app_handle)?;
    let package_version = app_handle.package_info().version.to_string();
    clear_desktop_auth_authority_at(
        &path,
        &package_version,
        expected_generation,
        expected_authority_token,
        || legacy_desktop_bootstrap_cache_value(app_handle),
    )
}

pub fn cloud_policy_force_update(app_handle: &tauri::AppHandle) -> bool {
    load_desktop_auth_snapshot(app_handle)
        .ok()
        .and_then(|snapshot| snapshot.cache)
        .and_then(|cache| {
            cache
                .bootstrap
                .pointer("/ota/forceUpdate")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Barrier};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn test_directory(name: &str) -> PathBuf {
        let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "echolike-storage-{name}-{}-{sequence}",
                std::process::id()
            ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn desktop_auth_test_directory(name: &str) -> PathBuf {
        test_directory(&format!("auth-state-{name}"))
    }

    fn desktop_auth_cache(
        token: Option<&str>,
        package_version: &str,
        generated_at: &str,
    ) -> DesktopBootstrapCache {
        DesktopBootstrapCache {
            package_version: package_version.to_string(),
            bootstrap: serde_json::json!({
                "schemaVersion": 1,
                "generatedAt": generated_at,
                "user": {
                    "email": token.map(|_| "person@example.com")
                }
            }),
            auth_token: token.map(ToString::to_string),
            cached_at: generated_at.to_string(),
        }
    }

    #[test]
    fn bootstrap_cache_requires_an_exact_package_version_match() {
        let cache = DesktopBootstrapCache {
            package_version: "0.2.0".to_string(),
            bootstrap: serde_json::json!({ "services": {} }),
            auth_token: None,
            cached_at: "2026-07-16T00:00:00Z".to_string(),
        };

        assert!(bootstrap_cache_matches_package(&cache, "0.2.0"));
        assert!(!bootstrap_cache_matches_package(&cache, "v0.2.0"));
        assert!(!bootstrap_cache_matches_package(&cache, "0.2.1"));
    }

    #[test]
    fn desktop_auth_envelope_rejects_truncation_and_checksum_mismatch_without_legacy_fallback() {
        let directory = desktop_auth_test_directory("corruption");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        fs::write(&path, b"{\"schema\":").unwrap();

        let truncated = load_desktop_auth_snapshot_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            || -> Result<Option<serde_json::Value>> {
                panic!("corrupt native state must not fall back to legacy storage")
            },
        )
        .err()
        .expect("truncated auth envelope must fail closed");
        assert!(format!("{truncated:#}").contains("desktop auth state envelope"));

        fs::remove_file(&path).unwrap();
        let snapshot =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(None)).unwrap();
        assert_eq!(snapshot.generation, 0);
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        envelope["checksum"] = serde_json::json!("invalid-checksum");
        fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();

        let checksum = load_desktop_auth_snapshot_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            || -> Result<Option<serde_json::Value>> {
                panic!("invalid checksum must not fall back to legacy storage")
            },
        )
        .err()
        .expect("auth envelope checksum mismatch must fail closed");
        assert!(format!("{checksum:#}").contains("checksum"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_envelope_strictly_rejects_schema_version_and_unknown_fields() {
        let directory = desktop_auth_test_directory("strict-envelope");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        persist_desktop_auth_state(&path, &DesktopAuthState::default()).unwrap();
        let valid: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();

        let mut wrong_schema = valid.clone();
        wrong_schema["schema"] = serde_json::json!("unexpected-schema");
        fs::write(&path, serde_json::to_vec(&wrong_schema).unwrap()).unwrap();
        let schema_error = read_desktop_auth_state(&path)
            .err()
            .expect("wrong schema must fail closed");
        assert!(format!("{schema_error:#}").contains("schema"));

        let mut wrong_version = valid.clone();
        wrong_version["schemaVersion"] =
            serde_json::json!(DESKTOP_AUTH_STATE_SCHEMA_VERSION.saturating_add(1));
        fs::write(&path, serde_json::to_vec(&wrong_version).unwrap()).unwrap();
        let version_error = read_desktop_auth_state(&path)
            .err()
            .expect("wrong schema version must fail closed");
        assert!(format!("{version_error:#}").contains("version"));

        let mut unknown_field = valid;
        unknown_field["state"]["unexpected"] = serde_json::json!(true);
        fs::write(&path, serde_json::to_vec(&unknown_field).unwrap()).unwrap();
        let unknown_field_error = read_desktop_auth_state(&path)
            .err()
            .expect("unknown state fields must fail closed");
        assert!(format!("{unknown_field_error:#}").contains("unknown field"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn verified_login_can_recover_corrupt_or_missing_native_auth_state_without_legacy_fallback() {
        let directory = desktop_auth_test_directory("login-recovery");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        fs::write(
            &path,
            b"{\"authorityToken\":\"diagnostic-token-must-not-leak",
        )
        .unwrap();

        let load_error = load_desktop_auth_snapshot_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            || -> Result<Option<serde_json::Value>> {
                panic!("ordinary load must not fall back from corrupt native state")
            },
        )
        .err()
        .expect("ordinary load must reject a corrupt auth envelope");
        assert!(!format!("{load_error:#}").contains("diagnostic-token-must-not-leak"));

        let recovered = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            Some(41),
            Some("previous-session-token"),
            "verified-login-token",
        )
        .unwrap()
        .unwrap();
        assert!(recovered.generation > 41);
        assert_eq!(
            recovered.authority_token.as_deref(),
            Some("verified-login-token")
        );
        assert!(recovered.cache.is_none());

        let rotated = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            Some(recovered.generation),
            recovered.authority_token.as_deref(),
            "other-login-token",
        )
        .unwrap()
        .unwrap();
        assert!(rotated.generation > recovered.generation);

        let stale_recovery = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            Some(recovered.generation),
            recovered.authority_token.as_deref(),
            "stale-login-token",
        )
        .unwrap();
        assert!(stale_recovery.is_none());

        fs::remove_file(&path).unwrap();
        let recovered_missing = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            None,
            None,
            "verified-login-token",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            recovered_missing.authority_token.as_deref(),
            Some("verified-login-token")
        );
        assert!(recovered_missing.cache.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_state_migrates_the_legacy_cache_once_and_uses_private_atomic_storage() {
        let directory = desktop_auth_test_directory("legacy-migration");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let legacy = desktop_auth_cache(
            Some("legacy-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T01:00:00Z",
        );
        let snapshot = load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || {
            Ok(Some(serde_json::to_value(&legacy).unwrap()))
        })
        .unwrap();

        assert_eq!(snapshot.generation, 0);
        assert_eq!(
            snapshot.authority_token.as_deref(),
            Some("legacy-session-token")
        );
        assert_eq!(
            snapshot.raw_cached_auth_token.as_deref(),
            Some("legacy-session-token")
        );
        assert!(snapshot.cache.is_some());
        assert!(path.is_file());

        let reloaded = load_desktop_auth_snapshot_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            || -> Result<Option<serde_json::Value>> {
                panic!("legacy storage must not be read after the envelope exists")
            },
        )
        .unwrap();
        assert_eq!(reloaded.generation, snapshot.generation);
        let other_package = load_desktop_auth_snapshot_at(&path, "different-package", || {
            panic!("legacy storage must remain retired across package changes")
        })
        .unwrap();
        assert!(other_package.cache.is_none());
        assert_eq!(
            other_package.raw_cached_auth_token.as_deref(),
            Some("legacy-session-token")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_legacy_migration_drops_an_invalid_cache_but_keeps_its_identity_fence() {
        let directory = desktop_auth_test_directory("invalid-legacy-cache");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let legacy = serde_json::json!({
            "packageVersion": env!("CARGO_PKG_VERSION"),
            "bootstrap": {
                "schemaVersion": 1,
                "generatedAt": "2026-07-30T01:00:00Z",
                "user": { "email": null }
            },
            "authToken": "legacy-session-token",
            "cachedAt": "2026-07-30T01:00:00Z"
        });

        let snapshot =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(Some(legacy)))
                .unwrap();

        assert_eq!(
            snapshot.authority_token.as_deref(),
            Some("legacy-session-token")
        );
        assert!(snapshot.raw_cached_auth_token.is_none());
        assert!(snapshot.cache.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_commit_rejects_a_token_bound_to_an_anonymous_bootstrap() {
        let directory = desktop_auth_test_directory("anonymous-token-commit");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let initial =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(None)).unwrap();
        let candidate = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            Some(initial.generation),
            initial.authority_token.as_deref(),
            "session-token",
        )
        .unwrap()
        .unwrap();
        let anonymous = DesktopBootstrapCache {
            package_version: env!("CARGO_PKG_VERSION").to_string(),
            bootstrap: serde_json::json!({
                "schemaVersion": 1,
                "generatedAt": "2026-07-30T02:00:00Z",
                "user": { "email": null }
            }),
            auth_token: Some("session-token".to_string()),
            cached_at: "2026-07-30T02:00:00Z".to_string(),
        };

        let error = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            candidate.generation,
            candidate.authority_token.as_deref(),
            candidate.raw_cached_auth_token.as_deref(),
            anonymous,
            || Ok(None),
        )
        .err()
        .expect("an authenticated cache must contain an authenticated user identity");
        assert!(format!("{error:#}").contains("auth identity does not match its user"));
        let after =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(None)).unwrap();
        assert_eq!(after.generation, candidate.generation);
        assert!(after.cache.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_state_login_recovery_cannot_reuse_an_active_generation() {
        let directory = desktop_auth_test_directory("recovery-generation-floor");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let initial_cache = desktop_auth_cache(
            Some("same-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T01:00:00Z",
        );
        let initial = load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || {
            Ok(Some(serde_json::to_value(&initial_cache).unwrap()))
        })
        .unwrap();
        let active = begin_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            initial.generation,
            initial.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap()
        .unwrap();

        fs::write(&path, b"{corrupt-auth-envelope").unwrap();
        let recovered = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            None,
            None,
            "same-session-token",
        )
        .unwrap()
        .unwrap();
        assert!(recovered.generation > active.generation);

        let late_commit = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            active.generation,
            active.authority_token.as_deref(),
            active.raw_cached_auth_token.as_deref(),
            desktop_auth_cache(
                Some("same-session-token"),
                env!("CARGO_PKG_VERSION"),
                "2026-07-30T02:00:00Z",
            ),
            || Ok(None),
        )
        .unwrap();
        assert!(late_commit.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_generation_fences_late_save_after_login_and_logout() {
        let directory = desktop_auth_test_directory("late-lease");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let old_cache = desktop_auth_cache(
            Some("old-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T01:00:00Z",
        );
        let initial = load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || {
            Ok(Some(serde_json::to_value(&old_cache).unwrap()))
        })
        .unwrap();
        let candidate = begin_desktop_auth_candidate_for_login_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            Some(initial.generation),
            initial.authority_token.as_deref(),
            "new-session-token",
        )
        .unwrap()
        .unwrap();
        assert!(candidate.generation > initial.generation);
        assert_eq!(
            candidate.authority_token.as_deref(),
            Some("new-session-token")
        );
        assert!(candidate.cache.is_none());
        assert!(candidate.raw_cached_auth_token.is_none());

        let late_old_reject = clear_desktop_auth_authority_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            initial.generation,
            initial.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap();
        assert!(late_old_reject.is_none());

        let late_old = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            initial.generation,
            initial.authority_token.as_deref(),
            initial.raw_cached_auth_token.as_deref(),
            old_cache,
            || Ok(None),
        )
        .unwrap();
        assert!(late_old.is_none());

        let new_cache = desktop_auth_cache(
            Some("new-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T02:00:00Z",
        );
        let committed = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            candidate.generation,
            candidate.authority_token.as_deref(),
            candidate.raw_cached_auth_token.as_deref(),
            new_cache.clone(),
            || Ok(None),
        )
        .unwrap()
        .unwrap();
        assert!(committed.generation > candidate.generation);
        assert!(committed.cache.is_some());

        let logged_out = clear_desktop_auth_authority_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            committed.generation,
            committed.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap()
        .unwrap();
        assert!(logged_out.generation > committed.generation);
        assert!(logged_out.authority_token.is_none());
        assert!(logged_out.cache.is_none());

        let duplicate_reject = clear_desktop_auth_authority_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            committed.generation,
            committed.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap();
        assert!(duplicate_reject.is_none());

        let late_new = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            candidate.generation,
            candidate.authority_token.as_deref(),
            candidate.raw_cached_auth_token.as_deref(),
            new_cache,
            || Ok(None),
        )
        .unwrap();
        assert!(late_new.is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_commit_accepts_clock_regression_but_rejects_malformed_time() {
        let directory = desktop_auth_test_directory("generated-at");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let current = desktop_auth_cache(
            Some("same-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T02:00:00Z",
        );
        let initial = load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || {
            Ok(Some(serde_json::to_value(&current).unwrap()))
        })
        .unwrap();
        let candidate = begin_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            initial.generation,
            initial.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap()
        .unwrap();

        let older = desktop_auth_cache(
            Some("same-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T01:00:00Z",
        );
        let regressed = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            candidate.generation,
            candidate.authority_token.as_deref(),
            candidate.raw_cached_auth_token.as_deref(),
            older,
            || Ok(None),
        )
        .unwrap()
        .unwrap();
        assert!(regressed.generation > candidate.generation);
        assert_eq!(
            regressed
                .cache
                .as_ref()
                .unwrap()
                .bootstrap
                .get("generatedAt")
                .and_then(serde_json::Value::as_str),
            Some("2026-07-30T01:00:00Z")
        );

        let malformed_candidate = begin_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            regressed.generation,
            regressed.authority_token.as_deref(),
            || Ok(None),
        )
        .unwrap()
        .unwrap();

        let mut malformed = desktop_auth_cache(
            Some("same-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T03:00:00Z",
        );
        malformed
            .bootstrap
            .as_object_mut()
            .unwrap()
            .remove("generatedAt");
        assert!(commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            malformed_candidate.generation,
            malformed_candidate.authority_token.as_deref(),
            malformed_candidate.raw_cached_auth_token.as_deref(),
            malformed,
            || Ok(None),
        )
        .is_err());

        let after =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(None)).unwrap();
        assert_eq!(after.generation, malformed_candidate.generation);
        assert!(after.cache == malformed_candidate.cache);

        let newer = desktop_auth_cache(
            Some("same-session-token"),
            env!("CARGO_PKG_VERSION"),
            "2026-07-30T03:00:00Z",
        );
        let committed = commit_desktop_auth_candidate_at(
            &path,
            env!("CARGO_PKG_VERSION"),
            malformed_candidate.generation,
            malformed_candidate.authority_token.as_deref(),
            malformed_candidate.raw_cached_auth_token.as_deref(),
            newer,
            || Ok(None),
        )
        .unwrap()
        .unwrap();
        assert!(committed.generation > malformed_candidate.generation);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_desktop_auth_begin_has_one_generation_owner() {
        let directory = desktop_auth_test_directory("concurrent-begin");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let initial =
            load_desktop_auth_snapshot_at(&path, env!("CARGO_PKG_VERSION"), || Ok(None)).unwrap();
        let initial_generation = initial.generation;
        let initial_authority_token = initial.authority_token;
        let barrier = Arc::new(Barrier::new(2));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            let expected_authority_token = initial_authority_token.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                begin_desktop_auth_candidate_at(
                    &path,
                    env!("CARGO_PKG_VERSION"),
                    initial_generation,
                    expected_authority_token.as_deref(),
                    || Ok(None),
                )
                .unwrap()
                .is_some()
            }));
        }
        let acquired = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|acquired| *acquired)
            .count();
        assert_eq!(acquired, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn desktop_auth_runtime_fence_requires_the_exact_generation_and_authority() {
        let fence = DesktopAuthRuntimeFence::default();
        let confirmed = DesktopAuthSnapshot {
            generation: 12,
            authority_token: Some("session-token".to_string()),
            cache: None,
            raw_cached_auth_token: None,
        };

        assert!(!fence.matches(&confirmed));
        fence.confirm(&confirmed);
        assert!(fence.matches(&confirmed));
        assert!(!fence.invalidate_if_matches(11, Some("session-token")));
        assert!(fence.matches(&confirmed));
        assert!(!fence.matches(&DesktopAuthSnapshot {
            generation: 13,
            ..confirmed.clone()
        }));
        assert!(!fence.matches(&DesktopAuthSnapshot {
            authority_token: Some("other-token".to_string()),
            ..confirmed.clone()
        }));
        assert!(fence.invalidate_if_matches(confirmed.generation, Some("session-token")));
        assert!(!fence.matches(&confirmed));
    }

    #[test]
    fn desktop_auth_atomic_replace_failure_keeps_the_previous_envelope() {
        let directory = desktop_auth_test_directory("failed-auth-replace");
        let path = directory.join(DESKTOP_AUTH_STATE_FILE);
        let state = DesktopAuthState::default();
        persist_desktop_auth_state(&path, &state).unwrap();
        let previous = fs::read(&path).unwrap();
        let mut next = state;
        next.generation = next.generation.checked_add(1).unwrap();

        let error = persist_desktop_auth_state_with(&path, &next, |_temporary, _target| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected auth state replace failure",
            ))
        })
        .unwrap_err();

        assert!(format!("{error:#}").contains("atomically replace"));
        assert_eq!(fs::read(&path).unwrap(), previous);
        fs::remove_dir_all(directory).unwrap();
    }
}
