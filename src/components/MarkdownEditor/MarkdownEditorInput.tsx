import { useEffect, useMemo, useRef } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view'
import type { MarkdownTextSelection } from './markdownActions'
import { markdownEditorThemeExtensions } from './markdownEditorTheme'
import {
  createMarkdownEditorInputScrollSurface,
  type MarkdownScrollSurface,
} from './markdownScrollSync'

export interface MarkdownEditorInputProps {
  value: string
  onChange: (value: string) => void
  onSelectionChange?: (selection: MarkdownTextSelection) => void
  requestedSelection?: MarkdownTextSelection | null
  themeKey: string
  readOnly?: boolean
  onScrollSurfaceChange?: (surface: MarkdownScrollSurface | null) => void
  ariaLabel?: string
  placeholderText?: string
}

export function MarkdownEditorInput({
  value,
  onChange,
  onSelectionChange,
  requestedSelection,
  themeKey,
  readOnly = false,
  onScrollSurfaceChange,
  ariaLabel = 'Markdown 源文',
  placeholderText = '开始整理 Markdown...',
}: MarkdownEditorInputProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const externalValueSyncRef = useRef(false)
  const initialValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onScrollSurfaceChangeRef = useRef(onScrollSurfaceChange)
  const initialReadOnlyRef = useRef(readOnly)
  const themeCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

  useEffect(() => {
    onScrollSurfaceChangeRef.current = onScrollSurfaceChange
  }, [onScrollSurfaceChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host || viewRef.current) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown(),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'false',
          }),
          placeholder(placeholderText),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          themeCompartment.of(markdownEditorThemeExtensions()),
          readOnlyCompartment.of(markdownEditorReadOnlyExtensions(initialReadOnlyRef.current)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalValueSyncRef.current) {
              onChangeRef.current(update.state.doc.toString())
            }
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main
              onSelectionChangeRef.current?.({ from: range.from, to: range.to })
            }
          }),
        ],
      }),
    })

    viewRef.current = view
    onScrollSurfaceChangeRef.current?.(createMarkdownEditorInputScrollSurface(view))

    return () => {
      onScrollSurfaceChangeRef.current?.(null)
      view.destroy()
      viewRef.current = null
    }
  }, [ariaLabel, placeholderText, readOnlyCompartment, themeCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const current = view.state.doc.toString()
    if (current === value) return

    externalValueSyncRef.current = true
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    } finally {
      externalValueSyncRef.current = false
    }
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(markdownEditorThemeExtensions()),
    })
  }, [themeCompartment, themeKey])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(markdownEditorReadOnlyExtensions(readOnly)),
    })
  }, [readOnly, readOnlyCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !requestedSelection) return

    const docLength = view.state.doc.length
    const from = Math.max(0, Math.min(requestedSelection.from, docLength))
    const to = Math.max(0, Math.min(requestedSelection.to, docLength))
    view.dispatch({
      selection: { anchor: from, head: to },
      scrollIntoView: true,
    })
    view.focus()
  }, [requestedSelection])

  return <div ref={hostRef} className="echo-markdown-input" data-theme-key={themeKey} />
}

function markdownEditorReadOnlyExtensions(readOnly: boolean) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly) }),
  ]
}
