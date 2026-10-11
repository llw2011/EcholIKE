import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownAiTaskSnapshot } from '../../../lib/tauri'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  consume: vi.fn(),
  listener: undefined as undefined | ((event: { payload: MarkdownAiTaskSnapshot }) => void),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, listener) => {
    mocks.listener = listener
    return () => undefined
  }),
}))
vi.mock('../../../lib/tauri', () => ({
  getMarkdownAiTasks: mocks.get,
  consumeMarkdownAiTask: mocks.consume,
}))

import {
  latestMarkdownAiTask,
  latestRunningMarkdownAiTask,
  markdownSemanticFingerprint,
  useMarkdownAiDomain,
} from '../markdownAiTask'

function task(draftId: string, leaseId: number, status: 'running' | 'success' = 'running') {
  return {
    key: {
      draftId,
      request: {
        action: 'polish' as const,
        target: { kind: 'fullDocument' as const },
        draftRevision: 'rev',
        semanticFingerprint: 'scope',
      },
    },
    outcome:
      status === 'running'
        ? ({ status, leaseId } as const)
        : ({ status, leaseId, output: `out-${leaseId}` } as const),
    applyContext: { fullText: 'text', text: 'text', title: 'title' },
  }
}

beforeEach(() => {
  useMarkdownAiDomain.getState().reset()
  mocks.get.mockReset().mockResolvedValue([])
  mocks.consume.mockReset().mockResolvedValue(true)
})

describe('Markdown AI domain', () => {
  it('separates non-sensitive provider and model routing from otherwise identical requests', () => {
    expect(markdownSemanticFingerprint('t', 'c', 'local:ollama:http://a:m1')).not.toBe(
      markdownSemanticFingerprint('t', 'c', 'local:ollama:http://a:m2'),
    )
    expect(markdownSemanticFingerprint('t', 'c', 'proxy:https://a')).not.toBe(
      markdownSemanticFingerprint('t', 'c', 'proxy:https://b'),
    )
  })
  it('starts empty and isolates drafts', () => {
    expect(useMarkdownAiDomain.getState().byDraft).toEqual({})
    useMarkdownAiDomain.getState().accept(task('a', 1))
    useMarkdownAiDomain.getState().accept(task('b', 2))
    expect(useMarkdownAiDomain.getState().byDraft.a[0].outcome.leaseId).toBe(1)
    expect(useMarkdownAiDomain.getState().byDraft.b[0].outcome.leaseId).toBe(2)
  })

  it('claims a local pending draft synchronously and only the matching token can release it', () => {
    const first = useMarkdownAiDomain.getState().tryStartLocal('a', 'polish')

    expect(first).toEqual(expect.any(Number))
    expect(useMarkdownAiDomain.getState().tryStartLocal('a', 'translate')).toBeNull()
    expect(useMarkdownAiDomain.getState().tryStartLocal('b', 'summarize')).toEqual(
      expect.any(Number),
    )
    expect(useMarkdownAiDomain.getState().localPendingByDraft.a).toEqual({
      token: first,
      action: 'polish',
    })

    expect(useMarkdownAiDomain.getState().finishLocal('a', Number(first) + 1)).toBe(false)
    expect(useMarkdownAiDomain.getState().localPendingByDraft.a?.token).toBe(first)
    expect(useMarkdownAiDomain.getState().finishLocal('a', Number(first))).toBe(true)
    expect(useMarkdownAiDomain.getState().localPendingByDraft.a).toBeUndefined()
  })

  it('does not let a stale local token release a lock acquired after reset', () => {
    const stale = useMarkdownAiDomain.getState().tryStartLocal('a', 'polish')!
    useMarkdownAiDomain.getState().reset()
    const current = useMarkdownAiDomain.getState().tryStartLocal('a', 'translate')!

    expect(current).toBeGreaterThan(stale)
    expect(useMarkdownAiDomain.getState().finishLocal('a', stale)).toBe(false)
    expect(useMarkdownAiDomain.getState().localPendingByDraft.a).toEqual({
      token: current,
      action: 'translate',
    })
  })

  it('derives latest and running tasks by lease instead of array order', () => {
    const runningFour = task('a', 4)
    const terminalNine = {
      ...task('a', 9, 'success'),
      key: {
        ...task('a', 9, 'success').key,
        request: {
          ...task('a', 9, 'success').key.request,
          action: 'translate' as const,
        },
      },
    }
    const runningSeven = {
      ...task('a', 7),
      key: {
        ...task('a', 7).key,
        request: {
          ...task('a', 7).key.request,
          action: 'summarize' as const,
        },
      },
    }
    const unordered = [terminalNine, runningFour, runningSeven]

    expect(latestMarkdownAiTask(unordered)?.outcome.leaseId).toBe(9)
    expect(latestRunningMarkdownAiTask(unordered)?.outcome.leaseId).toBe(7)
    expect(
      latestMarkdownAiTask(unordered, (item) => item.key.request.action === 'polish'),
    ).toMatchObject({ outcome: { leaseId: 4 } })
    expect(latestRunningMarkdownAiTask([terminalNine])).toBeNull()
  })

  it('does not let late running sync or old lease accept overwrite terminal/new lease', async () => {
    useMarkdownAiDomain.getState().accept(task('a', 2, 'success'))
    mocks.get.mockResolvedValue([task('a', 2), task('a', 1, 'success')])
    await useMarkdownAiDomain.getState().syncDraft('a')
    useMarkdownAiDomain.getState().accept(task('a', 1, 'success'))
    expect(useMarkdownAiDomain.getState().byDraft.a[0].outcome).toMatchObject({
      status: 'success',
      leaseId: 2,
    })
  })

  it('updates a reopened running view from the one-shot process completion event', async () => {
    mocks.get.mockResolvedValue([task('a', 4)])
    await useMarkdownAiDomain.getState().syncDraft('a')
    expect(useMarkdownAiDomain.getState().byDraft.a[0].outcome.status).toBe('running')
    mocks.listener?.({ payload: task('a', 4, 'success') })
    expect(useMarkdownAiDomain.getState().byDraft.a[0].outcome.status).toBe('success')
  })

  it('marks an empty draft synchronization as complete', async () => {
    expect(useMarkdownAiDomain.getState().byDraft.a).toBeUndefined()

    await useMarkdownAiDomain.getState().syncDraft('a')

    expect(useMarkdownAiDomain.getState().byDraft.a).toEqual([])
  })

  it('cannot consume running and matched old consume cannot delete a reused lease', async () => {
    expect(await useMarkdownAiDomain.getState().consume(task('a', 1))).toBe(false)
    expect(mocks.consume).not.toHaveBeenCalled()
    const old = task('a', 1, 'success')
    useMarkdownAiDomain.getState().accept(old)
    const pendingConsume = useMarkdownAiDomain.getState().consume(old)
    useMarkdownAiDomain.getState().accept(task('a', 2))
    await pendingConsume
    expect(useMarkdownAiDomain.getState().byDraft.a[0].outcome.leaseId).toBe(2)
  })
})
