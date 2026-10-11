use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

fn test_directory(name: &str) -> PathBuf {
    let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!(
            "echolike-storage-config-{name}-{}-{sequence}",
            std::process::id()
        ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn v2_envelope_round_trips_and_rejects_other_versions() {
    let path = Path::new(APP_CONFIG_STORE_FILE);
    let mut expected = AppConfig::default();
    expected.theme = "dark".to_string();

    let bytes = serialize_app_config_envelope(&expected, path).unwrap();
    assert_eq!(parse_app_config(&bytes).unwrap(), expected);

    let serialized: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(serialized["schema"], APP_CONFIG_SCHEMA);
    assert_eq!(serialized["schema_version"], APP_CONFIG_SCHEMA_VERSION);
    assert!(serialized.get("first_run_contract_version").is_none());
    assert!(serialized.get("app_config").is_none());

    let wrong_version = serde_json::to_vec(&serde_json::json!({
        "schema": APP_CONFIG_SCHEMA,
        "schema_version": APP_CONFIG_SCHEMA_VERSION - 1,
        "config": serde_json::to_value(&expected).unwrap()
    }))
    .unwrap();
    let error = parse_app_config(&wrong_version).unwrap_err();
    assert!(error.to_string().contains("schema version"));

    let mut unknown_field: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    unknown_field["config"]["onboarding_mode_selected"] = serde_json::json!(true);
    let error = parse_app_config(&serde_json::to_vec(&unknown_field).unwrap()).unwrap_err();
    assert!(format!("{error:#}").contains("unknown field"));
}

#[test]
fn old_namespaces_are_ignored_and_v2_is_initialized_only_once() {
    let directory = test_directory("v2-reset-once");
    let old_config_path = directory.join("app-config.json");
    let old_state_path = directory.join("settings.json");
    let v2_path = directory.join(APP_CONFIG_STORE_FILE);
    let old_config = br#"{"schema":"echolike.app-config","schema_version":1}"#;
    let old_state = br#"{"app_config":{"theme":"dark"}}"#;
    fs::write(&old_config_path, old_config).unwrap();
    fs::write(&old_state_path, old_state).unwrap();

    let created = load_or_initialize_app_config(&v2_path).unwrap();
    assert_eq!(created.origin, AppConfigOrigin::CreatedNew);
    assert_eq!(created.config, AppConfig::new_install_default());
    assert_eq!(fs::read(&old_config_path).unwrap(), old_config);
    assert_eq!(fs::read(&old_state_path).unwrap(), old_state);

    let mut selected = created.config;
    selected.config_source = "local".to_string();
    selected.onboarding_version = CURRENT_ONBOARDING_VERSION;
    selected.theme = "dark".to_string();
    persist_app_config(&v2_path, &selected).unwrap();

    let restarted = load_or_initialize_app_config(&v2_path).unwrap();
    assert_eq!(restarted.origin, AppConfigOrigin::Persisted);
    assert_eq!(restarted.config, selected);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_v2_config_is_fail_closed_and_never_overwritten() {
    let directory = test_directory("invalid-v2");
    let path = directory.join(APP_CONFIG_STORE_FILE);
    let invalid = b"{broken-v2";
    fs::write(&path, invalid).unwrap();

    let error = load_or_initialize_app_config(&path).unwrap_err();

    assert!(format!("{error:#}").contains("parse app config v2 envelope"));
    assert_eq!(fs::read(&path).unwrap(), invalid);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn v2_read_distinguishes_missing_invalid_and_unreadable_files() {
    let path = Path::new("C:/example/app-config-v2.json");
    assert!(matches!(
        classify_app_config_read(
            path,
            Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
        ),
        AppConfigFileRead::Missing
    ));

    match classify_app_config_read(path, Ok(b"{not-json".to_vec())) {
        AppConfigFileRead::Invalid(error) => {
            assert!(error.to_string().contains("C:/example/app-config-v2.json"));
            assert!(format!("{error:#}").contains("parse app config v2 envelope"));
        }
        other => panic!("expected invalid read, got {other:?}"),
    }

    match classify_app_config_read(
        path,
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "read-only ACL",
        )),
    ) {
        AppConfigFileRead::Unreadable(error) => {
            assert!(error.to_string().contains("C:/example/app-config-v2.json"));
            assert!(error.to_string().contains("read-only ACL"));
        }
        other => panic!("expected unreadable read, got {other:?}"),
    }
}

#[test]
fn atomic_replace_commits_a_complete_parseable_envelope() {
    let directory = test_directory("successful-replace");
    let target = directory.join(APP_CONFIG_STORE_FILE);
    let mut first = AppConfig::default();
    first.theme = "light".to_string();
    persist_app_config(&target, &first).unwrap();
    let mut second = first;
    second.theme = "dark".to_string();
    persist_app_config(&target, &second).unwrap();

    match read_app_config(&target) {
        AppConfigFileRead::Valid(config) => assert_eq!(config.theme, "dark"),
        other => panic!("expected valid replaced config, got {other:?}"),
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn failed_config_persistence_does_not_advance_the_runtime_cache() {
    let previous = AppConfig::default();
    let cache = Mutex::new(Some(AppConfigSnapshot {
        config: previous.clone(),
        origin: AppConfigOrigin::Persisted,
    }));
    let mut next = previous.clone();
    next.config_source = "local".to_string();

    let result = persist_config_transaction(
        &cache,
        move |current| *current = next,
        |_| Err(anyhow::anyhow!("settings file is read-only")),
    );

    assert!(result.is_err());
    assert_eq!(
        cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|snapshot| snapshot.config.config_source.as_str()),
        Some("backend")
    );
}

#[test]
fn concurrent_persistence_transactions_keep_disk_and_cache_in_sync() {
    let cache = Arc::new(Mutex::new(Some(AppConfigSnapshot {
        config: AppConfig::default(),
        origin: AppConfigOrigin::Persisted,
    })));
    let disk_theme = Arc::new(Mutex::new("system".to_string()));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum_active = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();

    for index in 0..6 {
        let cache = Arc::clone(&cache);
        let disk_theme = Arc::clone(&disk_theme);
        let active = Arc::clone(&active);
        let maximum_active = Arc::clone(&maximum_active);
        workers.push(std::thread::spawn(move || {
            let mut config = AppConfig::default();
            config.theme = format!("theme-{index}");
            persist_config_transaction(
                &cache,
                move |current| *current = config,
                |saved| {
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum_active.fetch_max(current, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                    *disk_theme.lock().unwrap_or_else(|error| error.into_inner()) =
                        saved.theme.clone();
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        }));
    }

    for worker in workers {
        worker.join().unwrap();
    }

    assert_eq!(maximum_active.load(Ordering::SeqCst), 1);
    assert_eq!(
        *disk_theme.lock().unwrap_or_else(|error| error.into_inner()),
        cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .unwrap()
            .config
            .theme
    );
}

#[test]
fn snapshot_diff_merges_only_fields_the_renderer_actually_changed() {
    let mut current = AppConfig::default();
    current.onboarding_version = CURRENT_ONBOARDING_VERSION;
    current.config_source = "local".to_string();
    current.theme = "light".to_string();

    let mut stale_base = current.clone();
    stale_base.config_source = "backend".to_string();
    stale_base.theme = "system".to_string();
    let mut requested = stale_base.clone();
    requested.llm_model = "qwen3.5".to_string();
    requested.onboarding_version = 0;
    requested.hotkey = "Ctrl+Shift+X".to_string();

    let cache = Mutex::new(Some(AppConfigSnapshot {
        config: current.clone(),
        origin: AppConfigOrigin::Persisted,
    }));
    let disk = Mutex::new(current);
    persist_config_transaction(
        &cache,
        |current| merge_user_config_changes(current, &stale_base, &requested),
        |saved| {
            *disk.lock().unwrap_or_else(|error| error.into_inner()) = saved.clone();
            Ok(())
        },
    )
    .unwrap();

    let current = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .unwrap()
        .config
        .clone();
    assert_eq!(current.config_source, "local");
    assert_eq!(current.theme, "light");
    assert_eq!(current.llm_model, "qwen3.5");
    assert_eq!(current.onboarding_version, CURRENT_ONBOARDING_VERSION);
    assert_eq!(current.hotkey, AppConfig::default().hotkey);
    assert_eq!(
        disk.lock()
            .unwrap_or_else(|error| error.into_inner())
            .config_source,
        "local"
    );
    assert_eq!(
        disk.lock()
            .unwrap_or_else(|error| error.into_inner())
            .onboarding_version,
        CURRENT_ONBOARDING_VERSION
    );
}

#[test]
fn app_config_v2_new_install_defaults_are_explicit() {
    let config = AppConfig::new_install_default();
    assert_eq!(config.config_source, "backend");
    assert_eq!(config.onboarding_version, 0);
    assert!(config.capsule_auto_hide);
    assert!(config.polish_enabled);
    assert_eq!(config.target_lang, "en");
    assert_eq!(config.theme_profile, "echo");
    assert_eq!(config.capsule_style, "classic");
    assert_eq!(config.ui_language, "zh");
    assert!(!config.mute_system_audio_during_recording);
    assert_eq!(config.ocr_base_url, "http://127.0.0.1:11434");
    assert_eq!(config.ocr_model, "glm-ocr:latest");
    assert!(!config.network_proxy_enabled);
    assert_eq!(config.network_proxy_url, "");
    assert_eq!(config.network_proxy_bypass, DEFAULT_NETWORK_PROXY_BYPASS);
    #[cfg(not(target_os = "macos"))]
    assert_eq!(config.screen_ocr_hotkey, "Ctrl+Shift+O");
}

#[test]
fn app_config_v2_rejects_incomplete_objects_instead_of_defaulting_them() {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "schema": APP_CONFIG_SCHEMA,
        "schema_version": APP_CONFIG_SCHEMA_VERSION,
        "config": {
            "config_source": "local",
            "onboarding_version": 1
        }
    }))
    .unwrap();

    assert!(format!("{:#}", parse_app_config(&bytes).unwrap_err()).contains("missing field"));
}
