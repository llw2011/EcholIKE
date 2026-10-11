import { describe, expect, it } from 'vitest'
import {
  clearHistoryMutationTransition,
  createInitialHistoryState,
  failHistoryMutationTransition,
  finishHistoryMutationTransition,
  refreshHistoryTransition,
  startHistoryMutationTransition,
} from '../appStore.history'
import type { DictionaryEntry, HistoryEntry } from '../appStore'
import { getState, setupAppStoreTestLifecycle } from './appStoreTestHarness'

const entries: HistoryEntry[] = [1, 2, 3, 4].map((id) => ({
  id,
  created_at: `2025-01-0${id}`,
  app_name: 'Test',
  app_type: 'browser',
  raw_text: `entry ${id}`,
  polished_text: '',
  language: 'en',
  duration_ms: 100,
}))

describe('appStore history transitions', () => {
  it('creates an isolated empty initial state', () => {
    const first = createInitialHistoryState()
    const second = createInitialHistoryState()

    expect(first).toEqual({
      history: [],
      historyDeletedIds: [],
      historyClearedThroughId: 0,
      historyMutation: {
        kind: null,
        status: 'idle',
        leaseId: null,
        startedAt: null,
        error: null,
      },
    })
    expect(first.history).not.toBe(second.history)
    expect(first.historyDeletedIds).not.toBe(second.historyDeletedIds)
    expect(first.historyMutation).not.toBe(second.historyMutation)
  })

  it('filters cleared and explicitly deleted entries', () => {
    const state = {
      ...createInitialHistoryState(),
      historyDeletedIds: [3],
      historyClearedThroughId: 1,
    }

    expect(refreshHistoryTransition(state, entries).history.map((entry) => entry.id)).toEqual([
      2, 4,
    ])
  })

  it('creates a running mutation without retaining an earlier error', () => {
    expect(startHistoryMutationTransition('selected', 7, '2026-08-29T00:00:00.000Z')).toEqual({
      historyMutation: {
        kind: 'selected',
        status: 'running',
        leaseId: 7,
        startedAt: '2026-08-29T00:00:00.000Z',
        error: null,
      },
    })
  })

  it('merges, validates and sorts deletion fences without mutating the input state', () => {
    const state = {
      ...createInitialHistoryState(),
      history: entries,
      historyDeletedIds: [4, 2],
      historyClearedThroughId: 1,
      historyMutation: startHistoryMutationTransition('all', 9, '2026-08-29T00:00:00.000Z')
        .historyMutation,
    }
    const next = finishHistoryMutationTransition(state, [3, 3, -1, Number.NaN], 2)

    expect(next.history.map((entry) => entry.id)).toEqual([])
    expect(next.historyDeletedIds).toEqual([3, 4])
    expect(next.historyClearedThroughId).toBe(2)
    expect(next.historyMutation.status).toBe('idle')
    expect(state.history.map((entry) => entry.id)).toEqual([1, 2, 3, 4])
    expect(state.historyDeletedIds).toEqual([4, 2])
  })

  it('preserves mutation identity while clearing its active lease on failure', () => {
    const running = startHistoryMutationTransition(
      'all',
      11,
      '2026-08-29T00:00:00.000Z',
    ).historyMutation

    expect(failHistoryMutationTransition(running, '删除失败')).toEqual({
      historyMutation: {
        kind: 'all',
        status: 'error',
        leaseId: null,
        startedAt: null,
        error: '删除失败',
      },
    })
  })

  it('creates a fresh idle mutation patch when an error is cleared', () => {
    const first = clearHistoryMutationTransition()
    const second = clearHistoryMutationTransition()

    expect(first).toEqual({
      historyMutation: {
        kind: null,
        status: 'idle',
        leaseId: null,
        startedAt: null,
        error: null,
      },
    })
    expect(first.historyMutation).not.toBe(second.historyMutation)
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('history', () => {
    it('defaults to empty array', () => {
      expect(getState().history).toEqual([])
    })

    it('setHistory replaces history', () => {
      const entries: HistoryEntry[] = [
        {
          id: 1,
          created_at: '2025-01-01',
          app_name: 'Test',
          app_type: 'browser',
          raw_text: 'hello',
          polished_text: 'Hello.',
          language: 'en',
          duration_ms: 1200,
        },
      ]
      getState().setHistory(entries)
      expect(getState().history).toHaveLength(1)
      expect(getState().history[0].raw_text).toBe('hello')
    })

    it('keeps delete mutations exclusive and filters stale history refreshes', () => {
      const entries: HistoryEntry[] = [1, 2, 3].map((id) => ({
        id,
        created_at: `2025-01-0${id}`,
        app_name: 'Test',
        app_type: 'browser',
        raw_text: `entry ${id}`,
        polished_text: '',
        language: 'en',
        duration_ms: 100,
      }))
      getState().setHistory(entries)

      const selectedLease = getState().tryStartHistoryMutation('selected') ?? -1
      expect(getState().tryStartHistoryMutation('all')).toBeNull()
      expect(getState().finishHistoryMutation(selectedLease, [2])).toBe(true)
      expect(getState().history.map((entry) => entry.id)).toEqual([1, 3])

      getState().setHistory(entries)
      expect(getState().history.map((entry) => entry.id)).toEqual([1, 3])

      const clearLease = getState().tryStartHistoryMutation('all') ?? -1
      expect(getState().finishHistoryMutation(selectedLease, [1])).toBe(false)
      expect(getState().historyMutation).toMatchObject({
        kind: 'all',
        status: 'running',
        leaseId: clearLease,
      })
      expect(getState().finishHistoryMutation(clearLease, [], 3)).toBe(true)
      expect(getState().history).toEqual([])

      getState().setHistory([
        ...entries,
        {
          ...entries[0]!,
          id: 4,
          raw_text: 'new after clear',
        },
      ])
      expect(getState().history.map((entry) => entry.id)).toEqual([4])
    })

    it('keeps a delete failure visible and clears it when retrying', () => {
      const lease = getState().tryStartHistoryMutation('all') ?? -1
      expect(getState().failHistoryMutation(lease, '删除失败')).toBe(true)
      expect(getState().historyMutation).toMatchObject({
        kind: 'all',
        status: 'error',
        leaseId: null,
        error: '删除失败',
      })

      const retryLease = getState().tryStartHistoryMutation('all')
      expect(retryLease).not.toBeNull()
      expect(getState().historyMutation).toMatchObject({
        status: 'running',
        error: null,
      })
    })
  })

  describe('dictionary', () => {
    it('defaults to empty array', () => {
      expect(getState().dictionary).toEqual([])
    })

    it('setDictionary replaces dictionary', () => {
      const entries: DictionaryEntry[] = [{ id: 1, word: 'API', pronunciation: null }]
      getState().setDictionary(entries)
      expect(getState().dictionary).toHaveLength(1)
      expect(getState().dictionary[0].word).toBe('API')
    })
  })
})
