import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
  get: vi.fn().mockResolvedValue([]),
  consume: vi.fn().mockResolvedValue('consumed'),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('../../lib/tauri', () => ({
  getFileCommandTasks: mocks.get,
  consumeFileCommandTask: mocks.consume,
}))

import { fileCommandIdentity, useFileCommandDomain } from '../fileCommandStore'

const key = { resourceId: 'draft-a', commandKind: 'saveMarkdown' as const }
const snapshot = (leaseId: number, status: 'running' | 'success', fingerprint = 'rev-1') => ({
  key,
  requestFingerprint: fingerprint,
  outcome:
    status === 'running'
      ? ({ status, leaseId } as const)
      : ({ status, leaseId, path: 'draft-a.md', message: 'saved' } as const),
})

describe('file command domain', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue([])
    mocks.consume.mockReset().mockResolvedValue('consumed')
    useFileCommandDomain.getState().reset()
  })

  it('is idle for a fresh process and listens before querying', async () => {
    await useFileCommandDomain.getState().sync()
    expect(useFileCommandDomain.getState().tasks).toEqual({})
    expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.get.mock.invocationCallOrder[0],
    )
  })

  it('does not let a late query regress terminal to running', async () => {
    useFileCommandDomain.getState().accept(snapshot(4, 'success'))
    mocks.get.mockResolvedValue([snapshot(4, 'running')])
    await useFileCommandDomain.getState().sync()
    expect(useFileCommandDomain.getState().tasks[fileCommandIdentity(key)].outcome.status).toBe(
      'success',
    )
  })

  it('keeps a newer running lease when stale terminal is consumed or delivered', async () => {
    const old = snapshot(4, 'success')
    useFileCommandDomain.getState().accept(old)
    useFileCommandDomain.getState().accept(snapshot(5, 'running', 'rev-2'))
    await useFileCommandDomain.getState().consume(old)
    useFileCommandDomain.getState().accept(old)
    const current = useFileCommandDomain.getState().tasks[fileCommandIdentity(key)]
    expect(current.outcome).toEqual({ status: 'running', leaseId: 5 })
    expect(current.requestFingerprint).toBe('rev-2')
  })

  it('exposes the frozen revision so old save completion cannot clear newer dirty text', () => {
    useFileCommandDomain.getState().accept(snapshot(7, 'success', 'rev-before-edit'))
    const completed = useFileCommandDomain.getState().tasks[fileCommandIdentity(key)]
    expect(completed.requestFingerprint).not.toBe('rev-after-edit')
  })

  it('reconciles an outcome consumed by another WebView without locally faking success', async () => {
    const terminal = snapshot(12, 'success')
    useFileCommandDomain.getState().accept(terminal)
    mocks.consume.mockResolvedValueOnce('alreadyConsumed')
    expect(await useFileCommandDomain.getState().consume(terminal)).toBe('alreadyConsumed')
    expect(useFileCommandDomain.getState().tasks[fileCommandIdentity(key)]).toBeUndefined()
    useFileCommandDomain.getState().accept(terminal)
    expect(useFileCommandDomain.getState().tasks[fileCommandIdentity(key)]).toBeUndefined()
  })

  it('consumes a cancelled save dialog as a silent terminal outcome', async () => {
    const cancelled = {
      key,
      requestFingerprint: 'rev-cancelled',
      outcome: { status: 'cancelled' as const, leaseId: 13 },
    }
    useFileCommandDomain.getState().accept(cancelled)

    expect(await useFileCommandDomain.getState().consume(cancelled)).toBe('consumed')
    expect(useFileCommandDomain.getState().tasks[fileCommandIdentity(key)]).toBeUndefined()
  })

  it('keeps editor feedback across task sync until the editor clears it', async () => {
    const feedback = {
      resourceId: 'draft-a',
      type: 'success' as const,
      message: 'Markdown 已保存到：D:\\Docs\\draft-a.md',
    }
    useFileCommandDomain.getState().setMarkdownFeedback(feedback)

    await useFileCommandDomain.getState().sync()
    expect(useFileCommandDomain.getState().markdownFeedback).toEqual(feedback)

    useFileCommandDomain.getState().setMarkdownFeedback(null)
    expect(useFileCommandDomain.getState().markdownFeedback).toBeNull()
  })

  it('keeps OCR result feedback independently across task sync and Home remounts', async () => {
    const feedback = {
      resourceId: 'ocr:41',
      type: 'success' as const,
      message: 'Word 已保存到：D:\\Docs\\ocr.docx',
    }
    useFileCommandDomain.getState().setOcrFeedback(feedback)

    await useFileCommandDomain.getState().sync()
    expect(useFileCommandDomain.getState().ocrFeedback).toEqual(feedback)
    expect(useFileCommandDomain.getState().markdownFeedback).toBeNull()

    useFileCommandDomain.getState().setOcrFeedback(null)
    expect(useFileCommandDomain.getState().ocrFeedback).toBeNull()
  })
})
