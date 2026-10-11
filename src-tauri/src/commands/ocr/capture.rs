#[cfg(target_os = "windows")]
use super::CREATE_NO_WINDOW;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const SYSTEM_SCREENSHOT_CANCELLED_EXIT_CODE: i32 = 2;
const SYSTEM_SCREENSHOT_TIMEOUT_MARKER: &str = "ECHOLIKE_SCREENSHOT_TIMEOUT";
pub(super) const WINDOW_CAPTURE_ERROR: &str = "无法截取当前窗口，请确认窗口可见后重试。";
pub(super) const SYSTEM_SCREENSHOT_ERROR: &str = "系统截图失败，请重新尝试。";

fn interpret_window_capture_output(
    success: bool,
    status_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, String> {
    if !success {
        let stderr = String::from_utf8_lossy(stderr);
        tracing::error!(
            status_code = ?status_code,
            stderr = %stderr.trim(),
            "Window capture process failed"
        );
        return Err(WINDOW_CAPTURE_ERROR.to_string());
    }

    let image = match std::str::from_utf8(stdout) {
        Ok(image) => image.trim(),
        Err(error) => {
            tracing::error!(%error, "Window capture returned non-UTF-8 output");
            return Err(WINDOW_CAPTURE_ERROR.to_string());
        }
    };
    if image.is_empty() {
        tracing::error!("Window capture returned an empty image");
        Err(WINDOW_CAPTURE_ERROR.to_string())
    } else {
        Ok(image.to_string())
    }
}

#[cfg(target_os = "windows")]
pub(super) fn capture_window_png_base64(
    bounds: Option<crate::app_detector::WindowBounds>,
) -> Result<String, String> {
    let bounds_script = if let Some(bounds) = bounds {
        format!(
            "$bounds = New-Object System.Drawing.Rectangle {}, {}, {}, {}",
            bounds.left, bounds.top, bounds.width, bounds.height
        )
    } else {
        "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen".to_string()
    };
    let script = format!(
        r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
{bounds_script}
$dpiSource = @'
using System.Runtime.InteropServices;
public static class EchoDpiAwareness {{
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}}
'@
try {{
  Add-Type -TypeDefinition $dpiSource -ErrorAction SilentlyContinue | Out-Null
  [EchoDpiAwareness]::SetProcessDPIAware() | Out-Null
}} catch {{}}
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bounds = [System.Drawing.Rectangle]::Intersect($bounds, $screen)
if ($bounds.Width -le 0 -or $bounds.Height -le 0) {{
  $bounds = $screen
}}
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$memory = New-Object System.IO.MemoryStream
try {{
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.Write([Convert]::ToBase64String($memory.ToArray()))
}} finally {{
  $memory.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}}
"#
    );

    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| {
            tracing::error!(%error, "Failed to launch the window capture process");
            WINDOW_CAPTURE_ERROR.to_string()
        });

    let output = output?;
    interpret_window_capture_output(
        output.status.success(),
        output.status.code(),
        &output.stdout,
        &output.stderr,
    )
}

#[cfg(target_os = "windows")]
const SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$cancelExitCode = 2
$overlayProcessNames = @('ScreenClippingHost', 'SnippingTool')

$clipboardSource = @'
using System.Runtime.InteropServices;
public static class EchoClipboard {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern System.IntPtr GetClipboardOwner();
  [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int virtualKey);
}
'@
try {
  Add-Type -TypeDefinition $clipboardSource -ErrorAction SilentlyContinue | Out-Null
} catch {}

function Get-ClipboardPngBytes {
  try {
    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { return $null }
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $image) { return $null }
    $memory = New-Object System.IO.MemoryStream
    try {
      $image.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      return $memory.ToArray()
    } finally {
      $memory.Dispose()
      $image.Dispose()
    }
  } catch {
    return $null
  }
}

function Get-BytesHash($bytes) {
  if ($null -eq $bytes) { return '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

function Get-OverlayProcessIds {
  $ids = @()
  foreach ($name in $overlayProcessNames) {
    $ids += @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  }
  return @($ids | Sort-Object -Unique)
}

function Get-WindowProcessName($window) {
  try {
    if ($window -eq [System.IntPtr]::Zero) { return '' }
    [uint32]$foregroundProcessId = 0
    [void][EchoClipboard]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId)
    if ($foregroundProcessId -eq 0) { return '' }
    return (Get-Process -Id $foregroundProcessId -ErrorAction Stop).ProcessName
  } catch {
    return ''
  }
}

function Get-ForegroundProcessName {
  return Get-WindowProcessName ([EchoClipboard]::GetForegroundWindow())
}

function Get-ClipboardOwnerProcessName {
  return Get-WindowProcessName ([EchoClipboard]::GetClipboardOwner())
}

function Get-ClipboardSequence {
  try {
    return [EchoClipboard]::GetClipboardSequenceNumber()
  } catch {
    return 0
  }
}

function Test-EscapePressed {
  try {
    $state = [int][EchoClipboard]::GetAsyncKeyState(0x1B)
    return (($state -band 0x8000) -ne 0) -or (($state -band 0x0001) -ne 0)
  } catch {
    return $false
  }
}

function Reset-EscapeState {
  try {
    [void][EchoClipboard]::GetAsyncKeyState(0x1B)
  } catch {}
}

function Exit-Cancelled {
  [Console]::Error.Write('ECHOLIKE_SCREENSHOT_CANCELLED')
  exit $cancelExitCode
}

$initialBytes = Get-ClipboardPngBytes
$initialHash = Get-BytesHash $initialBytes
$initialSequence = Get-ClipboardSequence
$baselineOverlayIds = @(Get-OverlayProcessIds)
Reset-EscapeState
Start-Process 'ms-screenclip:'

$deadline = [DateTime]::UtcNow.AddSeconds(45)
$trackedOverlayIds = @()
$overlayObserved = $false
$overlayWasForeground = $false
$overlayLostAt = $null
do {
  Start-Sleep -Milliseconds 80
  $overlayIds = @(Get-OverlayProcessIds)
  $newOverlayIds = @($overlayIds | Where-Object { $baselineOverlayIds -notcontains $_ })
  if ($newOverlayIds.Count -gt 0) {
    $overlayObserved = $true
    $trackedOverlayIds = @(($trackedOverlayIds + $newOverlayIds) | Sort-Object -Unique)
  }

  $foregroundName = Get-ForegroundProcessName
  if ($overlayProcessNames -contains $foregroundName) {
    $overlayObserved = $true
    $overlayWasForeground = $true
    $overlayLostAt = $null
  }

  if ($overlayObserved -and (Test-EscapePressed)) {
    Exit-Cancelled
  }

  $sequence = Get-ClipboardSequence
  $sequenceChanged = $sequence -ne $initialSequence
  if ($sequenceChanged) {
    $bytes = Get-ClipboardPngBytes
    $hash = Get-BytesHash $bytes
    $clipboardOwnerName = Get-ClipboardOwnerProcessName
    $imageChanged = $hash -ne $initialHash
    $sameImageReplacedByOverlay =
      $overlayObserved -and $overlayProcessNames -contains $clipboardOwnerName
    if (
      $null -ne $bytes -and
      $hash -and
      ($imageChanged -or $sameImageReplacedByOverlay)
    ) {
      [Console]::Out.Write([Convert]::ToBase64String($bytes))
      exit 0
    }
  }

  $trackedOverlayActive = @($overlayIds | Where-Object { $trackedOverlayIds -contains $_ })
  $overlayDisappeared =
    ($trackedOverlayIds.Count -gt 0 -and $trackedOverlayActive.Count -eq 0) -or
    ($overlayWasForeground -and $overlayProcessNames -notcontains $foregroundName)

  if ($overlayObserved -and $overlayDisappeared) {
    if ($null -eq $overlayLostAt) {
      $overlayLostAt = [DateTime]::UtcNow
    } elseif (([DateTime]::UtcNow - $overlayLostAt).TotalMilliseconds -ge 1000) {
      Exit-Cancelled
    }
  } elseif (-not $overlayDisappeared) {
    $overlayLostAt = $null
  }
} while ([DateTime]::UtcNow -lt $deadline)

[Console]::Error.Write('ECHOLIKE_SCREENSHOT_TIMEOUT')
exit 1
"#;

fn interpret_system_screenshot_output(
    success: bool,
    status_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Option<String>, String> {
    if !success {
        if status_code == Some(SYSTEM_SCREENSHOT_CANCELLED_EXIT_CODE) {
            return Ok(None);
        }

        let stderr = String::from_utf8_lossy(stderr);
        if stderr
            .lines()
            .any(|line| line.trim() == SYSTEM_SCREENSHOT_TIMEOUT_MARKER)
        {
            return Err("截图等待已超时，请重新发起截图。".to_string());
        }

        tracing::error!(
            status_code = ?status_code,
            stderr = %stderr.trim(),
            "System screenshot process failed"
        );
        return Err(SYSTEM_SCREENSHOT_ERROR.to_string());
    }

    let image = match std::str::from_utf8(stdout) {
        Ok(image) => image.trim(),
        Err(error) => {
            tracing::error!(%error, "System screenshot returned non-UTF-8 output");
            return Err(SYSTEM_SCREENSHOT_ERROR.to_string());
        }
    };
    if image.is_empty() {
        tracing::error!("System screenshot returned an empty image");
        Err(SYSTEM_SCREENSHOT_ERROR.to_string())
    } else {
        Ok(Some(image.to_string()))
    }
}

#[cfg(target_os = "windows")]
pub(super) fn capture_system_screenshot_png_base64() -> Result<Option<String>, String> {
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| {
            tracing::error!(%error, "Failed to launch the system screenshot process");
            SYSTEM_SCREENSHOT_ERROR.to_string()
        })?;

    interpret_system_screenshot_output(
        output.status.success(),
        output.status.code(),
        &output.stdout,
        &output.stderr,
    )
}

#[cfg(not(target_os = "windows"))]
pub(super) fn capture_window_png_base64(
    _bounds: Option<crate::app_detector::WindowBounds>,
) -> Result<String, String> {
    Err("当前系统暂不支持窗口截图识别。".to_string())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn capture_system_screenshot_png_base64() -> Result<Option<String>, String> {
    Err("当前系统暂不支持系统截图识别。".to_string())
}

#[cfg(test)]
mod tests {
    use super::super::ScreenOcrSelectionOutcome;
    use super::*;

    #[test]
    fn system_screenshot_cancel_exit_is_a_clean_no_result() {
        assert_eq!(
            interpret_system_screenshot_output(
                false,
                Some(SYSTEM_SCREENSHOT_CANCELLED_EXIT_CODE),
                b"",
                b"ECHOLIKE_SCREENSHOT_CANCELLED",
            ),
            Ok(None)
        );
        assert_eq!(
            serde_json::to_value(ScreenOcrSelectionOutcome::Cancelled).unwrap(),
            serde_json::json!({ "status": "cancelled" })
        );
    }

    #[test]
    fn system_screenshot_timeout_remains_a_real_error() {
        assert_eq!(
            interpret_system_screenshot_output(
                false,
                Some(1),
                b"",
                SYSTEM_SCREENSHOT_TIMEOUT_MARKER.as_bytes(),
            ),
            Err("截图等待已超时，请重新发起截图。".to_string())
        );
    }

    #[test]
    fn system_screenshot_success_requires_a_non_empty_image() {
        assert_eq!(
            interpret_system_screenshot_output(true, Some(0), b" aW1hZ2U=\r\n", b""),
            Ok(Some("aW1hZ2U=".to_string()))
        );
        assert_eq!(
            interpret_system_screenshot_output(true, Some(0), b"  ", b""),
            Err(SYSTEM_SCREENSHOT_ERROR.to_string())
        );
    }

    #[test]
    fn screenshot_error_records_do_not_cross_the_ipc_boundary() {
        let error_record = br#"At C:\Users\TestUser\AppData\Local\Temp\echolike-capture.ps1:51 char:3
+ $graphics.CopyFromScreen(...)
+ CategoryInfo : NotSpecified: (:) [], RuntimeException
+ FullyQualifiedErrorId : ExternalException"#;

        let window_error =
            interpret_window_capture_output(false, Some(1), b"", error_record).unwrap_err();
        let system_error =
            interpret_system_screenshot_output(false, Some(1), b"", error_record).unwrap_err();

        assert_eq!(window_error, WINDOW_CAPTURE_ERROR);
        assert_eq!(system_error, SYSTEM_SCREENSHOT_ERROR);
        for error in [&window_error, &system_error] {
            for private_detail in [
                "C:\\Users",
                "CategoryInfo",
                "RuntimeException",
                "CopyFromScreen",
            ] {
                assert!(!error.contains(private_detail));
            }
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn system_screenshot_script_observes_overlay_exit_and_rejects_stale_clipboard_images() {
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("ScreenClippingHost"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("GetForegroundWindow"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("$cancelExitCode = 2"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("exit $cancelExitCode"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("$hash -ne $initialHash"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT
            .contains("$sequenceChanged = $sequence -ne $initialSequence"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("if ($sequenceChanged)"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("GetClipboardOwner"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT
            .contains("$overlayProcessNames -contains $clipboardOwnerName"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains("Reset-EscapeState"));
        assert!(SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT.contains(SYSTEM_SCREENSHOT_TIMEOUT_MARKER));
        assert!(!SYSTEM_SCREENSHOT_POWERSHELL_SCRIPT
            .contains("($sequence -ne $initialSequence) -or ($hash -ne $initialHash)"));
    }
}
