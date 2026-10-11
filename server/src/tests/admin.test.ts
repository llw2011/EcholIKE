import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyPassword } from 'better-auth/crypto'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import {
  createAdminService,
  createMemoryAdminStore,
  type AdminStore,
} from '../services/admin/admin-service.js'
import {
  createDesktopConfigService,
  createMemoryDesktopConfigStore,
  type DesktopConfigService,
  type OtaReleaseStoredRecord,
} from '../services/desktop/desktop-config-service.js'
import type { OtaArtifactValidationResult } from '../services/desktop/ota-artifact-validator.js'
import { createAuditService, createMemoryAuditLogStore } from '../services/audit/audit-service.js'
import { freeUser, proUser, request, testEnv, testServices } from './helpers.js'
import type { AuthenticatedUser } from '../types.js'
import type { ProxyServices } from '../services/proxy/proxy-services.js'
import type { ProviderControlService } from '../services/security/provider-control-service.js'
import { ApiError } from '../errors.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const activeAdminUser: AuthenticatedUser = {
  id: 'user_admin',
  email: 'admin@example.com',
  name: 'Admin',
  plan: 'pro',
  subscriptionEnd: null,
}

const disabledAdminUser: AuthenticatedUser = {
  id: 'user_disabled_admin',
  email: 'disabled@example.com',
  name: 'Disabled Admin',
  plan: 'pro',
  subscriptionEnd: null,
}

describe('admin control panel API', () => {
  it('fails closed when a request is unauthenticated', async () => {
    const app = adminTestApp()
    const res = await app.fetch(request('/echo-api/admin/summary'))
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.code).toBe('unauthorized')
  })

  it('rejects authenticated non-admin users', async () => {
    const app = adminTestApp()
    const res = await app.fetch(
      request('/echo-api/admin/summary', {
        headers: { authorization: 'Bearer valid-free-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('forbidden')
  })

  it('rejects disabled admin accounts', async () => {
    const app = adminTestApp()
    const res = await app.fetch(
      request('/echo-api/admin/summary', {
        headers: { authorization: 'Bearer valid-disabled-admin-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('forbidden')
  })

  it('allows active admin accounts and records audit metadata', async () => {
    const auditStore = createMemoryAuditLogStore()
    const app = adminTestApp({ auditStore })
    const res = await app.fetch(
      request('/echo-api/admin/summary', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.admin).toMatchObject({ userId: 'user_admin', role: 'owner' })
    expect(body.overview).toMatchObject({
      userCount: 3,
      adminCount: 2,
      activeAdminCount: 1,
    })
    expect(auditStore.entries[0]).toMatchObject({
      userId: 'user_admin',
      action: 'GET /echo-api/admin/summary',
      metadata: {
        path: '/echo-api/admin/summary',
        access: 'admin',
        status: 200,
      },
    })
  })

  it('redacts secrets from admin system status', async () => {
    const env = testEnv({
      DATABASE_URL: 'postgres://echo:test-db-password@localhost:5432/echo',
      BETTER_AUTH_SECRET: 'test-auth-value',
      LLM_API_KEY: 'test-llm-key',
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-test',
      STT_API_KEY: 'test-stt-key',
      STT_PROVIDER: 'openai',
      STRIPE_SECRET_KEY: 'test-stripe-key',
      STRIPE_WEBHOOK_SECRET: 'test-webhook-key',
      STRIPE_PRO_PRICE_ID: 'price_test',
    })
    const app = adminTestApp({ env })

    const res = await app.fetch(
      request('/echo-api/admin/system', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()
    const serialized = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.dependencies).toMatchObject({
      authSecret: 'set',
      llmProxy: 'set',
      sttProxy: 'set',
      stripe: 'set',
    })
    for (const secret of [
      'test-db-password',
      'test-auth-value',
      'test-llm-key',
      'test-stt-key',
      'test-stripe-key',
      'test-webhook-key',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('postgres://')
  })

  it('shows the same highest-priority provider that runtime routing resolves', async () => {
    const store = createMemoryDesktopConfigStore()
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(store, env)
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openrouter',
      displayName: 'Primary OpenRouter',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: 'primary-secret',
      defaultModel: 'primary-model',
      priority: 100,
    })
    await desktopConfig.upsertProvider({
      kind: 'llm',
      providerId: 'openai-compatible',
      displayName: 'Fallback compatible',
      enabled: true,
      mode: 'proxy',
      endpoint: 'https://fallback.example/v1',
      apiKey: 'fallback-secret',
      defaultModel: 'fallback-model',
      priority: 0,
    })
    const app = adminTestApp({ env, desktopConfig })

    const response = await app.fetch(
      request('/echo-api/admin/proxy-status', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      llm: { configured: true, provider: 'openrouter', model: 'primary-model' },
    })
  })

  it('previews desktop policy without returning full provider keys', async () => {
    const env = testEnv({
      LLM_PROVIDER: 'openrouter',
      LLM_API_KEY: 'test-admin-preview-key',
      LLM_MODEL: 'google/gemini-2.5-flash',
      STT_PROVIDER: 'glm-asr',
      STT_API_KEY: 'stt-live-admin-preview-key',
    })
    const desktopConfig = createDesktopConfigService(createMemoryDesktopConfigStore(), env)
    await desktopConfig.upsertDesktopPolicy({
      channel: 'stable',
      platform: 'all',
      plan: 'all',
      features: {
        translate: false,
        apiKey: 'desktop-policy-feature-secret',
        nested: { endpoint: 'https://feature-policy.example/private' },
      },
      services: {
        llm: {
          mode: 'disabled',
          defaultModel: 'desktop-policy-model-secret',
          capabilities: { apiKey: 'desktop-policy-capability-secret' },
        },
        privateService: { endpoint: 'https://private-service.example/secret' },
      },
      policy: {
        allowByok: false,
        backgroundPolling: true,
        apiKey: 'desktop-policy-runtime-secret',
        nested: { endpoint: 'https://runtime-policy.example/private' },
      },
      enabled: true,
    })
    const app = adminTestApp({ env, desktopConfig })

    const res = await app.fetch(
      request('/echo-api/admin/desktop-policy', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()
    const serialized = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.bootstrapPreview.services.llm.mode).toBe('disabled')
    expect(body.bootstrapPreview.services.llm.apiKey).toBeNull()
    expect(body.bootstrapPreview.services.llm.apiKeyPreview).toBe('configured')
    expect(body.policies[0].features).toEqual({ translate: false })
    expect(body.policies[0].services).toEqual({ llm: { mode: 'disabled' } })
    expect(body.policies[0].policy).toEqual({ allowByok: false })
    expect(serialized).not.toContain('test-admin-preview-key')
    expect(serialized).not.toContain('stt-live-admin-preview-key')
    expect(serialized).not.toContain('desktop-policy-feature-secret')
    expect(serialized).not.toContain('desktop-policy-model-secret')
    expect(serialized).not.toContain('desktop-policy-capability-secret')
    expect(serialized).not.toContain('desktop-policy-runtime-secret')
    expect(serialized).not.toContain('private-service.example')
    expect(serialized).not.toContain('feature-policy.example')
    expect(serialized).not.toContain('runtime-policy.example')
  })

  it('resolves the admin OTA summary from published releases instead of stale env defaults', async () => {
    const env = testEnv({
      DESKTOP_UPDATE_ENABLED: 'true',
      DESKTOP_UPDATE_LATEST_VERSION: '0.1.44',
    })
    const desktopStore = createMemoryDesktopConfigStore()
    const desktopConfig = createValidatedOtaService(desktopStore, env)
    const draft = await desktopConfig.upsertOtaRelease({
      appName: 'EcholIKE',
      version: '0.1.47',
      channel: 'stable',
      platform: 'windows',
      arch: 'x86_64',
      enabled: false,
      autoUpdate: true,
      forceUpdate: false,
      artifactBytes: 4_832_676,
      downloadUrl: 'https://example.com/private/EcholIKE_0.1.47_x64-setup.exe',
      sha256: 'a'.repeat(64),
      signature: 'signed-release',
      releaseNotes: 'Published release wins',
    })
    await desktopConfig.activateOtaRelease({
      id: draft.id,
      expectedRevision: draft.revision,
      forceUpdate: false,
    })
    const app = adminTestApp({ env, desktopConfig })

    const res = await app.fetch(
      request('/echo-api/admin/desktop-policy?version=0.1.44', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()
    const serialized = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.ota).toMatchObject({
      enabled: true,
      autoUpdate: true,
      latestVersion: '0.1.47',
      updateAvailable: true,
      force: false,
      downloadUrl: 'set',
      sha256: 'set',
      signature: 'set',
    })
    expect(body.bootstrapPreview.ota).toMatchObject({
      latestVersion: '0.1.47',
      updateAvailable: true,
      downloadAvailable: true,
    })
    expect(serialized).not.toContain('private/EcholIKE')
  })

  it('serves the panel login page publicly but protects the dashboard', async () => {
    const app = adminTestApp()

    const login = await app.fetch(request('/echo-panel/login'))
    const anonymousDashboard = await app.fetch(request('/echo-panel/'))
    const adminDashboard = await app.fetch(
      request('/echo-panel/', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const dashboardHtml = await adminDashboard.text()

    expect(login.status).toBe(200)
    expect(await login.text()).toContain('/auth/sign-in/email')
    expect(anonymousDashboard.status).toBe(302)
    expect(anonymousDashboard.headers.get('location')).toBe('/echo-panel/login')
    expect(adminDashboard.status).toBe(200)
    expect(dashboardHtml).toContain('管理台')
    expect(dashboardHtml).toContain('用户与额度')
    expect(dashboardHtml).toContain('id="create-user-form"')
    expect(dashboardHtml).toContain('创建用户')
    expect(dashboardHtml).toContain('保存角色')
    expect(dashboardHtml).toContain('id="quota-level-form"')
    expect(dashboardHtml).toContain('/admin/user-quota-levels')
    expect(dashboardHtml).toContain('增加可用额度')
    expect(dashboardHtml).toContain('增减额度填正数')
    expect(dashboardHtml).toContain('语音 已用 / 剩余')
    expect(dashboardHtml).toContain('id="user-search-form"')
    expect(dashboardHtml).toContain('maxlength="120"')
    expect(dashboardHtml).toContain('id="users-cards"')
    expect(dashboardHtml).toContain('id="selected-user"')
    expect(dashboardHtml).toContain('id="change-password-form"')
    expect(dashboardHtml).toContain('id="reset-password-form"')
    expect(dashboardHtml).toContain('/auth/change-password')
    expect(dashboardHtml).toContain('revokeOtherSessions: true')
    expect(dashboardHtml).not.toContain('set-auth-token')
    expect(dashboardHtml).not.toContain('Authorization')
    expect(dashboardHtml).toContain("credentials: 'include'")
    expect(dashboardHtml).toContain('userCursorStack')
    expect(dashboardHtml).toContain('.user-table-wrap { display: none; }')
    expect(dashboardHtml).not.toMatch(/<select[^>]+name="userId"/)
    expect(dashboardHtml).toContain('保存场景')
    expect(dashboardHtml).toContain('id="scene-new"')
    expect(dashboardHtml).toContain('selectedSceneId')
    expect(dashboardHtml).toContain('data-scene-id')
    expect(dashboardHtml).toContain('aria-selected')
    expect(dashboardHtml).toContain("named(form, 'description').value = scene.description")
    expect(dashboardHtml).toContain("named(form, 'promptTemplate').value = scene.promptTemplate")
    expect(dashboardHtml).toContain(
      "named(form, 'dictionaryTerms').value = serializeDictionaryTerms(scene.dictionaryTerms)",
    )
    expect(dashboardHtml).toContain("named(form, 'enabled').checked = Boolean(scene.enabled)")
    expect(dashboardHtml).toContain("named(form, 'isPro').checked = Boolean(scene.isPro)")
    expect(dashboardHtml).toContain("term.word + (term.pronunciation ? '|' + term.pronunciation")
    expect(dashboardHtml).toContain('发布新版本')
    expect(dashboardHtml).toContain('发布新版本')
    expect(dashboardHtml).toContain('保存停用草稿')
    expect(dashboardHtml).toContain('expandedOta')
    expect(dashboardHtml).toContain('data-ota-toggle')
    expect(dashboardHtml).toContain('ota-detail-row')
    expect(dashboardHtml).toContain('系统内部状态')
    expect(dashboardHtml).toContain('一键全链路体检')
    expect(dashboardHtml).not.toContain('鎺')
    expect(dashboardHtml).not.toContain('�')
  })

  it('keeps release history and user operation cards compact and responsive', async () => {
    const app = adminTestApp()
    const response = await app.fetch(
      request('/echo-panel/', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const dashboardHtml = await response.text()

    expect(response.status).toBe(200)
    expect(dashboardHtml).toContain('class="compact-form ota-form"')
    expect(dashboardHtml).toContain('class="ota-form-wide"')
    expect(dashboardHtml).toContain('class="ota-form-actions"')
    expect(dashboardHtml).toContain('<details class="ota-history">')
    expect(dashboardHtml).toContain('id="ota-history-meta"')
    expect(dashboardHtml).toContain('id="ota-prev"')
    expect(dashboardHtml).toContain('id="ota-next"')
    expect(dashboardHtml).toContain('role="region" aria-label="已有版本" tabindex="0"')
    expect(dashboardHtml).toContain('otaPageSize: 5')
    expect(dashboardHtml).toContain(
      'state.otaReleases.slice(pageStart, pageStart + state.otaPageSize)',
    )
    expect(dashboardHtml).toContain('state.expandedOta.clear();')
    expect(dashboardHtml).toContain('restoreFocusTarget(focusTarget, restored);')
    expect(dashboardHtml).toContain('保存动作永远不会启用版本')
    expect(dashboardHtml).toContain('已保存为停用草稿。')
    expect(dashboardHtml).not.toContain("showJson($('#ota-result')")

    for (const name of [
      'version',
      'signature',
      'downloadUrl',
      'releaseNotes',
      'enabled',
      'forceUpdate',
      'channel',
      'platform',
      'arch',
      'autoUpdate',
      'minVersion',
      'sha256',
    ]) {
      expect(dashboardHtml).toContain(`name="${name}"`)
    }

    expect(dashboardHtml).toContain('color-scheme: dark;')
    expect(dashboardHtml).toContain('::-webkit-scrollbar-thumb')
    expect(dashboardHtml).toContain('::-webkit-scrollbar-button')
    expect(dashboardHtml).toContain('::-webkit-scrollbar-corner')
    expect(dashboardHtml).toContain('accent-color: var(--green);')
    expect(dashboardHtml).toContain('align-items: stretch;')
    expect(dashboardHtml).toContain('.operation-card > .compact-form')
    expect(dashboardHtml).toContain('.operation-card > .compact-form > button[type="submit"]')
    expect(dashboardHtml).toContain('.ota-form { grid-template-columns: 1fr; }')
    expect(dashboardHtml).toContain(
      '.account-actions-grid, .user-operation-grid { grid-template-columns: 1fr; align-items: start; }',
    )
    expect(dashboardHtml).toContain('新建后，可在下方调整额度与用户权限。')
    expect(dashboardHtml).toContain('修改密码后，其他设备上的登录会话将退出。')
    expect(dashboardHtml).toContain('放大当前套餐月额度，不改变 free / pro 权限。')
    expect(dashboardHtml).toContain('设置后台访问权限；禁用后将无法进入管理台。')
    expect(dashboardHtml).toContain('增减额度填正数；“直接写账本”仅用于历史纠错。')
    expect(dashboardHtml).toContain('重置后，该用户全部登录会话失效。')
  })

  it('renders the API calls used by panel controls', async () => {
    const app = adminTestApp()
    const adminDashboard = await app.fetch(
      request('/echo-panel/', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const dashboardHtml = await adminDashboard.text()

    for (const path of [
      '/admin/users',
      '/admin/admin-accounts',
      '/admin/user-passwords',
      '/admin/user-quota-levels',
      '/admin/quota-adjustments',
      '/admin/scenes',
      '/subscription/status',
      '/admin/desktop-policy',
      '/admin/providers',
      '/admin/provider-models',
      '/admin/ota-releases',
      '/admin/checkup/llm',
      '/healthz',
      '/readyz',
    ]) {
      expect(dashboardHtml, path).toContain(path)
    }
    expect(dashboardHtml).toContain('providerPresets')
    expect(dashboardHtml).toContain('openrouter')
    expect(dashboardHtml).toContain('glm-asr')
    expect(dashboardHtml).toContain('sensevoice-local')
    expect(dashboardHtml).toContain('cosyvoice2-local')
    expect(dashboardHtml).toContain('ollama-ocr-local')
    expect(dashboardHtml).toContain('name="endpoint"')
    expect(dashboardHtml).toContain('id="provider-read-models"')
    expect(dashboardHtml).toContain('id="provider-capability-fields"')
    expect(dashboardHtml).not.toContain('name="capabilitiesText"')
    expect(dashboardHtml).toContain('data-lpignore')
    expect(dashboardHtml.indexOf('name="endpoint"')).toBeLessThan(
      dashboardHtml.indexOf('name="defaultModel"'),
    )
  })

  it('serves dashboard scripts without syntax errors', async () => {
    const app = adminTestApp()
    const adminDashboard = await app.fetch(
      request('/echo-panel/', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const dashboardHtml = await adminDashboard.text()
    const scripts = [...dashboardHtml.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(
      (match) => match[1] ?? '',
    )

    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow()
    }
  })

  it('runs LLM checkup through an admin-scoped diagnostic route', async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: 'pong', usageTokens: 1 })
    const proxy: ProxyServices = {
      ...testServices(testEnv()).proxy,
      llm: {
        complete: llmComplete,
        stream: vi.fn(),
      },
    }
    const app = adminTestApp({ proxy })

    const res = await app.fetch(
      request('/echo-api/admin/checkup/llm', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, usageTokens: 1 })
    expect(llmComplete).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'ping' }],
    })
  })

  it('creates email/password users through the control API', async () => {
    const adminStore = createAdminStoreFixture()
    const auditStore = createMemoryAuditLogStore()
    const app = adminTestApp({ adminStore, auditStore })

    const res = await app.fetch(
      request('/echo-api/admin/users', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: 'New.User@Example.COM',
          name: 'New User',
          password: 'correct-horse-42',
          emailVerified: true,
        }),
      }),
    )
    const body = await res.json()
    const credential = adminStore.userCredentials.get(body.user.id)

    expect(res.status).toBe(200)
    expect(body.user).toMatchObject({
      email: 'new.user@example.com',
      name: 'New User',
      emailVerified: true,
      adminRole: null,
    })
    expect(JSON.stringify(body)).not.toContain('correct-horse-42')
    expect(credential).toMatchObject({
      providerId: 'credential',
      providerAccountId: body.user.id,
    })
    expect(credential?.passwordHash).not.toBe('correct-horse-42')
    await expect(
      verifyPassword({ hash: credential?.passwordHash ?? '', password: 'correct-horse-42' }),
    ).resolves.toBe(true)
    expect(adminStore.controlAudits.some((entry) => entry.action === 'admin.user.create')).toBe(
      true,
    )
  })

  it('rejects duplicate control-panel user creation', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/users', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: freeUser.email.toUpperCase(),
          password: 'correct-horse-42',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe('user_already_exists')
  })

  it('returns plan limits with admin users so the panel can show remaining quota', async () => {
    const app = adminTestApp()

    const res = await app.fetch(
      request('/echo-api/admin/users?periodKey=2026-06', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.periodKey).toBe('2026-06')
    expect(body.planLimits.free).toEqual(expect.objectContaining({ sttSecondsLimit: 900 }))
    expect(body.planLimits.pro).toEqual(expect.objectContaining({ llmTokensLimit: 5_000_000 }))
    expect(body.quotaLevels).toContainEqual(
      expect.objectContaining({ quotaLevel: 3, quotaMultiplier: 3, label: 'Lv.3' }),
    )
    expect(body.users.length).toBeGreaterThan(0)
    expect(body.users[0]).toEqual(expect.objectContaining({ quotaLevel: 1, quotaMultiplier: 1 }))
  })

  it('searches and cursor-paginates users without repeating rows', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.users.clear()
    for (let index = 1; index <= 5; index += 1) {
      const user = adminUserRecord(index)
      if (index >= 4) {
        user.createdAt = new Date(Date.UTC(2026, 0, 4)).toISOString()
        user.updatedAt = user.createdAt
      }
      adminStore.users.set(user.id, user)
    }
    const app = adminTestApp({ adminStore })

    const first = await app.fetch(
      request('/echo-api/admin/users?periodKey=2026-06&limit=2', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const firstBody = await first.json()
    const second = await app.fetch(
      request(
        '/echo-api/admin/users?periodKey=2026-06&limit=2&cursor=' +
          encodeURIComponent(firstBody.nextCursor),
        { headers: { authorization: 'Bearer valid-admin-token' } },
      ),
    )
    const secondBody = await second.json()
    const searched = await app.fetch(
      request('/echo-api/admin/users?periodKey=2026-06&q=Person%203&limit=25', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const searchedBody = await searched.json()
    const searchedById = await app.fetch(
      request('/echo-api/admin/users?periodKey=2026-06&q=user_person_4&limit=25', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const searchedByIdBody = await searchedById.json()

    expect(first.status).toBe(200)
    expect(firstBody).toMatchObject({ total: 5, limit: 2, query: null })
    expect(firstBody.users).toHaveLength(2)
    expect(firstBody.users.map((user: { id: string }) => user.id)).toEqual([
      'user_person_5',
      'user_person_4',
    ])
    expect(firstBody.nextCursor).toEqual(expect.any(String))
    expect(second.status).toBe(200)
    expect(secondBody.total).toBe(5)
    expect(secondBody.users).toHaveLength(2)
    const firstTwoPages = [...firstBody.users, ...secondBody.users].map(
      (user: { id: string }) => user.id,
    )
    expect(new Set(firstTwoPages).size).toBe(4)
    expect(searched.status).toBe(200)
    expect(searchedBody).toMatchObject({ total: 1, query: 'Person 3' })
    expect(searchedBody.users).toHaveLength(1)
    expect(searchedBody.users[0].email).toBe('person-3@example.com')
    expect(searchedById.status).toBe(200)
    expect(searchedByIdBody.total).toBe(1)
    expect(searchedByIdBody.users[0].id).toBe('user_person_4')
  })

  it('treats percent and underscore as literal user-search text', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.users.clear()
    const literal = adminUserRecord(1)
    literal.name = 'Literal %_ Marker'
    const ordinary = adminUserRecord(2)
    ordinary.name = 'Literal wildcard Marker'
    adminStore.users.set(literal.id, literal)
    adminStore.users.set(ordinary.id, ordinary)
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/users?q=%25_&limit=25', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.users.map((user: { id: string }) => user.id)).toEqual([literal.id])
  })

  it('rejects invalid user cursors and page limits', async () => {
    const app = adminTestApp()
    const invalidCursor = await app.fetch(
      request('/echo-api/admin/users?cursor=not-a-valid-cursor', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const invalidLimit = await app.fetch(
      request('/echo-api/admin/users?limit=101', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )

    expect(invalidCursor.status).toBe(422)
    await expect(invalidCursor.json()).resolves.toMatchObject({ code: 'validation_failed' })
    expect(invalidLimit.status).toBe(422)
    await expect(invalidLimit.json()).resolves.toMatchObject({ code: 'validation_failed' })
  })

  it('lets an owner reset another credential password and revokes every session', async () => {
    const adminStore = createAdminStoreFixture()
    const auditStore = createMemoryAuditLogStore()
    adminStore.userCredentials.set(freeUser.id, {
      providerId: 'credential',
      providerAccountId: freeUser.id,
      passwordHash: 'old-password-hash',
    })
    adminStore.userSessionCounts.set(freeUser.id, 3)
    const app = adminTestApp({ adminStore, auditStore })

    const res = await app.fetch(
      request('/echo-api/admin/user-passwords', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: freeUser.id, password: 'new-secure-password-42' }),
      }),
    )
    const body = await res.json()
    const credential = adminStore.userCredentials.get(freeUser.id)

    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, userId: freeUser.id, sessionsRevoked: 3 })
    expect(JSON.stringify(body)).not.toContain('new-secure-password-42')
    expect(credential?.passwordHash).not.toBe('new-secure-password-42')
    await expect(
      verifyPassword({
        hash: credential?.passwordHash ?? '',
        password: 'new-secure-password-42',
      }),
    ).resolves.toBe(true)
    expect(adminStore.userSessionCounts.get(freeUser.id)).toBe(0)
    expect(adminStore.sessionRevocations).toContainEqual({
      userId: freeUser.id,
      sessionsRevoked: 3,
    })
    expect(adminStore.controlAudits).toContainEqual(
      expect.objectContaining({
        action: 'admin.user.password_reset',
        metadata: { targetUserId: freeUser.id, sessionsRevoked: 3 },
      }),
    )
    expect(JSON.stringify(adminStore.controlAudits)).not.toContain('new-secure-password-42')
  })

  it('requires self-service for the current admin password', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.userCredentials.set(activeAdminUser.id, {
      providerId: 'credential',
      providerAccountId: activeAdminUser.id,
      passwordHash: 'unchanged',
    })
    adminStore.userSessionCounts.set(activeAdminUser.id, 2)
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/user-passwords', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: activeAdminUser.id,
          password: 'new-secure-password-42',
        }),
      }),
    )

    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toMatchObject({ code: 'validation_failed' })
    expect(adminStore.userCredentials.get(activeAdminUser.id)?.passwordHash).toBe('unchanged')
    expect(adminStore.userSessionCounts.get(activeAdminUser.id)).toBe(2)
  })

  it('prevents admins from resetting an owner password', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.accounts.set(activeAdminUser.id, {
      ...adminStore.accounts.get(activeAdminUser.id)!,
      role: 'admin',
    })
    adminStore.accounts.set(freeUser.id, {
      userId: freeUser.id,
      role: 'owner',
      status: 'active',
      createdBy: activeAdminUser.id,
      createdAt: null,
      updatedAt: null,
    })
    adminStore.userCredentials.set(freeUser.id, {
      providerId: 'credential',
      providerAccountId: freeUser.id,
      passwordHash: 'unchanged',
    })
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/user-passwords', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: freeUser.id, password: 'new-secure-password-42' }),
      }),
    )

    expect(res.status).toBe(403)
    expect(adminStore.userCredentials.get(freeUser.id)?.passwordHash).toBe('unchanged')
  })

  it('lets admins reset ordinary users but rejects operator and viewer roles', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.accounts.set(activeAdminUser.id, {
      ...adminStore.accounts.get(activeAdminUser.id)!,
      role: 'admin',
    })
    adminStore.userCredentials.set(freeUser.id, {
      providerId: 'credential',
      providerAccountId: freeUser.id,
      passwordHash: 'old-password-hash',
    })
    const app = adminTestApp({ adminStore })

    const allowed = await app.fetch(
      request('/echo-api/admin/user-passwords', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: freeUser.id, password: 'admin-reset-password-42' }),
      }),
    )
    expect(allowed.status).toBe(200)

    for (const role of ['operator', 'viewer'] as const) {
      adminStore.accounts.set(activeAdminUser.id, {
        ...adminStore.accounts.get(activeAdminUser.id)!,
        role,
      })
      const rejected = await app.fetch(
        request('/echo-api/admin/user-passwords', {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid-admin-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ userId: freeUser.id, password: 'rejected-password-42' }),
        }),
      )
      expect(rejected.status, role).toBe(403)
    }
  })

  it('prevents admins from downgrading or disabling an owner account', async () => {
    const adminStore = createAdminStoreFixture()
    adminStore.accounts.set(activeAdminUser.id, {
      ...adminStore.accounts.get(activeAdminUser.id)!,
      role: 'admin',
    })
    adminStore.accounts.set(freeUser.id, {
      userId: freeUser.id,
      role: 'owner',
      status: 'active',
      createdBy: activeAdminUser.id,
      createdAt: null,
      updatedAt: null,
    })
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/admin-accounts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: freeUser.id, role: 'viewer', status: 'disabled' }),
      }),
    )

    expect(res.status).toBe(403)
    expect(adminStore.accounts.get(freeUser.id)).toMatchObject({
      role: 'owner',
      status: 'active',
    })
  })

  it('does not invent a password login method for non-credential users', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/user-passwords', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId: freeUser.id, password: 'new-secure-password-42' }),
      }),
    )

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ code: 'not_found' })
  })

  it('allows owner to grant admin authorization through the control API', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/admin-accounts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: freeUser.id,
          role: 'viewer',
          status: 'active',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.account).toMatchObject({
      userId: freeUser.id,
      role: 'viewer',
      status: 'active',
    })
    expect(adminStore.accounts.get(freeUser.id)).toMatchObject({ role: 'viewer' })
  })

  it('records quota adjustments through the control API', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/quota-adjustments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
          'x-idempotency-key': 'admin-quota-adjustment-negative-0001',
        },
        body: JSON.stringify({
          userId: freeUser.id,
          kind: 'llm_tokens',
          amount: -500,
          periodKey: '2026-06',
          reason: 'manual ledger correction',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, amount: -500 })
    expect(adminStore.quotaAdjustments[0]).toMatchObject({
      userId: freeUser.id,
      kind: 'llm_tokens',
      amount: -500,
      periodKey: '2026-06',
    })
  })

  it('records positive panel quota grants as negative usage ledger adjustments', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/quota-adjustments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
          'x-idempotency-key': 'admin-quota-adjustment-grant-0001',
        },
        body: JSON.stringify({
          userId: freeUser.id,
          kind: 'stt_seconds',
          mode: 'grant',
          amount: 3600,
          periodKey: '2026-06',
          reason: 'customer support grant',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, amount: -3600 })
    expect(adminStore.quotaAdjustments[0]).toMatchObject({
      userId: freeUser.id,
      kind: 'stt_seconds',
      amount: -3600,
      periodKey: '2026-06',
    })
  })

  it('records positive quota consumes as usage ledger debits', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const res = await app.fetch(
      request('/echo-api/admin/quota-adjustments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
          'x-idempotency-key': 'admin-quota-adjustment-consume-0001',
        },
        body: JSON.stringify({
          userId: freeUser.id,
          kind: 'llm_tokens',
          mode: 'consume',
          amount: 500,
          periodKey: '2026-06',
          reason: 'manual usage correction',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, amount: 500 })
    expect(adminStore.quotaAdjustments[0]).toMatchObject({
      userId: freeUser.id,
      kind: 'llm_tokens',
      amount: 500,
      periodKey: '2026-06',
    })
  })

  it('updates per-user quota levels through the control API', async () => {
    const adminStore = createAdminStoreFixture()
    const auditStore = createMemoryAuditLogStore()
    const app = adminTestApp({ adminStore, auditStore })

    const res = await app.fetch(
      request('/echo-api/admin/user-quota-levels', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          userId: freeUser.id,
          quotaLevel: 3,
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, userId: freeUser.id, quotaLevel: 3, quotaMultiplier: 3 })
    expect(adminStore.users.get(freeUser.id)).toMatchObject({
      quotaLevel: 3,
      quotaMultiplier: 3,
    })
    expect(
      adminStore.controlAudits.some((entry) => entry.action === 'admin.user_quota_level.set'),
    ).toBe(true)
  })

  it('creates scene packs through the control API and lists them back', async () => {
    const adminStore = createAdminStoreFixture()
    const app = adminTestApp({ adminStore })

    const created = await app.fetch(
      request('/echo-api/admin/scenes', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'factory-shift',
          name: 'Factory Shift',
          description: 'Polishes short handover notes for industrial shift logs.',
          category: 'operations',
          promptTemplate: 'Rewrite as a concise shift note: {{text}}',
          dictionaryTerms: [{ word: 'CNC' }],
          isPro: false,
          enabled: true,
        }),
      }),
    )
    const listed = await app.fetch(
      request('/echo-api/admin/scenes', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const body = await listed.json()

    expect(created.status).toBe(200)
    expect(listed.status).toBe(200)
    expect(body.scenes).toContainEqual(
      expect.objectContaining({
        slug: 'factory-shift',
        enabled: true,
        dictionaryTerms: [expect.objectContaining({ word: 'CNC' })],
      }),
    )
  })

  it('writes provider registry entries, masks keys, and exposes them through startup bootstrap', async () => {
    const desktopStore = createMemoryDesktopConfigStore()
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(desktopStore, env)
    const app = adminTestApp({ env, desktopConfig })

    const created = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          enabled: true,
          mode: 'proxy',
          endpoint: 'https://openrouter.ai/api/v1',
          apiKey: 'test-panel-provider-key',
          defaultModel: 'google/gemini-2.5-flash',
          priority: '10',
        }),
      }),
    )
    const createdBody = await created.json()
    const serializedCreate = JSON.stringify(createdBody)

    expect(created.status).toBe(200)
    expect(createdBody.provider.apiKeyPreview).toBe('configured')
    expect(serializedCreate).not.toContain('test-panel-provider-key')

    const updated = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: createdBody.provider.id,
          expectedRevision: createdBody.provider.revision,
          kind: 'llm',
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          enabled: true,
          mode: 'proxy',
          endpoint: 'https://openrouter.ai/api/v1',
          apiKey: createdBody.provider.apiKeyPreview,
          defaultModel: 'openrouter/updated-model',
          priority: 10,
        }),
      }),
    )
    expect(updated.status).toBe(200)

    const bootstrap = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const bootstrapBody = await bootstrap.json()

    expect(bootstrap.status).toBe(200)
    expect(bootstrapBody.services.llm).toMatchObject({
      mode: 'proxy',
      providerId: 'openrouter',
      defaultModel: 'openrouter/updated-model',
      apiKey: null,
      apiKeyPreview: 'configured',
    })
    expect(JSON.stringify(bootstrapBody)).not.toContain('test-panel-provider-key')
  })

  it('fills provider preset defaults and rejects unsupported proxy providers', async () => {
    const app = adminTestApp()

    const unsupported = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'claude',
          displayName: 'Claude',
          enabled: true,
          mode: 'proxy',
          apiKey: 'sk-unsupported',
        }),
      }),
    )
    const unsupportedBody = await unsupported.json()

    expect(unsupported.status).toBe(422)
    expect(unsupportedBody.code).toBe('validation_failed')

    const directMode = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'openrouter',
          displayName: 'Direct OpenRouter',
          enabled: true,
          mode: 'direct',
          apiKey: 'sk-direct',
          defaultModel: 'google/gemini-2.5-flash',
        }),
      }),
    )
    const directModeBody = await directMode.json()

    expect(directMode.status).toBe(422)
    expect(directModeBody).toMatchObject({
      code: 'validation_failed',
    })

    const created = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'deepseek',
          displayName: 'DeepSeek',
          enabled: true,
          mode: 'proxy',
          apiKey: 'sk-supported',
        }),
      }),
    )
    const createdBody = await created.json()

    expect(created.status).toBe(200)
    expect(createdBody.provider).toMatchObject({
      providerId: 'deepseek',
      defaultModel: 'deepseek-chat',
      capabilities: {
        requiresApiKey: true,
        supportsStreaming: true,
        supportsTranslate: true,
      },
    })
    expect(createdBody.provider.models).toContainEqual(
      expect.objectContaining({ id: 'deepseek-chat' }),
    )
  })

  it('allows no-key local backend providers through the provider registry API', async () => {
    const desktopStore = createMemoryDesktopConfigStore()
    const env = testEnv()
    const desktopConfig = createDesktopConfigService(desktopStore, env)
    const app = adminTestApp({ env, desktopConfig })

    const created = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'tts',
          providerId: 'cosyvoice2-local',
          displayName: 'CosyVoice2 Local',
          enabled: true,
          mode: 'proxy',
          endpoint: 'http://127.0.0.1:18771/tts',
          capabilities: { requiresApiKey: false, voice: 'default' },
        }),
      }),
    )
    const createdBody = await created.json()

    expect(created.status).toBe(200)
    expect(createdBody.provider).toMatchObject({
      providerId: 'cosyvoice2-local',
      endpoint: 'http://127.0.0.1:18771/tts',
      apiKeyPreview: null,
      defaultModel: 'CosyVoice2-0.5B',
      capabilities: {
        requiresApiKey: false,
        voice: 'default',
      },
    })
  })

  it('does not write a provider when the egress safety check rejects it', async () => {
    const desktopStore = createMemoryDesktopConfigStore()
    const env = testEnv()
    const providerControl: ProviderControlService = {
      assertSavable: vi.fn(async () => {
        throw new ApiError(422, 'validation_failed', 'unsafe provider endpoint')
      }),
      listModels: vi.fn(),
    }
    const app = adminTestApp({
      env,
      desktopConfig: createDesktopConfigService(desktopStore, env),
      providerControl,
    })

    const response = await app.fetch(
      request('/echo-api/admin/providers', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'openai-compatible',
          displayName: 'Unsafe provider',
          enabled: true,
          mode: 'proxy',
          endpoint: 'https://unsafe-provider.example/v1',
          apiKey: 'must-not-be-written',
          defaultModel: 'unsafe-model',
        }),
      }),
    )

    expect(response.status).toBe(422)
    expect(providerControl.assertSavable).toHaveBeenCalledTimes(1)
    expect(desktopStore.providers.size).toBe(0)
  })

  it('reads provider models from the backend endpoint for the panel model picker', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('global fetch must not be used by the provider model handler')
    })
    vi.stubGlobal('fetch', fetchMock)
    const listModels = vi.fn(async () => [
      { id: 'qwen3.5', label: 'qwen3.5' },
      { id: 'deepseek-r1:7b', label: 'deepseek-r1:7b' },
    ])
    const providerControl: ProviderControlService = {
      assertSavable: vi.fn(),
      listModels,
    }
    const app = adminTestApp({ providerControl })

    const res = await app.fetch(
      request('/echo-api/admin/provider-models', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'llm',
          providerId: 'openai-compatible',
          endpoint: 'https://provider.example/v1',
        }),
      }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.models).toEqual([
      { id: 'qwen3.5', label: 'qwen3.5' },
      { id: 'deepseek-r1:7b', label: 'deepseek-r1:7b' },
    ])
    expect(listModels).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'llm',
        providerId: 'openai-compatible',
        endpoint: 'https://provider.example/v1',
      }),
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('trusts only the exact active provider endpoint for private model discovery', async () => {
    const activeEndpoint = 'http://10.24.0.8:11440/v1'
    const store = createMemoryDesktopConfigStore()
    store.providers.set('provider-local', {
      id: 'provider-local',
      kind: 'llm',
      providerId: 'ollama',
      displayName: 'Ollama via host bridge',
      enabled: true,
      mode: 'proxy',
      endpoint: activeEndpoint,
      apiKey: null,
      apiKeyPreview: null,
      defaultModel: 'qwen-active',
      models: [{ id: 'qwen-active', label: 'qwen-active' }],
      capabilities: { requiresApiKey: false },
      priority: 1,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    })
    const desktopConfig = createDesktopConfigService(store, testEnv())
    const listModels = vi.fn(async () => [{ id: 'qwen-active', label: 'qwen-active' }])
    const providerControl: ProviderControlService = {
      assertSavable: vi.fn(),
      listModels,
    }
    const app = adminTestApp({ desktopConfig, providerControl })

    const readModels = (endpoint: string, extra: Record<string, unknown> = {}) =>
      app.fetch(
        request('/echo-api/admin/provider-models', {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid-admin-token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ kind: 'llm', providerId: 'ollama', endpoint, ...extra }),
        }),
      )

    expect((await readModels(activeEndpoint)).status).toBe(200)
    expect(listModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ trustedLocalEndpoint: activeEndpoint, endpoint: activeEndpoint }),
    )

    const unsavedEndpoint = 'http://10.24.0.9:11440/v1'
    expect(
      (await readModels(unsavedEndpoint, { trustedLocalEndpoint: unsavedEndpoint })).status,
    ).toBe(200)
    expect(listModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ trustedLocalEndpoint: null, endpoint: unsavedEndpoint }),
    )
  })

  it('publishes OTA releases and exposes download URLs only from the protected list view', async () => {
    const desktopStore = createMemoryDesktopConfigStore()
    const env = testEnv()
    const desktopConfig = createValidatedOtaService(desktopStore, env)
    const app = adminTestApp({ env, desktopConfig })

    const saved = await app.fetch(
      request('/echo-api/admin/ota-releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: '0.2.0',
          channel: 'stable',
          platform: 'all',
          arch: 'all',
          enabled: false,
          autoUpdate: true,
          forceUpdate: false,
          minVersion: '0.1.0',
          artifactBytes: 4_832_676,
          downloadUrl: 'https://example.com/private/EcholIKE-0.2.0.exe',
          sha256: 'a'.repeat(64),
          signature: 'signed-release',
          releaseNotes: 'Panel published update',
        }),
      }),
    )
    const saveBody = await saved.json()

    expect(saved.status).toBe(200)
    expect(saveBody.release).toMatchObject({ enabled: false, downloadUrlPreview: 'set' })
    expect(JSON.stringify(saveBody)).not.toContain('private/EcholIKE')

    const validated = await app.fetch(
      request('/echo-api/admin/ota-releases/validate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: saveBody.release.id,
          expectedRevision: saveBody.release.revision,
        }),
      }),
    )
    const validateBody = await validated.json()
    expect(validated.status).toBe(200)
    expect(validateBody).toMatchObject({
      release: { enabled: false, revision: 0 },
      validation: { valid: true, bytes: 4_832_676 },
    })

    const activated = await app.fetch(
      request('/echo-api/admin/ota-releases/activate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: saveBody.release.id,
          expectedRevision: saveBody.release.revision,
          forceUpdate: true,
        }),
      }),
    )
    const activateBody = await activated.json()
    expect(activated.status).toBe(200)
    expect(activateBody.release).toMatchObject({ enabled: true, forceUpdate: true, revision: 1 })

    const listed = await app.fetch(
      request('/echo-api/admin/ota-releases', {
        headers: { authorization: 'Bearer valid-admin-token' },
      }),
    )
    const listBody = await listed.json()
    expect(listBody.releases).toContainEqual(
      expect.objectContaining({
        version: '0.2.0',
        downloadUrl: 'https://example.com/private/EcholIKE-0.2.0.exe',
        releaseNotes: 'Panel published update',
      }),
    )

    const update = await app.fetch(request('/echo-api/app/update?version=0.1.0&platform=windows'))
    const updateBody = await update.json()
    expect(updateBody).toMatchObject({
      latestVersion: '0.2.0',
      autoUpdate: true,
      updateAvailable: true,
      forceUpdate: true,
      downloadUrl: 'https://example.com/private/EcholIKE-0.2.0.exe',
      releaseNotes: 'Panel published update',
    })

    const bootstrap = await app.fetch(
      request('/echo-api/desktop/bootstrap?version=0.1.0&platform=windows', {
        headers: { authorization: 'Bearer valid-pro-token' },
      }),
    )
    const bootstrapBody = await bootstrap.json()
    const serializedBootstrap = JSON.stringify(bootstrapBody)

    expect(bootstrapBody.ota).toMatchObject({
      latestVersion: '0.2.0',
      updateAvailable: true,
      forceUpdate: true,
      downloadAvailable: true,
    })
    expect(serializedBootstrap).not.toContain('private/EcholIKE')
    expect(serializedBootstrap).not.toContain('downloadUrl')

    const deactivated = await app.fetch(
      request('/echo-api/admin/ota-releases/deactivate', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: saveBody.release.id,
          expectedRevision: activateBody.release.revision,
        }),
      }),
    )
    expect(deactivated.status).toBe(200)
    expect((await deactivated.json()).release).toMatchObject({
      enabled: false,
      forceUpdate: false,
      revision: 2,
    })

    const afterDeactivation = await app.fetch(
      request('/echo-api/app/update?version=0.1.0&platform=windows'),
    )
    expect(await afterDeactivation.json()).toMatchObject({ updateAvailable: false })
  })
})

function createValidatedOtaService(
  store: ReturnType<typeof createMemoryDesktopConfigStore>,
  env: ReturnType<typeof testEnv>,
): DesktopConfigService {
  return createDesktopConfigService(store, env, {
    async validateOtaReleaseArtifact(
      release: OtaReleaseStoredRecord,
    ): Promise<OtaArtifactValidationResult> {
      if (!release.artifactBytes || !release.sha256) {
        throw new Error('OTA validation fixture requires complete artifact facts')
      }
      return {
        valid: true,
        bytes: release.artifactBytes,
        sha256: release.sha256,
        contentLength: release.artifactBytes,
        redirects: 0,
        network: 'public',
        signaturePresent: true,
        artifactType: 'windows-pe-installer',
        expectedVersion: release.version,
        versionFacts: {
          installerFileVersion: `${release.version}.0`,
          installerProductVersion: `${release.version}.0`,
        },
      }
    },
  })
}

function adminTestApp(options: AdminTestAppOptions = {}) {
  const env = options.env ?? testEnv()
  const auditStore = options.auditStore ?? createMemoryAuditLogStore()
  const adminStore = options.adminStore ?? createAdminStoreFixture()
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({
      'valid-free-token': freeUser,
      'valid-pro-token': proUser,
      'valid-admin-token': activeAdminUser,
      'valid-disabled-admin-token': disabledAdminUser,
    }),
    services: {
      ...testServices(env),
      audit: createAuditService(auditStore),
      admin: createAdminService(adminStore),
      ...(options.desktopConfig ? { desktopConfig: options.desktopConfig } : {}),
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.providerControl ? { providerControl: options.providerControl } : {}),
    },
  })
}

function createAdminStoreFixture() {
  const store = createMemoryAdminStore(
    [
      {
        userId: activeAdminUser.id,
        role: 'owner',
        status: 'active',
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      },
      {
        userId: disabledAdminUser.id,
        role: 'admin',
        status: 'disabled',
        createdBy: activeAdminUser.id,
        createdAt: null,
        updatedAt: null,
      },
    ],
    {
      userCount: 3,
    },
  )
  store.users.set(freeUser.id, {
    id: freeUser.id,
    email: freeUser.email,
    name: freeUser.name,
    emailVerified: true,
    createdAt: null,
    updatedAt: null,
    adminRole: null,
    adminStatus: null,
    plan: 'free',
    subscriptionStatus: null,
    subscriptionEnd: null,
    quotaLevel: 1,
    quotaMultiplier: 1,
    sttSecondsUsed: 0,
    llmTokensUsed: 0,
    ocrImagesUsed: 0,
    ttsCharsUsed: 0,
  })
  store.users.set(activeAdminUser.id, {
    id: activeAdminUser.id,
    email: activeAdminUser.email,
    name: activeAdminUser.name,
    emailVerified: true,
    createdAt: null,
    updatedAt: null,
    adminRole: 'owner',
    adminStatus: 'active',
    plan: 'pro',
    subscriptionStatus: 'active',
    subscriptionEnd: null,
    quotaLevel: 1,
    quotaMultiplier: 1,
    sttSecondsUsed: 0,
    llmTokensUsed: 0,
    ocrImagesUsed: 0,
    ttsCharsUsed: 0,
  })
  return store
}

function adminUserRecord(index: number) {
  return {
    id: `user_person_${index}`,
    email: `person-${index}@example.com`,
    name: `Person ${index}`,
    emailVerified: true,
    createdAt: new Date(Date.UTC(2026, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, index)).toISOString(),
    adminRole: null,
    adminStatus: null,
    plan: 'free' as const,
    subscriptionStatus: null,
    subscriptionEnd: null,
    quotaLevel: 1 as const,
    quotaMultiplier: 1,
    sttSecondsUsed: 0,
    llmTokensUsed: 0,
    ocrImagesUsed: 0,
    ttsCharsUsed: 0,
  }
}

interface AdminTestAppOptions {
  env?: ReturnType<typeof testEnv>
  auditStore?: ReturnType<typeof createMemoryAuditLogStore>
  adminStore?: AdminStore & ReturnType<typeof createAdminStoreFixture>
  desktopConfig?: DesktopConfigService
  proxy?: ProxyServices
  providerControl?: ProviderControlService
}
