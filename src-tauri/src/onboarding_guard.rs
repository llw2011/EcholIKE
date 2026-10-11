use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug)]
struct GuardState {
    boot_blocked: bool,
    next_lease: u64,
    lease: Option<u64>,
    last_released: Option<u64>,
}

/// Process-local ownership for tutorial shortcut interception.
///
/// The boot block covers the gap before the renderer has classified the startup config. Each
/// visible tutorial then owns a unique lease, so a late StrictMode cleanup can only release the
/// session it created and can never unlock a newer tutorial.
pub struct OnboardingGuard {
    state: Mutex<GuardState>,
}

impl OnboardingGuard {
    pub(crate) fn new(boot_blocked: bool) -> Self {
        Self {
            state: Mutex::new(GuardState {
                boot_blocked,
                next_lease: 0,
                lease: None,
                last_released: None,
            }),
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.boot_blocked || state.lease.is_some()
    }

    pub(crate) fn resolve_startup(&self, show_tour: bool, config_available: bool) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // A renderer startup is a new ownership epoch. Drop leases whose IPC response or UI was
        // lost with the previous WebView, then optionally replace the boot block with one visible
        // startup-tour lease.
        state.lease = None;
        state.last_released = None;
        state.boot_blocked = !config_available;
        (config_available && show_tour).then(|| Self::new_lease(&mut state))
    }

    pub(crate) fn acquire(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // Only one onboarding overlay can own the process at a time. Returning the current lease
        // makes acquisition idempotent when native execution succeeded but its IPC response was
        // lost, instead of accumulating an invisible second blocker on retry.
        state.lease.unwrap_or_else(|| Self::new_lease(&mut state))
    }

    pub(crate) fn release(&self, lease: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.lease != Some(lease) {
            return state.lease.is_none() && state.last_released == Some(lease);
        }
        state.lease = None;
        state.last_released = Some(lease);
        true
    }

    pub(crate) fn run_if_inactive<T>(&self, action: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.boot_blocked || state.lease.is_some() {
            None
        } else {
            Some(action())
        }
    }

    fn new_lease(state: &mut GuardState) -> u64 {
        loop {
            state.next_lease = state.next_lease.wrapping_add(1);
            if state.next_lease != 0 {
                state.lease = Some(state.next_lease);
                state.last_released = None;
                return state.next_lease;
            }
        }
    }
}

fn abort_pipeline_while_onboarding(app: &tauri::AppHandle, active: bool) {
    if active {
        app.state::<crate::pipeline::PipelineHandle>().abort();
    }
}

fn require_main_onboarding_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(format!(
            "onboarding guard commands are restricted to the main window, got {:?}",
            window.label()
        ))
    }
}

fn validated_onboarding_startup(
    show_tour: bool,
    renderer_config_available: bool,
    onboarding_version: Option<u32>,
) -> Result<(bool, bool), String> {
    if !renderer_config_available {
        return Ok((false, false));
    }
    let expected_tour = onboarding_version
        .ok_or_else(|| "native config cache is missing after setup".to_string())?
        == 0;
    if show_tour != expected_tour {
        return Err(format!(
            "renderer onboarding decision did not match the native config checkpoint (expected {expected_tour}, got {show_tour})"
        ));
    }
    Ok((expected_tour, true))
}

#[tauri::command]
pub(crate) async fn resolve_onboarding_startup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    show_tour: bool,
    config_available: bool,
) -> Result<Option<u64>, String> {
    require_main_onboarding_window(&window)?;
    let state = app.state::<OnboardingGuard>();
    let onboarding_version = app
        .state::<crate::storage::ConfigManager>()
        .current()
        .map(|config| config.onboarding_version);
    let (expected_tour, config_available) =
        validated_onboarding_startup(show_tour, config_available, onboarding_version)?;
    let lease = state.resolve_startup(expected_tour, config_available);
    abort_pipeline_while_onboarding(&app, state.is_active());
    Ok(lease)
}

#[tauri::command]
pub(crate) async fn acquire_onboarding_guard(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<u64, String> {
    require_main_onboarding_window(&window)?;
    let state = app.state::<OnboardingGuard>();
    let lease = state.acquire();
    abort_pipeline_while_onboarding(&app, true);
    Ok(lease)
}

#[tauri::command]
pub(crate) async fn release_onboarding_guard(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    lease: u64,
) -> Result<bool, String> {
    require_main_onboarding_window(&window)?;
    Ok(app.state::<OnboardingGuard>().release(lease))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_checkpoint_is_the_authority_for_startup_onboarding() {
        assert_eq!(
            validated_onboarding_startup(false, false, None).unwrap(),
            (false, false)
        );
        assert_eq!(
            validated_onboarding_startup(true, true, Some(0)).unwrap(),
            (true, true)
        );
        assert_eq!(
            validated_onboarding_startup(false, true, Some(1)).unwrap(),
            (false, true)
        );
        assert_eq!(
            validated_onboarding_startup(false, false, Some(1)).unwrap(),
            (false, false)
        );
        assert!(validated_onboarding_startup(false, true, Some(0)).is_err());
        assert!(validated_onboarding_startup(true, true, Some(1)).is_err());
    }

    #[test]
    fn boot_block_remains_active_until_startup_is_resolved() {
        let guard = OnboardingGuard::new(true);
        assert!(guard.is_active());
        assert!(guard.run_if_inactive(|| "dispatched").is_none());

        assert_eq!(guard.resolve_startup(false, true), None);
        assert!(!guard.is_active());
    }

    #[test]
    fn startup_tour_replaces_the_boot_block_without_an_unprotected_gap() {
        let guard = OnboardingGuard::new(true);

        assert!(guard.resolve_startup(true, true).is_some());
        assert!(guard.is_active());
    }

    #[test]
    fn renderer_startup_clears_leases_orphaned_by_a_previous_webview() {
        let guard = OnboardingGuard::new(false);
        let orphaned = guard.acquire();
        assert!(guard.is_active());

        assert_eq!(guard.resolve_startup(false, true), None);
        assert!(!guard.is_active());
        assert!(!guard.release(orphaned));
    }

    #[test]
    fn unavailable_config_keeps_the_boot_block_fail_closed() {
        let guard = OnboardingGuard::new(true);

        assert_eq!(guard.resolve_startup(false, false), None);
        assert!(guard.is_active());
    }

    #[test]
    fn stale_release_cannot_unlock_a_newer_tutorial_session() {
        let guard = OnboardingGuard::new(false);
        let first = guard.acquire();
        assert!(guard.release(first));
        let second = guard.acquire();
        assert_ne!(first, second);
        assert!(guard.is_active());
        assert!(!guard.release(first));
        assert!(guard.release(second));
        assert!(!guard.is_active());
    }

    #[test]
    fn repeated_acquire_returns_the_same_visible_session_lease() {
        let guard = OnboardingGuard::new(false);

        let first = guard.acquire();
        let retry = guard.acquire();

        assert_eq!(retry, first);
        assert!(guard.release(first));
        assert!(!guard.is_active());
    }

    #[test]
    fn repeated_release_is_idempotent_until_a_new_session_exists() {
        let guard = OnboardingGuard::new(false);
        let lease = guard.acquire();

        assert!(guard.release(lease));
        assert!(guard.release(lease));

        let next = guard.acquire();
        assert_ne!(next, lease);
        assert!(!guard.release(lease));
        assert!(guard.release(next));
    }

    #[test]
    fn guarded_dispatch_and_activation_are_serialized() {
        let guard = OnboardingGuard::new(false);
        assert_eq!(guard.run_if_inactive(|| 42), Some(42));
        let lease = guard.acquire();
        assert!(guard.run_if_inactive(|| 7).is_none());
        assert!(guard.release(lease));
        assert_eq!(guard.run_if_inactive(|| 9), Some(9));
    }
}
