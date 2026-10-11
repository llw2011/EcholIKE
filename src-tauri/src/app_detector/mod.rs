use serde::{Deserialize, Serialize};

use crate::llm::AppType;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppContext {
    pub app_name: String,
    pub window_title: String,
    pub app_type: AppType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowBounds {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone)]
pub struct WindowSnapshot {
    pub context: AppContext,
    pub bounds: Option<WindowBounds>,
}

impl Default for AppContext {
    fn default() -> Self {
        Self {
            app_name: String::new(),
            window_title: String::new(),
            app_type: AppType::General,
        }
    }
}

pub fn detect_current_app() -> AppContext {
    detect_current_window_snapshot().context
}

pub fn detect_current_window_snapshot() -> WindowSnapshot {
    #[cfg(target_os = "windows")]
    {
        windows_detect_snapshot()
    }
    #[cfg(target_os = "macos")]
    {
        WindowSnapshot {
            context: macos_detect(),
            bounds: None,
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        WindowSnapshot {
            context: AppContext::default(),
            bounds: None,
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_detect() -> AppContext {
    use std::process::Command;

    let app_name = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to get name of first application process whose frontmost is true"#,
        ])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let window_title = Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events"
            set frontApp to first application process whose frontmost is true
            try
                get name of front window of frontApp
            on error
                return ""
            end try
        end tell"#,
        ])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let app_type = classify_app(&app_name);
    AppContext {
        app_name,
        window_title,
        app_type,
    }
}

#[cfg(target_os = "windows")]
fn windows_detect_snapshot() -> WindowSnapshot {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    unsafe {
        let foreground = GetForegroundWindow();
        let current_pid = std::process::id();
        let Some(hwnd) = best_external_window(foreground, current_pid) else {
            return WindowSnapshot {
                context: AppContext::default(),
                bounds: None,
            };
        };

        WindowSnapshot {
            context: window_context(hwnd),
            bounds: window_bounds(hwnd),
        }
    }
}

#[cfg(target_os = "windows")]
unsafe fn window_context(hwnd: windows_sys::Win32::Foundation::HWND) -> AppContext {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};

    let mut title_buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
    let window_title = if len > 0 {
        OsString::from_wide(&title_buf[..len as usize])
            .to_string_lossy()
            .to_string()
    } else {
        String::new()
    };

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);

    let app_name = get_process_name(pid).unwrap_or_default();
    let app_type = classify_app(&app_name);

    AppContext {
        app_name,
        window_title,
        app_type,
    }
}

#[cfg(target_os = "windows")]
unsafe fn window_bounds(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<WindowBounds> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if GetWindowRect(hwnd, &mut rect) == 0 {
        return None;
    }

    bounds_from_rect(rect.left, rect.top, rect.right, rect.bottom)
}

#[cfg(target_os = "windows")]
fn bounds_from_rect(left: i32, top: i32, right: i32, bottom: i32) -> Option<WindowBounds> {
    let width = right.saturating_sub(left);
    let height = bottom.saturating_sub(top);
    (width > 32 && height > 32).then_some(WindowBounds {
        left,
        top,
        width,
        height,
    })
}

#[cfg(target_os = "windows")]
unsafe fn best_external_window(
    foreground: windows_sys::Win32::Foundation::HWND,
    current_pid: u32,
) -> Option<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindow, GW_HWNDNEXT};

    if foreground.is_null() {
        return None;
    }
    if is_usable_external_window(foreground, current_pid) {
        return Some(foreground);
    }

    let mut hwnd = foreground;
    for _ in 0..120 {
        hwnd = GetWindow(hwnd, GW_HWNDNEXT);
        if hwnd.is_null() {
            break;
        }
        if is_usable_external_window(hwnd, current_pid) {
            return Some(hwnd);
        }
    }
    None
}

#[cfg(target_os = "windows")]
unsafe fn is_usable_external_window(
    hwnd: windows_sys::Win32::Foundation::HWND,
    current_pid: u32,
) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };

    if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || GetWindowTextLengthW(hwnd) <= 0 {
        return false;
    }

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    pid != 0 && pid != current_pid
}

#[cfg(target_os = "windows")]
unsafe fn get_process_name(pid: u32) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    if pid == 0 {
        return None;
    }

    let handle = windows_sys::Win32::System::Threading::OpenProcess(
        windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
        0,
        pid,
    );
    if handle.is_null() {
        return None;
    }

    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let ok = windows_sys::Win32::System::Threading::QueryFullProcessImageNameW(
        handle,
        0,
        buf.as_mut_ptr(),
        &mut size,
    );
    let _ = windows_sys::Win32::Foundation::CloseHandle(handle);

    if ok != 0 && size > 0 {
        let path = OsString::from_wide(&buf[..size as usize])
            .to_string_lossy()
            .to_string();
        path.rsplit('\\').next().map(|s| s.to_string())
    } else {
        None
    }
}

#[allow(dead_code)]
fn classify_app(app_name: &str) -> AppType {
    let name = app_name.to_lowercase();
    if ["outlook", "gmail", "thunderbird", "mail"]
        .iter()
        .any(|k| name.contains(k))
    {
        AppType::Email
    } else if ["slack", "discord", "wechat", "telegram", "teams"]
        .iter()
        .any(|k| name.contains(k))
    {
        AppType::Chat
    } else if ["code", "intellij", "vim", "nvim", "cursor"]
        .iter()
        .any(|k| name.contains(k))
    {
        AppType::Code
    } else if ["word", "docs", "notion", "obsidian", "typora"]
        .iter()
        .any(|k| name.contains(k))
    {
        AppType::Document
    } else {
        AppType::General
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::bounds_from_rect;
    #[cfg(target_os = "windows")]
    use super::WindowBounds;

    #[cfg(target_os = "windows")]
    #[test]
    fn window_bounds_reject_tiny_or_invalid_rects() {
        assert_eq!(bounds_from_rect(0, 0, 32, 120), None);
        assert_eq!(bounds_from_rect(20, 20, 10, 10), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn window_bounds_preserve_valid_window_rect() {
        assert_eq!(
            bounds_from_rect(10, 20, 810, 620),
            Some(WindowBounds {
                left: 10,
                top: 20,
                width: 800,
                height: 600,
            })
        );
    }
}
