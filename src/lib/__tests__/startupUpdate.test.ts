import { describe, expect, it, vi, afterEach } from 'vitest'
import { checkStartupUpdate, releaseNotesSummary } from '../startupUpdate'

afterEach(() => {
  vi.useRealTimers()
})

describe('startup update check', () => {
  it('returns an available update with a short notes summary', async () => {
    const result = await checkStartupUpdate({
      checkSignedOtaUpdate: vi.fn().mockResolvedValue({
        currentVersion: '0.1.37',
        latestVersion: '0.1.38',
        releaseNotes: '- Markdown editor rollout.\n- Startup fallback fix.\n- Quota message fix.',
        checkedAt: '2026-07-07T00:00:00.000Z',
      }),
    })

    expect(result).toMatchObject({
      status: 'available',
      update: {
        currentVersion: '0.1.37',
        latestVersion: '0.1.38',
        noteSummary: 'Markdown editor rollout.\nStartup fallback fix.\nQuota message fix.',
      },
    })
  })

  it('treats an unreachable OTA node as a skipped local startup', async () => {
    const warn = vi.fn()
    const error = new Error('network unreachable')

    const result = await checkStartupUpdate(
      {
        checkSignedOtaUpdate: vi.fn().mockRejectedValue(error),
      },
      { timeoutMs: 100 },
      warn,
    )

    expect(result).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(warn).toHaveBeenCalledWith('startup_update_unavailable', error)
  })

  it('times out instead of blocking local-only users', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    const pending = checkStartupUpdate(
      {
        checkSignedOtaUpdate: vi.fn(() => new Promise<never>(() => undefined)),
      },
      { timeoutMs: 100 },
      warn,
    )

    await vi.advanceTimersByTimeAsync(100)

    await expect(pending).resolves.toEqual({ status: 'skipped', reason: 'timeout' })
    expect(warn).toHaveBeenCalledWith('startup_update_timeout')
  })

  it('returns none when the signed updater has no newer version', async () => {
    const result = await checkStartupUpdate({
      checkSignedOtaUpdate: vi.fn().mockResolvedValue(null),
    })

    expect(result).toEqual({ status: 'none' })
  })
})

describe('releaseNotesSummary', () => {
  it('falls back to a readable default when notes are empty', () => {
    expect(releaseNotesSummary(null)).toBe('这个版本包含稳定性和体验优化。')
  })
})
