export interface SignedOtaUpdateInfo {
  currentVersion: string
  latestVersion: string
  releaseNotes: string | null
  checkedAt: string
}

export interface StartupUpdateInfo extends SignedOtaUpdateInfo {
  noteSummary: string
}

export interface StartupUpdateLoaders {
  checkSignedOtaUpdate(timeoutMs: number): Promise<SignedOtaUpdateInfo | null>
}

export type StartupUpdateResult =
  | { status: 'available'; update: StartupUpdateInfo }
  | { status: 'none' }
  | { status: 'skipped'; reason: 'timeout' | 'unavailable' }

const STARTUP_UPDATE_TIMEOUT = Symbol('startup-update-timeout')
const DEFAULT_STARTUP_UPDATE_TIMEOUT_MS = 3500

export async function checkStartupUpdate(
  loaders: StartupUpdateLoaders,
  options: { timeoutMs?: number } = {},
  warn: (reason: string, error?: unknown) => void = () => undefined,
): Promise<StartupUpdateResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_UPDATE_TIMEOUT_MS

  try {
    const update = await withTimeout(loaders.checkSignedOtaUpdate(timeoutMs), timeoutMs)
    if (update === STARTUP_UPDATE_TIMEOUT) {
      warn('startup_update_timeout')
      return { status: 'skipped', reason: 'timeout' }
    }
    if (!update) return { status: 'none' }

    return {
      status: 'available',
      update: {
        ...update,
        noteSummary: releaseNotesSummary(update.releaseNotes),
      },
    }
  } catch (error) {
    warn('startup_update_unavailable', error)
    return { status: 'skipped', reason: 'unavailable' }
  }
}

export function releaseNotesSummary(notes: string | null, maxLines = 3, maxChars = 220): string {
  const lines = (notes ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, maxLines)

  const summary = lines.join('\n').trim()
  if (!summary) return '这个版本包含稳定性和体验优化。'
  if (summary.length <= maxChars) return summary
  return `${summary.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof STARTUP_UPDATE_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof STARTUP_UPDATE_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(STARTUP_UPDATE_TIMEOUT), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
