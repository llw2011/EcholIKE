!include "WinVer.nsh"

; This hidden section is included before Tauri's built-in WebView2 section, so unsupported
; systems fail with a useful message before MicrosoftEdgeUpdate.exe is launched.
Section -MinimumWindowsVersion
  ${IfNot} ${AtLeastWin10}
    ${If} ${Silent}
      SetErrorLevel 1150
      Quit
    ${EndIf}

    MessageBox MB_OK|MB_ICONSTOP "此版本 EcholIKE 需要 Windows 10 或 Windows Server 2016 及以上版本。$\r$\n$\r$\nWindows 7、Windows Server 2008 R2 及更早系统不受支持，安装即将退出。"
    SetErrorLevel 1150
    Quit
  ${EndIf}
SectionEnd
