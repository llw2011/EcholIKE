import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { isDarkThemeAppearance } from '../../lib/appearanceProfiles'

export function isMarkdownEditorDarkAppearance(root: HTMLElement = document.documentElement) {
  return isDarkThemeAppearance(root.classList.contains('dark'), root.dataset.themeProfile || 'echo')
}

export function getMarkdownEditorThemeKey(root: HTMLElement = document.documentElement) {
  const mode = isMarkdownEditorDarkAppearance(root) ? 'dark' : 'light'
  const profile = root.dataset.themeProfile || 'echo'
  return `${mode}:${profile}`
}

export function markdownEditorThemeExtensions() {
  const dark = isMarkdownEditorDarkAppearance()
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          backgroundColor: 'var(--echo-surface)',
          color: 'var(--echo-text)',
          fontSize: '14px',
        },
        '&.cm-focused': {
          outline: 'none',
        },
        '.cm-scroller': {
          fontFamily: "Consolas, 'SFMono-Regular', Menlo, monospace",
          lineHeight: '1.65',
        },
        '.cm-content': {
          minHeight: '100%',
          padding: '14px 0',
          caretColor: 'var(--echo-accent)',
        },
        '.cm-line': {
          padding: '0 14px',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--echo-surface-2)',
          color: 'var(--echo-muted)',
          borderRight: '1px solid var(--echo-border-soft)',
        },
        '.cm-lineNumbers .cm-gutterElement': {
          padding: '0 8px 0 10px',
        },
        '.cm-activeLine': {
          backgroundColor: 'color-mix(in srgb, var(--echo-accent-soft) 45%, transparent)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'var(--echo-accent-soft)',
          color: 'var(--echo-accent)',
        },
        '&.cm-focused .cm-cursor': {
          borderLeftColor: 'var(--echo-accent)',
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: 'color-mix(in srgb, var(--echo-accent) 24%, transparent)',
        },
        '.cm-placeholder': {
          color: 'var(--echo-muted)',
        },
        '.cm-searchMatch': {
          backgroundColor: 'color-mix(in srgb, var(--echo-warn) 26%, transparent)',
          outline: '1px solid color-mix(in srgb, var(--echo-warn) 55%, transparent)',
        },
        '.cm-searchMatch-selected': {
          backgroundColor: 'color-mix(in srgb, var(--echo-accent) 30%, transparent)',
        },
      },
      { dark },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: tags.heading, color: 'var(--echo-accent)', fontWeight: '800' },
        { tag: tags.strong, color: 'var(--echo-text)', fontWeight: '800' },
        { tag: tags.emphasis, color: 'var(--echo-text)', fontStyle: 'italic' },
        { tag: tags.monospace, color: 'var(--echo-danger)' },
        { tag: tags.link, color: 'var(--echo-accent)', textDecoration: 'underline' },
        { tag: tags.quote, color: 'var(--echo-muted)' },
        { tag: tags.contentSeparator, color: 'var(--echo-muted)' },
      ]),
      { fallback: true },
    ),
  ]
}
