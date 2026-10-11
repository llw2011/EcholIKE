import { describe, expect, it } from 'vitest'
import markdownWindowSource from '../../src-tauri/src/markdown_window.rs?raw'
import markdownWorkspaceSource from '../components/HomePage/useMarkdownWorkspace.ts?raw'

describe('standalone Markdown editor window config', () => {
  it('creates the native window atomically, hidden and unfocused until renderer-ready', () => {
    const creation = markdownWindowSource.match(
      /async fn begin_markdown_editor_window\([\s\S]*?WebviewWindowBuilder::new\([\s\S]*?\.build\(\)/,
    )?.[0]

    expect(creation).toBeDefined()
    expect(creation).toContain('.visible(false)')
    expect(creation).toContain('.focused(false)')
    expect(creation).toContain('.transparent(true)')
    expect(creation).toContain('.background_color(')
    expect(creation).toContain('.prevent_overflow()')
    expect(creation).toContain('.inner_size(options.width, options.height)')
    expect(creation).toContain('.min_inner_size(options.min_width, options.min_height)')
    expect(creation).not.toContain('.visible(true)')

    expect(markdownWorkspaceSource).toContain('await primaryMonitor().catch(() => null)')
    expect(markdownWorkspaceSource).toContain('const decision = await beginMarkdownEditorWindow({')
    expect(markdownWorkspaceSource).toContain(
      'backgroundColor: currentMarkdownEditorWindowBackgroundColor()',
    )
    expect(markdownWorkspaceSource).toContain("if (decision.status !== 'create')")
    expect(markdownWorkspaceSource).not.toContain('new WebviewWindow')
    expect(markdownWorkspaceSource).not.toContain('WebviewWindow.getByLabel')
  })
})
