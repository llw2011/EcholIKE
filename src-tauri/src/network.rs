use std::sync::{Arc, RwLock};
use std::time::Duration;
use url::Url;

use crate::storage;

#[derive(Clone)]
pub struct NetworkClient {
    state: Arc<RwLock<NetworkClientState>>,
}

struct NetworkClientState {
    client: reqwest::Client,
    proxy_error: Option<String>,
}

impl NetworkClient {
    pub fn new(config: &storage::AppConfig) -> Self {
        Self {
            state: Arc::new(RwLock::new(build_client_state(config))),
        }
    }

    pub fn refresh(&self, config: &storage::AppConfig) {
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = build_client_state(config);
    }

    pub fn client(&self) -> Result<reqwest::Client, String> {
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = &state.proxy_error {
            return Err(error.clone());
        }
        Ok(state.client.clone())
    }
}

fn base_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .pool_max_idle_per_host(2)
        .pool_idle_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(30))
}

fn build_client_state(config: &storage::AppConfig) -> NetworkClientState {
    match build_http_client(config) {
        Ok(client) => NetworkClientState {
            client,
            proxy_error: None,
        },
        Err(error) => {
            tracing::warn!("Network proxy is not active: {error}");
            NetworkClientState {
                client: base_client_builder()
                    .build()
                    .expect("fallback HTTP client should build"),
                proxy_error: Some(error),
            }
        }
    }
}

pub fn build_http_client(config: &storage::AppConfig) -> Result<reqwest::Client, String> {
    let mut builder = base_client_builder();
    if let Some(proxy_url) = normalized_proxy_url(config)? {
        let no_proxy = reqwest::NoProxy::from_string(&effective_proxy_bypass(config));
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|_| "网络代理地址不正确，请检查协议、主机和端口。".to_string())?
            .no_proxy(no_proxy);
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|_| "网络代理初始化失败，请检查代理配置。".to_string())
}

pub fn normalized_proxy_url(config: &storage::AppConfig) -> Result<Option<String>, String> {
    if !config.network_proxy_enabled {
        return Ok(None);
    }

    let proxy_url = config.network_proxy_url.trim();
    if proxy_url.is_empty() {
        return Err("请先填写网络代理地址。".to_string());
    }

    let parsed = Url::parse(proxy_url)
        .map_err(|_| "网络代理地址不正确，示例：http://127.0.0.1:7890。".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h") {
        return Err("网络代理仅支持 http、https、socks5 或 socks5h。".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("网络代理地址缺少主机名或 IP。".to_string());
    }

    Ok(Some(proxy_url.to_string()))
}

pub fn effective_proxy_bypass(config: &storage::AppConfig) -> String {
    let user_bypass = config.network_proxy_bypass.trim();
    if user_bypass.is_empty() {
        storage::DEFAULT_NETWORK_PROXY_BYPASS.to_string()
    } else {
        format!("{},{}", storage::DEFAULT_NETWORK_PROXY_BYPASS, user_bypass)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_config(url: &str) -> storage::AppConfig {
        storage::AppConfig {
            network_proxy_enabled: true,
            network_proxy_url: url.to_string(),
            ..storage::AppConfig::default()
        }
    }

    #[test]
    fn accepts_http_and_socks_proxy_urls() {
        assert_eq!(
            normalized_proxy_url(&proxy_config("http://127.0.0.1:7890")).unwrap(),
            Some("http://127.0.0.1:7890".to_string())
        );
        assert_eq!(
            normalized_proxy_url(&proxy_config("socks5://127.0.0.1:1080")).unwrap(),
            Some("socks5://127.0.0.1:1080".to_string())
        );
        assert_eq!(
            normalized_proxy_url(&proxy_config("socks5h://proxy.example.com:1080")).unwrap(),
            Some("socks5h://proxy.example.com:1080".to_string())
        );
    }

    #[test]
    fn rejects_unsupported_proxy_schemes() {
        let error = normalized_proxy_url(&proxy_config("ftp://proxy.example.com:21")).unwrap_err();

        assert!(error.contains("http"));
        assert!(error.contains("socks5"));
    }

    #[test]
    fn keeps_local_networks_bypassed_by_default() {
        let config = proxy_config("http://127.0.0.1:7890");

        let bypass = effective_proxy_bypass(&config);

        assert!(bypass.contains("localhost"));
        assert!(bypass.contains("127.0.0.1"));
        assert!(bypass.contains("10.0.0.0/8"));
    }

    #[test]
    fn network_client_blocks_requests_when_enabled_proxy_is_invalid() {
        let client = NetworkClient::new(&proxy_config("not a url"));

        let error = client.client().unwrap_err();

        assert!(error.contains("代理地址"));
    }
}
