import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import {
  consumeMarkdownAiTask,
  getMarkdownAiTasks,
  type MarkdownAiTaskSnapshot,
} from '../../lib/tauri'

interface MarkdownAiDomain {
  byDraft: Record<string, MarkdownAiTaskSnapshot[]>
  consumedLeaseByKey: Record<string, number>
  localPendingByDraft: Record<string, LocalMarkdownAiPending>
  syncDraft: (draftId: string) => Promise<void>
  accept: (snapshot: MarkdownAiTaskSnapshot) => void
  consume: (snapshot: MarkdownAiTaskSnapshot) => Promise<boolean>
  tryStartLocal: (draftId: string, action: MarkdownAiAction) => number | null
  finishLocal: (draftId: string, token: number) => boolean
  reset: () => void
}

type MarkdownAiAction = MarkdownAiTaskSnapshot['key']['request']['action']

export interface LocalMarkdownAiPending {
  token: number
  action: MarkdownAiAction
}

let eventReady: Promise<void> | null = null
let nextLocalPendingToken = 0

export const useMarkdownAiDomain = create<MarkdownAiDomain>((set) => ({
  byDraft: {},
  consumedLeaseByKey: {},
  localPendingByDraft: {},
  async syncDraft(draftId) {
    await ensureMarkdownAiEvents()
    const snapshots = await getMarkdownAiTasks(draftId)
    set((state) => {
      const merged = mergeSnapshots(state, snapshots)
      return {
        ...merged,
        byDraft: {
          ...merged.byDraft,
          [draftId]: merged.byDraft[draftId] ?? [],
        },
      }
    })
  },
  accept(snapshot) {
    set((state) => mergeSnapshots(state, [snapshot]))
  },
  async consume(snapshot) {
    if (snapshot.outcome.status === 'running') return false
    const consumed =
      snapshot.outcome.leaseId < 0 ||
      (await consumeMarkdownAiTask(snapshot.key, snapshot.outcome.leaseId))
    if (!consumed) return false
    set((state) => {
      const identity = keyIdentity(snapshot)
      const current = state.byDraft[snapshot.key.draftId] ?? []
      return {
        consumedLeaseByKey: {
          ...state.consumedLeaseByKey,
          ...(snapshot.outcome.leaseId >= 0
            ? {
                [identity]: Math.max(
                  state.consumedLeaseByKey[identity] ?? 0,
                  snapshot.outcome.leaseId,
                ),
              }
            : {}),
        },
        byDraft: {
          ...state.byDraft,
          [snapshot.key.draftId]: current.filter(
            (item) =>
              keyIdentity(item) !== identity || item.outcome.leaseId !== snapshot.outcome.leaseId,
          ),
        },
      }
    })
    return true
  },
  tryStartLocal(draftId, action) {
    let token: number | null = null
    set((state) => {
      if (state.localPendingByDraft[draftId]) return state
      nextLocalPendingToken += 1
      const nextToken = nextLocalPendingToken
      token = nextToken
      return {
        localPendingByDraft: {
          ...state.localPendingByDraft,
          [draftId]: { token: nextToken, action },
        },
      }
    })
    return token
  },
  finishLocal(draftId, token) {
    let released = false
    set((state) => {
      if (state.localPendingByDraft[draftId]?.token !== token) return state
      const localPendingByDraft = { ...state.localPendingByDraft }
      delete localPendingByDraft[draftId]
      released = true
      return { localPendingByDraft }
    })
    return released
  },
  reset() {
    set({ byDraft: {}, consumedLeaseByKey: {}, localPendingByDraft: {} })
  },
}))

async function ensureMarkdownAiEvents() {
  if (!eventReady) {
    eventReady = listen<MarkdownAiTaskSnapshot>('markdown-ai:updated', (event) => {
      useMarkdownAiDomain.getState().accept(event.payload)
    }).then(() => undefined)
  }
  return eventReady
}

function mergeSnapshots(
  state: Pick<MarkdownAiDomain, 'byDraft' | 'consumedLeaseByKey'>,
  incoming: MarkdownAiTaskSnapshot[],
) {
  const byDraft = { ...state.byDraft }
  for (const snapshot of incoming) {
    const identity = keyIdentity(snapshot)
    const consumedLease = state.consumedLeaseByKey[identity]
    if (consumedLease !== undefined && consumedLease >= snapshot.outcome.leaseId) continue
    const current = byDraft[snapshot.key.draftId] ?? []
    const existing = current.find((item) => keyIdentity(item) === identity)
    if (existing && !shouldReplace(existing, snapshot)) continue
    byDraft[snapshot.key.draftId] = [
      snapshot,
      ...current.filter((item) => keyIdentity(item) !== identity),
    ]
  }
  return { byDraft }
}

function shouldReplace(current: MarkdownAiTaskSnapshot, incoming: MarkdownAiTaskSnapshot) {
  if (incoming.outcome.leaseId !== current.outcome.leaseId) {
    return incoming.outcome.leaseId > current.outcome.leaseId
  }
  return current.outcome.status === 'running' || incoming.outcome.status !== 'running'
}

export function latestMarkdownAiTask(
  tasks: readonly MarkdownAiTaskSnapshot[],
  predicate: (task: MarkdownAiTaskSnapshot) => boolean = () => true,
) {
  let latest: MarkdownAiTaskSnapshot | null = null
  for (const task of tasks) {
    if (!predicate(task)) continue
    if (!latest || task.outcome.leaseId > latest.outcome.leaseId) latest = task
  }
  return latest
}

export function latestRunningMarkdownAiTask(tasks: readonly MarkdownAiTaskSnapshot[]) {
  return latestMarkdownAiTask(tasks, (task) => task.outcome.status === 'running')
}

export function markdownDraftRevision(text: string) {
  return fingerprint(text)
}

export function markdownSemanticFingerprint(title: string, context: string, execution = '') {
  return fingerprint(`${title}\u0000${context}\u0000${execution}`)
}

function fingerprint(text: string) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}-${(hash >>> 0).toString(16)}`
}

function keyIdentity(snapshot: MarkdownAiTaskSnapshot) {
  return JSON.stringify(snapshot.key)
}
