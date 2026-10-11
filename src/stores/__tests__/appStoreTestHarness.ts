import { afterEach, beforeEach, vi } from 'vitest'
import { useAppStore } from '../appStore'

export const availableLocalOcrCapabilities = {
  modelAvailable: true,
  imageAvailable: true,
  pdfAvailable: true,
  routerAvailable: true,
  pipelineAvailable: true,
  issues: [],
}

export function getState() {
  return useAppStore.getState()
}

export function setupAppStoreTestLifecycle() {
  beforeEach(() => {
    // Reset store to initial state
    useAppStore.setState(useAppStore.getInitialState())
  })

  afterEach(() => {
    vi.useRealTimers()
  })
}

export { useAppStore }
