import { describe, expect, it } from 'vitest'
import rustSource from '../../src-tauri/src/lib.rs?raw'
import hotkeySource from '../../src-tauri/src/hotkey.rs?raw'
import managedStateSource from '../../src-tauri/src/managed_state.rs?raw'
import markdownWindowSource from '../../src-tauri/src/markdown_window.rs?raw'
import traySource from '../../src-tauri/src/tray.rs?raw'
import windowRuntimeSource from '../../src-tauri/src/window_runtime.rs?raw'
import defaultCapability from '../../src-tauri/capabilities/default.json'
import tauriConfig from '../../src-tauri/tauri.conf.json'
import minimumWindowsHook from '../../src-tauri/nsis/minimum-windows.nsh?raw'

describe('Windows installer config', () => {
  it('embeds the WebView2 offline installer for air-gapped machines', () => {
    const config = tauriConfig as {
      bundle?: {
        windows?: {
          webviewInstallMode?: {
            type?: string
            silent?: boolean
          }
          nsis?: {
            installerHooks?: string
          }
        }
      }
    }

    expect(config.bundle?.windows?.webviewInstallMode).toEqual({
      type: 'offlineInstaller',
      silent: true,
    })
    expect(config.bundle?.windows?.nsis?.installerHooks).toBe('./nsis/minimum-windows.nsh')
  })

  it('rejects unsupported Windows releases before launching the WebView2 installer', () => {
    expect(minimumWindowsHook).toContain('Section -MinimumWindowsVersion')
    expect(minimumWindowsHook).toContain('${IfNot} ${AtLeastWin10}')
    expect(minimumWindowsHook).toContain('Windows Server 2008 R2')
    expect(minimumWindowsHook).toContain('SetErrorLevel 1150')
    expect(minimumWindowsHook).toContain('Quit')
  })

  it('keeps the main window transparent and permits synchronized window/WebView backgrounds', () => {
    const mainWindow = tauriConfig.app.windows.find((window) => window.label === 'main')

    expect(mainWindow?.transparent).toBe(true)
    expect(mainWindow?.width).toBe(1180)
    expect(mainWindow?.height).toBe(820)
    expect(mainWindow?.minWidth).toBe(520)
    expect(mainWindow?.minHeight).toBe(340)
    expect(defaultCapability.permissions).toContain(
      'core:webview:allow-set-webview-background-color',
    )
    expect(defaultCapability.permissions).toContain('core:window:allow-set-background-color')
    expect(defaultCapability.permissions).not.toContain('core:webview:allow-create-webview-window')
  })

  it('keeps generated WAV blob playback inside the desktop CSP', () => {
    expect(tauriConfig.app.security.csp).toMatch(/media-src[^;]*\bblob:/)
  })

  it('creates startup WebViews only after native command state and services are ready', () => {
    const mainWindow = tauriConfig.app.windows.find((window) => window.label === 'main')
    const capsuleWindow = tauriConfig.app.windows.find((window) => window.label === 'capsule')
    const initializeManagedState = rustSource.indexOf(
      'let initial_config = managed_state::initialize(app)?',
    )
    const lastManage = managedStateSource.indexOf(
      'app.manage(onboarding_guard::OnboardingGuard::new(boot_blocked))',
    )
    const synchronizeAutoStart = rustSource.indexOf(
      'commands::config::synchronize_auto_start(app.handle(), &initial_config)',
      initializeManagedState,
    )
    const registerShortcuts = rustSource.indexOf(
      'hotkey::install_configured_shortcuts(app.handle(), &initial_config)',
      synchronizeAutoStart,
    )
    const installShortcutHandler = hotkeySource.indexOf(
      'let handler = build_shortcut_handler(app.clone())',
    )
    const installShortcutPlugin = hotkeySource.indexOf('app.plugin(', installShortcutHandler)
    const registerConfiguredShortcuts = hotkeySource.indexOf(
      'register_configured_shortcuts(app, config)',
      installShortcutPlugin,
    )
    const trayBuild = rustSource.indexOf(
      'tray::install_tray(app, &initial_config)',
      registerShortcuts,
    )
    const createCapsule = rustSource.indexOf(
      'window_runtime::create_capsule_window(app, &startup_window_configs)',
      trayBuild,
    )
    const createMain = rustSource.indexOf(
      'window_runtime::create_main_window(app, &startup_window_configs)',
      createCapsule,
    )
    const attachMainWindowHandler = rustSource.indexOf(
      'window_runtime::attach_main_window_handler(app)',
      createMain,
    )
    const prepareMainPosition = rustSource.indexOf(
      'window_runtime::restore_or_center_main_window(app)',
      attachMainWindowHandler,
    )
    const openDevtools = rustSource.indexOf(
      'window_runtime::open_devtools(app)',
      prepareMainPosition,
    )
    const capsuleBuilder = windowRuntimeSource.indexOf('fn create_capsule_window(')
    const mainBuilder = windowRuntimeSource.indexOf('fn create_main_window(', capsuleBuilder)
    const mainWindowHandler = windowRuntimeSource.indexOf(
      'fn attach_main_window_handler(',
      mainBuilder,
    )

    expect(mainWindow?.create).toBe(false)
    expect(capsuleWindow?.create).toBe(false)
    expect(lastManage).toBeGreaterThan(-1)
    expect(managedStateSource.indexOf('Ok(initial_config)', lastManage)).toBeGreaterThan(lastManage)
    expect(synchronizeAutoStart).toBeGreaterThan(initializeManagedState)
    expect(registerShortcuts).toBeGreaterThan(synchronizeAutoStart)
    expect(installShortcutHandler).toBeGreaterThanOrEqual(0)
    expect(installShortcutPlugin).toBeGreaterThan(installShortcutHandler)
    expect(registerConfiguredShortcuts).toBeGreaterThan(installShortcutPlugin)
    expect(trayBuild).toBeGreaterThan(registerShortcuts)
    expect(traySource).toMatch(
      /fn install_tray\([\s\S]*?build_tray_menu\([\s\S]*?TrayIconBuilder::with_id\(TRAY_ID\)[\s\S]*?\.on_menu_event\([\s\S]*?\.on_tray_icon_event\([\s\S]*?\.build\(app\)/,
    )
    expect(createCapsule).toBeGreaterThan(trayBuild)
    expect(createMain).toBeGreaterThan(createCapsule)
    expect(attachMainWindowHandler).toBeGreaterThan(createMain)
    expect(prepareMainPosition).toBeGreaterThan(attachMainWindowHandler)
    expect(openDevtools).toBeGreaterThan(prepareMainPosition)
    expect(windowRuntimeSource.slice(capsuleBuilder, mainBuilder)).toContain(
      '.background_color(tauri::window::Color(0, 0, 0, 0))',
    )
    expect(windowRuntimeSource.slice(mainBuilder, mainWindowHandler)).toContain(
      'responsive_main_window_size',
    )
    expect(windowRuntimeSource.slice(mainBuilder, mainWindowHandler)).toContain(
      '.inner_size(responsive_size.width, responsive_size.height)',
    )
    expect(windowRuntimeSource.slice(mainBuilder, mainWindowHandler)).toContain(
      '.prevent_overflow()',
    )
    expect(windowRuntimeSource.slice(mainBuilder, mainWindowHandler)).not.toContain('.set_size(')
    expect(windowRuntimeSource).toContain('store(storage::RUNTIME_STATE_STORE_FILE)')
    expect(rustSource).toContain('window_runtime::sync_main_window_shape,')
  })

  it('reports v2 storage failures before exiting native setup', () => {
    const loadConfig = managedStateSource.indexOf('config_manager.load_snapshot()')
    const showNativeError = managedStateSource.indexOf(
      '.kind(MessageDialogKind::Error)',
      loadConfig,
    )
    const initializeManagedState = rustSource.indexOf('managed_state::initialize(app)?')
    const createMain = rustSource.indexOf(
      'window_runtime::create_main_window(app, &startup_window_configs)',
    )

    expect(loadConfig).toBeGreaterThan(-1)
    expect(showNativeError).toBeGreaterThan(loadConfig)
    expect(initializeManagedState).toBeGreaterThan(-1)
    expect(createMain).toBeGreaterThan(initializeManagedState)
    expect(managedStateSource).toContain('本地配置无法初始化，EcholIKE 将退出。')
  })

  it('keeps the native main window hidden until the renderer reveals a painted frame', () => {
    expect(`${rustSource}\n${windowRuntimeSource}`).not.toMatch(
      /if !initial_config\.start_minimized\s*\{[\s\S]{0,240}?window\.show\(\)/,
    )
  })

  it('resynchronizes the dynamic Markdown shape from current geometry after resize or DPI changes', () => {
    const markdownShapeListener = windowRuntimeSource.match(
      /fn handle_global_window_event\([\s\S]*?window\.label\(\) == "markdown-editor"[\s\S]*?WindowEvent::Resized\(_\)[\s\S]*?WindowEvent::ScaleFactorChanged \{ \.\. \}[\s\S]*?sync_markdown_editor_rounding\(&shape_window\)/,
    )?.[0]

    expect(markdownShapeListener).toBeDefined()
    expect(rustSource).toContain('.on_window_event(window_runtime::handle_global_window_event)')
    expect(markdownShapeListener).not.toContain('new_inner_size')
    expect(markdownShapeListener).not.toContain('scale_factor,')
  })

  it('reveals Markdown only through the generation-fenced native renderer-ready command', () => {
    const revealCommand = markdownWindowSource.match(
      /fn reveal_markdown_editor_window_generation\([\s\S]*?lifecycle\.begin_reveal\(generation\)\?;[\s\S]*?sync_markdown_editor_rounding\([\s\S]*?window\.show\(\)[\s\S]*?lifecycle\.mark_visible\(generation\)/,
    )?.[0]

    expect(revealCommand).toBeDefined()
    expect(managedStateSource).toContain(
      'app.manage(markdown_window::MarkdownEditorWindowLifecycle::default())',
    )
    expect(markdownWindowSource).toContain('async fn begin_markdown_editor_window(')
    expect(rustSource).toContain('markdown_window::begin_markdown_editor_window,')
    expect(rustSource).toContain('markdown_window::reveal_markdown_editor_window,')
    expect(markdownWindowSource).toMatch(
      /editor\.on_window_event\([\s\S]*?WindowEvent::Destroyed[\s\S]*?lifecycle\.destroyed\(generation\)/,
    )
  })

  it('releases process-owned work when a native window is actually destroyed', () => {
    const destroyedHandler = windowRuntimeSource.match(
      /WindowEvent::Destroyed[\s\S]*?try_state::<process_ownership::ProcessOwners>[\s\S]*?owner_window_destroyed\(window\.label\(\)\)/,
    )

    expect(destroyedHandler).not.toBeNull()
  })
})
