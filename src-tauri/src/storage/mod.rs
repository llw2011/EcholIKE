mod atomic_file;
mod config;
mod desktop_auth;
mod dictionary;
mod history;

pub use config::{
    AppConfig, AppConfigOrigin, AppConfigSnapshot, ConfigManager, ConfigMutationLock,
    CURRENT_ONBOARDING_VERSION, DEFAULT_NETWORK_PROXY_BYPASS,
};
pub use desktop_auth::{
    begin_desktop_auth_candidate, begin_desktop_auth_candidate_for_login,
    clear_desktop_auth_authority, cloud_policy_force_update, commit_desktop_auth_candidate,
    load_desktop_auth_snapshot, DesktopAuthRuntimeFence, DesktopAuthSnapshot,
    DesktopBootstrapCache,
};
pub use dictionary::{DictionaryEntry, DictionaryStore};
pub use history::{ClearHistoryResult, HistoryEntry, HistoryStore};

pub const RUNTIME_STATE_STORE_FILE: &str = "runtime-state-v2.json";
