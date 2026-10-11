export type StatusTone = 'ok' | 'warn' | 'neutral'
export type ConnectionTestKind = 'stt' | 'llm'
export type ConnectionTestResult = {
  label: string
  tone: StatusTone
  latency: number | null
}
export type ConnectionTestCache = Record<ConnectionTestKind, ConnectionTestResult | null>
export type PendingOtaUpdate = {
  version: string
  status: 'readyToRestart' | 'installing'
  checkedAt: string
  source: 'tauri-updater'
}

const CONNECTION_TEST_STORAGE_KEY = 'echolike.connectionTests'
const PENDING_OTA_STORAGE_KEY = 'echolike.v2.pendingUpdate'

export function loadConnectionTestCache(): ConnectionTestCache {
  if (typeof window === 'undefined') return { stt: null, llm: null }
  try {
    const raw = window.sessionStorage.getItem(CONNECTION_TEST_STORAGE_KEY)
    if (!raw) return { stt: null, llm: null }
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      stt: normalizeConnectionTestResult(parsed.stt),
      llm: normalizeConnectionTestResult(parsed.llm),
    }
  } catch {
    return { stt: null, llm: null }
  }
}

export function saveConnectionTestResult(kind: ConnectionTestKind, result: ConnectionTestResult) {
  if (typeof window === 'undefined') return
  try {
    const current = loadConnectionTestCache()
    window.sessionStorage.setItem(
      CONNECTION_TEST_STORAGE_KEY,
      JSON.stringify({ ...current, [kind]: result }),
    )
  } catch {
    // Session-only cache is best effort; testing still works without it.
  }
}

function normalizeConnectionTestResult(value: unknown): ConnectionTestResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const label = typeof record.label === 'string' ? record.label : ''
  const tone = record.tone
  if (!label || (tone !== 'ok' && tone !== 'warn' && tone !== 'neutral')) return null
  const latency =
    typeof record.latency === 'number' && Number.isFinite(record.latency) ? record.latency : null
  return { label, tone, latency }
}

function numericVersionParts(version: string) {
  return version
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
}

export function compareVersions(left: string, right: string) {
  const leftParts = numericVersionParts(left)
  const rightParts = numericVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function loadPendingOtaUpdate(): PendingOtaUpdate | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PENDING_OTA_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
    const status = parsed.status
    const checkedAt = typeof parsed.checkedAt === 'string' ? parsed.checkedAt : ''
    if (!version || (status !== 'readyToRestart' && status !== 'installing')) return null
    return {
      version,
      status,
      checkedAt: checkedAt || new Date().toISOString(),
      source: 'tauri-updater',
    }
  } catch {
    return null
  }
}

export function savePendingOtaUpdate(pending: PendingOtaUpdate) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(PENDING_OTA_STORAGE_KEY, JSON.stringify(pending))
}

export function clearPendingOtaUpdate() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(PENDING_OTA_STORAGE_KEY)
}
