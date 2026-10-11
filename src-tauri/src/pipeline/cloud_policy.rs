use crate::storage;
use tauri::Manager;

pub(super) fn uses_backend_config_source(config: &storage::AppConfig) -> bool {
    config.config_source == "backend"
}

pub(super) fn load_cloud_proxy_policy(
    app_handle: &tauri::AppHandle,
    config: &storage::AppConfig,
) -> CloudProxyPolicyResolution {
    if !uses_backend_config_source(config) {
        return CloudProxyPolicyResolution::Local;
    }
    let snapshot = match storage::load_desktop_auth_snapshot(app_handle) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!("Desktop auth snapshot unavailable during recording preflight: {error}");
            return CloudProxyPolicyResolution::AuthorizationExpired;
        }
    };
    let runtime_confirmed = app_handle
        .state::<storage::DesktopAuthRuntimeFence>()
        .matches(&snapshot);
    cloud_proxy_policy_from_snapshot(snapshot, config, runtime_confirmed)
}

fn cloud_proxy_policy_from_snapshot(
    snapshot: storage::DesktopAuthSnapshot,
    config: &storage::AppConfig,
    runtime_confirmed: bool,
) -> CloudProxyPolicyResolution {
    if !uses_backend_config_source(config) {
        return CloudProxyPolicyResolution::Local;
    }
    let Some(authority_token) = snapshot
        .authority_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    else {
        return CloudProxyPolicyResolution::AuthorizationRequired;
    };
    if !runtime_confirmed {
        return CloudProxyPolicyResolution::AuthorizationExpired;
    }
    let auth_generation = snapshot.generation;
    let Some(cache) = snapshot.cache else {
        return CloudProxyPolicyResolution::PolicyStale;
    };
    let ttl_seconds = cache
        .bootstrap
        .pointer("/policy/configTtlSeconds")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(3600)
        .max(60);
    let Ok(cached_at) = chrono::DateTime::parse_from_rfc3339(&cache.cached_at) else {
        return CloudProxyPolicyResolution::PolicyStale;
    };
    if chrono::Utc::now().signed_duration_since(cached_at.with_timezone(&chrono::Utc))
        > chrono::Duration::seconds(ttl_seconds)
    {
        return CloudProxyPolicyResolution::PolicyStale;
    }
    let Some(auth_token) = cache
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
    else {
        return CloudProxyPolicyResolution::AuthorizationExpired;
    };
    if authority_token != auth_token {
        return CloudProxyPolicyResolution::AuthorizationExpired;
    }
    let Some(api_base_url) = cache
        .bootstrap
        .get("apiBaseUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
    else {
        return CloudProxyPolicyResolution::PolicyStale;
    };
    let api_base_url = api_base_url.trim_end_matches('/').to_string();
    if api_base_url.is_empty() {
        return CloudProxyPolicyResolution::PolicyStale;
    }

    CloudProxyPolicyResolution::Ready(CloudProxyPolicy {
        auth_generation,
        api_base_url,
        auth_token: auth_token.to_string(),
        stt_proxy: service_proxy_enabled(&cache.bootstrap, "stt"),
        llm_proxy: service_proxy_enabled(&cache.bootstrap, "llm"),
    })
}

fn service_proxy_enabled(bootstrap: &serde_json::Value, service: &str) -> bool {
    let Some(service_value) = bootstrap
        .get("services")
        .and_then(|services| services.get(service))
    else {
        return false;
    };
    service_value
        .get("mode")
        .and_then(serde_json::Value::as_str)
        == Some("proxy")
        && service_value
            .get("configured")
            .and_then(serde_json::Value::as_bool)
            != Some(false)
}

pub(super) fn proxy_endpoint(policy: &CloudProxyPolicy, path: &str) -> String {
    format!(
        "{}/{}",
        policy.api_base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

#[derive(Debug, Clone)]
pub(super) struct CloudProxyPolicy {
    pub(super) auth_generation: u64,
    pub(super) api_base_url: String,
    pub(super) auth_token: String,
    pub(super) stt_proxy: bool,
    pub(super) llm_proxy: bool,
}

#[derive(Debug, Clone)]
pub(super) enum CloudProxyPolicyResolution {
    Local,
    AuthorizationRequired,
    AuthorizationExpired,
    PolicyStale,
    Ready(CloudProxyPolicy),
}

pub(super) fn backend_stt_policy(
    resolution: CloudProxyPolicyResolution,
) -> std::result::Result<Option<CloudProxyPolicy>, &'static str> {
    match resolution {
        CloudProxyPolicyResolution::Local => Ok(None),
        CloudProxyPolicyResolution::Ready(policy) if policy.stt_proxy => Ok(Some(policy)),
        CloudProxyPolicyResolution::AuthorizationRequired => Err("backend_auth_required"),
        CloudProxyPolicyResolution::AuthorizationExpired => Err("backend_auth_expired"),
        CloudProxyPolicyResolution::PolicyStale => Err("backend_policy_stale"),
        CloudProxyPolicyResolution::Ready(_) => Err("backend_stt_unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_config_source_is_explicit_only() {
        let mut config = storage::AppConfig {
            config_source: "backend".to_string(),
            ..storage::AppConfig::default()
        };
        assert!(uses_backend_config_source(&config));

        config.config_source = "local".to_string();
        assert!(!uses_backend_config_source(&config));
    }

    #[test]
    fn service_proxy_enabled_requires_proxy_and_not_configured_false() {
        let bootstrap = serde_json::json!({
            "services": {
                "stt": { "mode": "proxy", "configured": true },
                "llm": { "mode": "proxy", "configured": false },
                "ocr": { "mode": "direct", "configured": true }
            }
        });

        assert!(service_proxy_enabled(&bootstrap, "stt"));
        assert!(!service_proxy_enabled(&bootstrap, "llm"));
        assert!(!service_proxy_enabled(&bootstrap, "ocr"));
        assert!(!service_proxy_enabled(&bootstrap, "tts"));
    }

    #[test]
    fn cloud_proxy_policy_rejects_cache_outside_the_native_auth_authority() {
        let snapshot = storage::DesktopAuthSnapshot {
            generation: 7,
            authority_token: Some("current-session-token".to_string()),
            raw_cached_auth_token: Some("stale-session-token".to_string()),
            cache: Some(storage::DesktopBootstrapCache {
                package_version: env!("CARGO_PKG_VERSION").to_string(),
                bootstrap: serde_json::json!({
                    "apiBaseUrl": "https://example.test/echo-api",
                    "generatedAt": "2026-07-30T02:00:00Z",
                    "policy": { "configTtlSeconds": 3600 },
                    "services": {
                        "stt": { "mode": "proxy", "configured": true },
                        "llm": { "mode": "proxy", "configured": true }
                    }
                }),
                auth_token: Some("stale-session-token".to_string()),
                cached_at: chrono::Utc::now().to_rfc3339(),
            }),
        };

        assert!(matches!(
            cloud_proxy_policy_from_snapshot(
                snapshot,
                &storage::AppConfig {
                    config_source: "backend".to_string(),
                    ..storage::AppConfig::default()
                },
                true,
            ),
            CloudProxyPolicyResolution::AuthorizationExpired
        ));
    }

    #[test]
    fn cloud_proxy_policy_requires_renderer_confirmed_native_identity() {
        let snapshot = storage::DesktopAuthSnapshot {
            generation: 7,
            authority_token: Some("current-session-token".to_string()),
            raw_cached_auth_token: Some("current-session-token".to_string()),
            cache: Some(storage::DesktopBootstrapCache {
                package_version: env!("CARGO_PKG_VERSION").to_string(),
                bootstrap: serde_json::json!({
                    "apiBaseUrl": "https://example.test/echo-api",
                    "generatedAt": "2026-07-30T02:00:00Z",
                    "policy": { "configTtlSeconds": 3600 },
                    "services": {
                        "stt": { "mode": "proxy", "configured": true },
                        "llm": { "mode": "proxy", "configured": true }
                    }
                }),
                auth_token: Some("current-session-token".to_string()),
                cached_at: chrono::Utc::now().to_rfc3339(),
            }),
        };
        let config = storage::AppConfig {
            config_source: "backend".to_string(),
            ..storage::AppConfig::default()
        };

        assert!(matches!(
            cloud_proxy_policy_from_snapshot(snapshot.clone(), &config, false),
            CloudProxyPolicyResolution::AuthorizationExpired
        ));
        let ready = cloud_proxy_policy_from_snapshot(snapshot, &config, true);
        assert!(backend_stt_policy(ready).unwrap().is_some());
    }

    #[test]
    fn backend_stt_preflight_distinguishes_login_from_service_availability() {
        let config = storage::AppConfig {
            config_source: "backend".to_string(),
            ..storage::AppConfig::default()
        };
        let signed_out = storage::DesktopAuthSnapshot {
            generation: 1,
            authority_token: None,
            raw_cached_auth_token: None,
            cache: None,
        };

        let required = cloud_proxy_policy_from_snapshot(signed_out, &config, true);
        assert_eq!(
            backend_stt_policy(required).unwrap_err(),
            "backend_auth_required"
        );

        let stale_policy = storage::DesktopAuthSnapshot {
            generation: 2,
            authority_token: Some("session-token".to_string()),
            raw_cached_auth_token: Some("session-token".to_string()),
            cache: Some(storage::DesktopBootstrapCache {
                package_version: env!("CARGO_PKG_VERSION").to_string(),
                bootstrap: serde_json::json!({
                    "apiBaseUrl": "https://example.test/echo-api",
                    "policy": { "configTtlSeconds": 3600 },
                    "services": { "stt": { "mode": "proxy", "configured": true } }
                }),
                auth_token: Some("session-token".to_string()),
                cached_at: "2020-01-01T00:00:00Z".to_string(),
            }),
        };
        let stale = cloud_proxy_policy_from_snapshot(stale_policy, &config, true);
        assert_eq!(
            backend_stt_policy(stale).unwrap_err(),
            "backend_policy_stale"
        );

        let unavailable = CloudProxyPolicyResolution::Ready(CloudProxyPolicy {
            auth_generation: 2,
            api_base_url: "https://example.test/echo-api".to_string(),
            auth_token: "session-token".to_string(),
            stt_proxy: false,
            llm_proxy: true,
        });
        assert_eq!(
            backend_stt_policy(unavailable).unwrap_err(),
            "backend_stt_unavailable"
        );

        assert!(backend_stt_policy(CloudProxyPolicyResolution::Local)
            .unwrap()
            .is_none());
    }

    #[test]
    fn proxy_endpoint_normalizes_all_base_and_path_slash_combinations() {
        for (base, path) in [
            ("https://example.test/echo-api", "proxy/stt"),
            ("https://example.test/echo-api", "/proxy/stt"),
            ("https://example.test/echo-api/", "proxy/stt"),
            ("https://example.test/echo-api/", "/proxy/stt"),
        ] {
            let policy = CloudProxyPolicy {
                auth_generation: 1,
                api_base_url: base.to_string(),
                auth_token: "token".to_string(),
                stt_proxy: true,
                llm_proxy: true,
            };
            assert_eq!(
                proxy_endpoint(&policy, path),
                "https://example.test/echo-api/proxy/stt"
            );
        }
    }
}
