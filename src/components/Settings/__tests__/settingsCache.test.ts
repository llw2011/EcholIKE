import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPendingOtaUpdate,
  compareVersions,
  loadConnectionTestCache,
  loadPendingOtaUpdate,
  saveConnectionTestResult,
  savePendingOtaUpdate,
  type PendingOtaUpdate,
} from '../settingsCache'

const CONNECTION_TEST_STORAGE_KEY = 'echolike.connectionTests'
const PENDING_OTA_STORAGE_KEY = 'echolike.v2.pendingUpdate'

describe('settings cache domain', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.useRealTimers()
  })

  it('returns an empty connection cache when storage has no value', () => {
    expect(loadConnectionTestCache()).toEqual({ stt: null, llm: null })
  })

  it('normalizes connection test entries and discards invalid values', () => {
    window.sessionStorage.setItem(
      CONNECTION_TEST_STORAGE_KEY,
      JSON.stringify({
        stt: { label: '最近测试 123ms', tone: 'ok', latency: 123 },
        llm: { label: 'broken tone', tone: 'error', latency: Number.POSITIVE_INFINITY },
      }),
    )

    expect(loadConnectionTestCache()).toEqual({
      stt: { label: '最近测试 123ms', tone: 'ok', latency: 123 },
      llm: null,
    })
  })

  it('falls back to an empty connection cache for malformed JSON', () => {
    window.sessionStorage.setItem(CONNECTION_TEST_STORAGE_KEY, '{')
    expect(loadConnectionTestCache()).toEqual({ stt: null, llm: null })
  })

  it('merges connection test results into the session cache', () => {
    saveConnectionTestResult('stt', { label: 'STT 20ms', tone: 'ok', latency: 20 })
    saveConnectionTestResult('llm', { label: 'LLM failed', tone: 'warn', latency: null })

    expect(JSON.parse(window.sessionStorage.getItem(CONNECTION_TEST_STORAGE_KEY) ?? '{}')).toEqual({
      stt: { label: 'STT 20ms', tone: 'ok', latency: 20 },
      llm: { label: 'LLM failed', tone: 'warn', latency: null },
    })
  })

  it('compares numeric version components with missing parts treated as zero', () => {
    expect(compareVersions('v0.2.30', '0.2.29')).toBe(1)
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.9-beta.1', '0.2.10')).toBe(-1)
  })

  it('loads a valid pending OTA update and normalizes its persisted fields', () => {
    window.localStorage.setItem(
      PENDING_OTA_STORAGE_KEY,
      JSON.stringify({
        version: ' 0.2.31 ',
        status: 'readyToRestart',
        checkedAt: '2026-08-28T00:00:00.000Z',
        source: 'untrusted-value',
      }),
    )

    expect(loadPendingOtaUpdate()).toEqual({
      version: '0.2.31',
      status: 'readyToRestart',
      checkedAt: '2026-08-28T00:00:00.000Z',
      source: 'tauri-updater',
    })
  })

  it('fills a missing pending-update timestamp with the current time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T01:02:03.000Z'))
    window.localStorage.setItem(
      PENDING_OTA_STORAGE_KEY,
      JSON.stringify({ version: '0.2.31', status: 'installing' }),
    )

    expect(loadPendingOtaUpdate()).toEqual({
      version: '0.2.31',
      status: 'installing',
      checkedAt: '2026-08-28T01:02:03.000Z',
      source: 'tauri-updater',
    })
  })

  it('rejects malformed or incomplete pending OTA entries', () => {
    window.localStorage.setItem(PENDING_OTA_STORAGE_KEY, '{')
    expect(loadPendingOtaUpdate()).toBeNull()

    window.localStorage.setItem(
      PENDING_OTA_STORAGE_KEY,
      JSON.stringify({ version: '', status: 'readyToRestart' }),
    )
    expect(loadPendingOtaUpdate()).toBeNull()

    window.localStorage.setItem(
      PENDING_OTA_STORAGE_KEY,
      JSON.stringify({ version: '0.2.31', status: 'downloaded' }),
    )
    expect(loadPendingOtaUpdate()).toBeNull()
  })

  it('saves and clears the exact pending OTA envelope', () => {
    const pending: PendingOtaUpdate = {
      version: '0.2.31',
      status: 'readyToRestart',
      checkedAt: '2026-08-28T00:00:00.000Z',
      source: 'tauri-updater',
    }

    savePendingOtaUpdate(pending)
    expect(JSON.parse(window.localStorage.getItem(PENDING_OTA_STORAGE_KEY) ?? '{}')).toEqual(
      pending,
    )

    clearPendingOtaUpdate()
    expect(window.localStorage.getItem(PENDING_OTA_STORAGE_KEY)).toBeNull()
  })
})
