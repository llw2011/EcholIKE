import type {
  AppState,
  HistoryEntry,
  HistoryMutationKind,
  HistoryMutationState,
} from './appStore.types'

type HistoryState = Pick<
  AppState,
  'history' | 'historyDeletedIds' | 'historyClearedThroughId' | 'historyMutation'
>

type HistoryPatch<Key extends keyof HistoryState> = Pick<HistoryState, Key>

function createIdleHistoryMutation(): HistoryMutationState {
  return {
    kind: null,
    status: 'idle',
    leaseId: null,
    startedAt: null,
    error: null,
  }
}

export function createInitialHistoryState(): HistoryState {
  return {
    history: [],
    historyDeletedIds: [],
    historyClearedThroughId: 0,
    historyMutation: createIdleHistoryMutation(),
  }
}

function visibleHistoryEntries(
  history: HistoryEntry[],
  clearedThroughId: number,
  deletedIds: readonly number[],
) {
  const deleted = new Set(deletedIds)
  return history.filter((entry) => entry.id > clearedThroughId && !deleted.has(entry.id))
}

export function refreshHistoryTransition(
  state: HistoryState,
  history: HistoryEntry[],
): HistoryPatch<'history'> {
  return {
    history: visibleHistoryEntries(history, state.historyClearedThroughId, state.historyDeletedIds),
  }
}

export function startHistoryMutationTransition(
  kind: HistoryMutationKind,
  leaseId: number,
  startedAt: string,
): HistoryPatch<'historyMutation'> {
  return {
    historyMutation: {
      kind,
      status: 'running',
      leaseId,
      startedAt,
      error: null,
    },
  }
}

export function finishHistoryMutationTransition(
  state: HistoryState,
  deletedIds: number[],
  clearedThroughId = 0,
): HistoryState {
  const nextClearedThroughId = Math.max(
    state.historyClearedThroughId,
    Number.isSafeInteger(clearedThroughId) && clearedThroughId > 0 ? clearedThroughId : 0,
  )
  const nextDeletedIds = Array.from(
    new Set([
      ...state.historyDeletedIds,
      ...deletedIds.filter((id) => Number.isSafeInteger(id) && id > 0),
    ]),
  )
    .filter((id) => id > nextClearedThroughId)
    .sort((left, right) => left - right)
  return {
    history: visibleHistoryEntries(state.history, nextClearedThroughId, nextDeletedIds),
    historyDeletedIds: nextDeletedIds,
    historyClearedThroughId: nextClearedThroughId,
    historyMutation: createIdleHistoryMutation(),
  }
}

export function failHistoryMutationTransition(
  mutation: HistoryMutationState,
  error: string,
): HistoryPatch<'historyMutation'> {
  return {
    historyMutation: {
      ...mutation,
      status: 'error',
      leaseId: null,
      startedAt: null,
      error,
    },
  }
}

export function clearHistoryMutationTransition(): HistoryPatch<'historyMutation'> {
  return { historyMutation: createIdleHistoryMutation() }
}
