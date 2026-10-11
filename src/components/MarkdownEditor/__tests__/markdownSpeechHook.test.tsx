import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownDraft } from '../markdownDraft'

const mocks = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
  getState: vi.fn(),
  start: vi.fn(),
  read: vi.fn(),
  openDirectory: vi.fn(),
  reveal: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('../../../lib/tauri', () => ({
  getMarkdownSpeechState: mocks.getState,
  startMarkdownSpeechGeneration: mocks.start,
  readMarkdownSpeechAudio: mocks.read,
  openMarkdownSpeechDirectory: mocks.openDirectory,
  revealMarkdownSpeechAsset: mocks.reveal,
  acquireTtsPlaybackOwner: mocks.acquire,
  releaseTtsPlaybackOwner: mocks.release,
}))

import { markdownSpeechKey, useMarkdownSpeech } from '../markdownSpeech'

function draft(text: string, id = 'draft-1'): MarkdownDraft {
  return {
    id,
    title: '文稿',
    text,
    source: 'manual',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    dirty: true,
  }
}

const config = {
  available: true,
  apiBaseUrl: 'https://api.test',
  token: 'token',
  voiceKey: 'alloy',
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useMarkdownSpeech', () => {
  it('keeps one event subscription per draft and debounces per-keystroke artifact queries', async () => {
    vi.useFakeTimers()
    mocks.getState.mockImplementation(async (key) => ({
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: '',
    }))
    const { rerender } = renderHook(({ text }) => useMarkdownSpeech(draft(text), config), {
      initialProps: { text: 'a' },
    })
    await act(async () => Promise.resolve())

    rerender({ text: 'ab' })
    rerender({ text: 'abc' })
    rerender({ text: 'abcd' })

    expect(mocks.listen).toHaveBeenCalledTimes(1)
    expect(mocks.getState).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(181))

    expect(mocks.getState).toHaveBeenCalledTimes(1)
    expect(mocks.getState).toHaveBeenCalledWith(markdownSpeechKey(draft('abcd'), config))
  })

  it('replaces the draft-scoped subscription when a different document opens', async () => {
    const firstUnlisten = vi.fn()
    mocks.listen.mockResolvedValueOnce(firstUnlisten).mockResolvedValueOnce(() => undefined)
    mocks.getState.mockImplementation(async (key) => ({
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: '',
    }))
    const { rerender } = renderHook(({ id }) => useMarkdownSpeech(draft('正文', id), config), {
      initialProps: { id: 'draft-1' },
    })
    await act(async () => Promise.resolve())

    rerender({ id: 'draft-2' })
    await act(async () => Promise.resolve())

    expect(firstUnlisten).toHaveBeenCalledOnce()
    expect(mocks.listen).toHaveBeenCalledTimes(2)
  })

  it('never regresses running progress and keeps foreign-window feedback silent', async () => {
    vi.useFakeTimers()
    mocks.getState.mockImplementation(async (key) => ({
      key,
      task: null,
      currentAsset: null,
      latestAsset: null,
      directoryPath: '',
    }))
    const { result } = renderHook(() => useMarkdownSpeech(draft('正文'), config))
    await act(async () => Promise.resolve())
    const receive = mocks.listen.mock.calls[0][1]
    const key = markdownSpeechKey(draft('正文'), config)

    act(() => {
      receive({
        payload: {
          key,
          ownerWindow: 'main',
          outcome: { status: 'running', leaseId: 8, completedChunks: 2, totalChunks: 4 },
        },
      })
      receive({
        payload: {
          key,
          ownerWindow: 'main',
          outcome: { status: 'running', leaseId: 8, completedChunks: 1, totalChunks: 4 },
        },
      })
    })
    expect(result.current.state?.task?.outcome).toMatchObject({
      status: 'running',
      leaseId: 8,
      completedChunks: 2,
    })

    act(() => {
      receive({
        payload: {
          key,
          ownerWindow: 'markdown-editor',
          outcome: { status: 'error', leaseId: 8, error: 'foreign failure' },
        },
      })
    })

    expect(result.current.state?.task?.outcome).toMatchObject({
      status: 'error',
      leaseId: 8,
    })
    expect(result.current.error).toBe('')
    expect(result.current.dialogAsset).toBeNull()
  })
})
