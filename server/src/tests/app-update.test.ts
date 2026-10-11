import { describe, expect, it, vi } from 'vitest'
import { compareVersions } from '../routes/app-update.js'
import { request, testApp, testEnv, testServices } from './helpers.js'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  createMemoryRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitInput,
} from '../services/rate-limit/rate-limit-service.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
  type OtaReleaseInput,
} from '../services/desktop/desktop-config-service.js'

function updateApp(overrides: Partial<NodeJS.ProcessEnv>) {
  const env = testEnv(overrides)
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({}),
    services: testServices(env),
  })
}

describe('app update route', () => {
  it('defaults to no update', async () => {
    const res = await testApp().fetch(request('/echo-api/app/update?version=0.1.0'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      appName: 'EcholIKE',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      autoUpdate: false,
      updateAvailable: false,
      forceUpdate: false,
      downloadUrl: null,
    })
  })

  it('lets the backend advertise an optional update', async () => {
    const app = updateApp({
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_AUTO_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
      DESKTOP_UPDATE_DOWNLOAD_URL: 'https://example.com/EcholIKE-0.2.0.exe',
      DESKTOP_UPDATE_RELEASE_NOTES: '更好的窗口 OCR。',
    })

    const res = await app.fetch(request('/echo-api/app/update?version=0.1.0&platform=windows'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      latestVersion: '0.2.0',
      autoUpdate: true,
      updateAvailable: true,
      forceUpdate: false,
      downloadUrl: 'https://example.com/EcholIKE-0.2.0.exe',
      releaseNotes: '更好的窗口 OCR。',
    })
  })

  it('lets the backend force an update', async () => {
    const app = updateApp({
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_FORCE: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
      DESKTOP_UPDATE_DOWNLOAD_URL: 'https://example.com/EcholIKE-0.2.0.exe',
    })

    const res = await app.fetch(request('/echo-api/app/update?version=0.1.0'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.forceUpdate).toBe(true)
  })

  it('does not advertise an update without a downloadable artifact', async () => {
    const app = updateApp({
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_FORCE: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
    })

    const res = await app.fetch(request('/echo-api/app/update?version=0.1.0'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      latestVersion: '0.2.0',
      updateAvailable: false,
      forceUpdate: false,
      downloadUrl: null,
      releaseNotes: null,
      message: 'No downloadable update is available.',
    })
  })

  it('keeps latestVersion at the newest matching release for current clients', async () => {
    const env = testEnv({})
    const desktopStore = createMemoryDesktopConfigStore()
    const desktopConfig = createDesktopConfigService(desktopStore, env)
    await seedActiveOtaRelease(desktopStore, {
      appName: 'EcholIKE',
      version: '0.1.0',
      channel: 'stable',
      platform: 'all',
      arch: 'all',
      enabled: true,
      autoUpdate: false,
      forceUpdate: false,
    })
    await seedActiveOtaRelease(desktopStore, {
      appName: 'EcholIKE',
      version: '0.1.1',
      channel: 'stable',
      platform: 'windows',
      arch: 'all',
      enabled: true,
      autoUpdate: false,
      forceUpdate: false,
      downloadUrl: 'https://example.com/EcholIKE-0.1.1.exe',
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...testServices(env),
        desktopConfig,
      },
    })

    const res = await app.fetch(request('/echo-api/app/update?version=0.1.1&platform=windows'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      latestVersion: '0.1.1',
      updateAvailable: false,
      downloadUrl: null,
      message: 'You are on the latest version.',
    })
  })

  it('returns a Tauri updater manifest for signed releases', async () => {
    const env = testEnv({})
    const desktopStore = createMemoryDesktopConfigStore()
    const desktopConfig = createDesktopConfigService(desktopStore, env)
    await seedActiveOtaRelease(desktopStore, {
      appName: 'EcholIKE',
      version: '0.2.0',
      channel: 'stable',
      platform: 'all',
      arch: 'all',
      enabled: true,
      autoUpdate: false,
      forceUpdate: false,
      downloadUrl: 'https://example.com/EcholIKE_0.2.0_x64-setup.exe',
      signature: 'signed-release',
      releaseNotes: 'Signed updater package',
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...testServices(env),
        desktopConfig,
      },
    })

    const res = await app.fetch(
      request('/echo-api/app/update/tauri?version=0.1.0&platform=windows&arch=x86_64'),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      version: '0.2.0',
      notes: 'Signed updater package',
      platforms: {
        'windows-x86_64': {
          signature: 'signed-release',
          url: 'https://example.com/EcholIKE_0.2.0_x64-setup.exe',
        },
      },
    })
  })

  it('normalizes Tauri updater target variants to a signed Windows release', async () => {
    const env = testEnv({})
    const desktopStore = createMemoryDesktopConfigStore()
    const desktopConfig = createDesktopConfigService(desktopStore, env)
    await seedActiveOtaRelease(desktopStore, {
      appName: 'EcholIKE',
      version: '0.2.0',
      channel: 'stable',
      platform: 'windows',
      arch: 'all',
      enabled: true,
      autoUpdate: false,
      forceUpdate: false,
      downloadUrl: 'https://example.com/EcholIKE_0.2.0_x64-setup.exe',
      signature: 'signed-release',
      releaseNotes: 'Signed updater package',
    })
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...testServices(env),
        desktopConfig,
      },
    })

    for (const query of [
      '/echo-api/app/update/tauri?version=0.1.0&platform=windows-x86_64&arch=x86_64',
      '/echo-api/app/update/tauri?version=0.1.0&platform=x86_64-pc-windows-msvc&arch=x86_64',
    ]) {
      const res = await app.fetch(request(query))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.platforms).toHaveProperty('windows-x86_64')
      expect(body.platforms['windows-x86_64'].signature).toBe('signed-release')
    }
  })

  it('does not expose unsigned releases to the Tauri updater', async () => {
    const app = updateApp({
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.2.0',
      DESKTOP_UPDATE_DOWNLOAD_URL: 'https://example.com/EcholIKE_0.2.0_x64-setup.exe',
    })

    const res = await app.fetch(
      request('/echo-api/app/update/tauri?version=0.1.0&platform=windows&arch=x86_64'),
    )

    expect(res.status).toBe(204)
  })

  it('uses one route-specific IP policy without caching OTA resolution', async () => {
    const env = testEnv({})
    const services = testServices(env)
    const rateLimit = new RecordingRateLimiter()
    const resolveOtaPolicy = vi.spyOn(services.desktopConfig, 'resolveOtaPolicy')
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...services,
        rateLimit,
      },
    })
    const updatePath =
      '/echo-api/app/update?version=0.1.0&platform=windows&arch=x86_64&channel=stable'
    const tauriPath = updatePath.replace('/app/update?', '/app/update/tauri?')
    const headers = {
      'x-real-ip': '203.0.113.10',
      'x-forwarded-for': '198.51.100.250, 203.0.113.10',
    }

    const first = await app.fetch(request(updatePath, { headers }))
    const second = await app.fetch(request(updatePath, { headers }))
    const tauri = await app.fetch(request(tauriPath, { headers }))
    const health = await app.fetch(request('/echo-api/healthz', { headers }))
    const ready = await app.fetch(request('/echo-api/readyz', { headers }))

    expect([first.status, second.status, tauri.status]).toEqual([200, 200, 204])
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(tauri.headers.get('cache-control')).toBe('no-store')
    expect(resolveOtaPolicy).toHaveBeenCalledTimes(3)
    expect(resolveOtaPolicy).toHaveBeenNthCalledWith(1, {
      currentVersion: '0.1.0',
      channel: 'stable',
      platform: 'windows',
      arch: 'x86_64',
    })
    expect(rateLimit.inputs).toHaveLength(3)
    for (const input of rateLimit.inputs) {
      expect(input).toEqual({
        identity: 'ip:203.0.113.10',
        rule: { name: 'ota-update:ip', limit: 60, windowSeconds: 60 },
      })
    }
    expect([health.status, ready.status]).toEqual([200, 200])
    expect(rateLimit.inputs).toHaveLength(3)
  })

  it('shares the OTA limit across both update endpoints for one IP', async () => {
    const env = testEnv({})
    const services = testServices(env)
    const resolveOtaPolicy = vi.spyOn(services.desktopConfig, 'resolveOtaPolicy')
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...services,
        rateLimit: createMemoryRateLimiter(() => 1_000),
      },
    })
    const headers = (spoofedIp: string) => ({
      'x-real-ip': '203.0.113.20',
      'x-forwarded-for': `${spoofedIp}, 203.0.113.20`,
    })

    for (let requestNumber = 0; requestNumber < 59; requestNumber += 1) {
      const response = await app.fetch(
        request('/echo-api/app/update?version=0.1.0', {
          headers: headers(`198.51.100.${requestNumber + 1}`),
        }),
      )
      expect(response.status).toBe(200)
    }
    const sixtieth = await app.fetch(
      request('/echo-api/app/update/tauri?version=0.1.0&platform=windows&arch=x86_64', {
        headers: headers('198.51.100.200'),
      }),
    )
    const blocked = await app.fetch(
      request('/echo-api/app/update/tauri?version=0.1.0&platform=windows&arch=x86_64', {
        headers: headers('198.51.100.201'),
      }),
    )

    expect(sixtieth.status).toBe(204)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('60')
    await expect(blocked.json()).resolves.toMatchObject({
      code: 'rate_limited',
      error: 'Rate limit exceeded',
      requestId: expect.any(String),
    })
    expect(resolveOtaPolicy).toHaveBeenCalledTimes(60)
  })

  it('isolates OTA rate-limit windows by client IP', async () => {
    const env = testEnv({})
    const services = testServices(env)
    const app = createApp({
      env,
      sessionVerifier: createStaticSessionVerifier({}),
      services: {
        ...services,
        rateLimit: createMemoryRateLimiter(() => 1_000),
      },
    })
    const firstIpHeaders = { 'x-forwarded-for': '203.0.113.30' }
    const secondIpHeaders = { 'x-forwarded-for': '203.0.113.31' }

    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      const response = await app.fetch(
        request('/echo-api/app/update?version=0.1.0', { headers: firstIpHeaders }),
      )
      expect(response.status).toBe(200)
    }

    const firstIpBlocked = await app.fetch(
      request('/echo-api/app/update?version=0.1.0', { headers: firstIpHeaders }),
    )
    const secondIpAllowed = await app.fetch(
      request('/echo-api/app/update?version=0.1.0', { headers: secondIpHeaders }),
    )

    expect(firstIpBlocked.status).toBe(429)
    expect(secondIpAllowed.status).toBe(200)
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.10.0', '0.2.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
  })
})

class RecordingRateLimiter implements RateLimiter {
  readonly inputs: RateLimitInput[] = []

  async check(input: RateLimitInput): Promise<RateLimitDecision> {
    this.inputs.push(input)
    return {
      allowed: true,
      retryAfterSeconds: 60,
      remaining: 59,
    }
  }
}

async function seedActiveOtaRelease(
  store: ReturnType<typeof createMemoryDesktopConfigStore>,
  input: OtaReleaseInput,
): Promise<void> {
  const draft = await store.upsertOtaRelease({
    ...input,
    enabled: false,
    forceUpdate: false,
    artifactBytes: input.artifactBytes ?? 1,
    downloadUrl: input.downloadUrl ?? `https://example.com/EcholIKE_${input.version}_x64-setup.exe`,
    sha256: input.sha256 ?? 'a'.repeat(64),
    signature: input.signature ?? 'signed-release',
  })
  if (!draft) throw new Error('OTA fixture draft was not saved')
  const activated = await store.setOtaReleaseActivation({
    id: draft.id,
    expectedRevision: draft.revision,
    enabled: true,
    forceUpdate: input.forceUpdate,
  })
  if (!activated) throw new Error('OTA fixture draft was not activated')
}
