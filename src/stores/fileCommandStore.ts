import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import {
  consumeFileCommandTask,
  getFileCommandTasks,
  type FileCommandOwnerKey,
  type FileCommandSnapshot,
} from '../lib/tauri'

export interface FileCommandSurfaceFeedback {
  resourceId: string
  type: 'success' | 'error'
  message: string
}

export type MarkdownFileCommandFeedback = FileCommandSurfaceFeedback

interface FileCommandDomain {
  tasks: Record<string, FileCommandSnapshot>
  tombstones: Record<string, number>
  markdownFeedback: MarkdownFileCommandFeedback | null
  ocrFeedback: FileCommandSurfaceFeedback | null
  sync: () => Promise<void>
  accept: (snapshot: FileCommandSnapshot) => void
  consume: (snapshot: FileCommandSnapshot) => Promise<'consumed' | 'alreadyConsumed' | 'stale'>
  setMarkdownFeedback: (feedback: MarkdownFileCommandFeedback | null) => void
  setOcrFeedback: (feedback: FileCommandSurfaceFeedback | null) => void
  reset: () => void
}

let eventReady: Promise<void> | null = null

export const useFileCommandDomain = create<FileCommandDomain>((set) => ({
  tasks: {},
  tombstones: {},
  markdownFeedback: null,
  ocrFeedback: null,
  async sync() {
    await ensureEvents()
    const snapshots = await getFileCommandTasks()
    set((state) => merge(state, snapshots))
  },
  accept(snapshot) {
    set((state) => merge(state, [snapshot]))
  },
  async consume(snapshot) {
    if (snapshot.outcome.status === 'running') return 'stale'
    const result = await consumeFileCommandTask(snapshot.key, snapshot.outcome.leaseId)
    if (result === 'stale') return result
    set((state) => {
      const id = identity(snapshot.key)
      const current = state.tasks[id]
      return {
        tasks:
          current?.outcome.leaseId === snapshot.outcome.leaseId
            ? Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id))
            : state.tasks,
        tombstones: {
          ...state.tombstones,
          [id]: Math.max(state.tombstones[id] ?? 0, snapshot.outcome.leaseId),
        },
      }
    })
    return result
  },
  setMarkdownFeedback(markdownFeedback) {
    set({ markdownFeedback })
  },
  setOcrFeedback(ocrFeedback) {
    set({ ocrFeedback })
  },
  reset() {
    set({ tasks: {}, tombstones: {}, markdownFeedback: null, ocrFeedback: null })
  },
}))

async function ensureEvents() {
  if (!eventReady) {
    eventReady = listen<FileCommandSnapshot>('file-command:updated', (event) => {
      useFileCommandDomain.getState().accept(event.payload)
    }).then(() => undefined)
  }
  return eventReady
}

function merge(
  state: Pick<FileCommandDomain, 'tasks' | 'tombstones'>,
  snapshots: FileCommandSnapshot[],
) {
  const tasks = { ...state.tasks }
  for (const snapshot of snapshots) {
    const id = identity(snapshot.key)
    if ((state.tombstones[id] ?? 0) >= snapshot.outcome.leaseId) continue
    const current = tasks[id]
    if (current && !replaces(current, snapshot)) continue
    tasks[id] = snapshot
  }
  return { tasks }
}

function replaces(current: FileCommandSnapshot, incoming: FileCommandSnapshot) {
  if (incoming.outcome.leaseId !== current.outcome.leaseId) {
    return incoming.outcome.leaseId > current.outcome.leaseId
  }
  return current.outcome.status === 'running' && incoming.outcome.status !== 'running'
}

export function fileCommandIdentity(key: FileCommandOwnerKey) {
  return identity(key)
}

function identity(key: FileCommandOwnerKey) {
  return `${key.commandKind}\u0000${key.resourceId}`
}
