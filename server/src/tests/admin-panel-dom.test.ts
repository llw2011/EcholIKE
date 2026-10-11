// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { ADMIN_ACTOR_HEADER } from '../middleware/admin-origin.js'
import { capabilitiesForAdminRole } from '../middleware/require-admin.js'
import { createAdminService, createMemoryAdminStore } from '../services/admin/admin-service.js'
import type { AuthenticatedUser } from '../types.js'
import { request, testEnv, testServices } from './helpers.js'

const owner: AuthenticatedUser = {
  id: 'panel-dom-owner',
  email: 'panel-dom-owner@example.com',
  name: 'Panel DOM Owner',
  plan: 'pro',
  subscriptionEnd: null,
}

const users = [
  panelUser('panel-user-a', 'user-a@example.com', {
    name: 'User A',
    quotaLevel: 2,
    adminRole: 'operator',
  }),
  panelUser('panel-user-b', 'user-b@example.com', { name: 'User B' }),
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.innerHTML = '<head></head><body></body>'
})

describe('admin panel DOM behavior', () => {
  it('actually restores every user form before clearing dirty ownership', async () => {
    await mountPanel({ mobile: false })
    await openUserWorkspace()
    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => text('#user-detail-title').includes('user-a@example.com'))

    setValue('#admin-form [name="role"]', 'owner')
    setValue('#quota-level-form [name="quotaLevel"]', '1')
    setValue('#quota-form [name="amount"]', '42')
    setValue('#quota-form [name="reason"]', 'unsaved adjustment')
    setValue('#reset-password-form [name="password"]', 'temporary-password')
    setValue('#reset-password-form [name="confirmPassword"]', 'temporary-password')

    click('[data-user-task="quota"]')
    expect(element('#danger-confirm').hidden).toBe(false)
    click('#confirm-accept')
    await waitForCondition(() => !element('[data-user-task-view="quota"]').hidden)

    expect(value('#admin-form [name="role"]')).toBe('operator')
    expect(value('#quota-level-form [name="quotaLevel"]')).toBe('2')
    expect(value('#quota-form [name="amount"]')).toBe('1000')
    expect(value('#quota-form [name="reason"]')).toBe('')
    expect(value('#reset-password-form [name="password"]')).toBe('')
    expect(value('#reset-password-form [name="confirmPassword"]')).toBe('')

    click('[data-user-task="create"]')
    setValue('#create-user-form [name="email"]', 'draft@example.com')
    click('#selected-user-clear')
    expect(element('#danger-confirm').hidden).toBe(false)
    click('#confirm-accept')
    await waitForCondition(() => text('#selected-user-email').includes('请先'))
    expect(value('#create-user-form [name="email"]')).toBe('')
  })

  it('never renders sessions under the wrong selected user, including failures and late replies', async () => {
    const failedB = deferred<Response>()
    const lateA = deferred<Response>()
    let aCalls = 0
    let bCalls = 0
    await mountPanel({
      mobile: false,
      route: (url) => {
        if (url.pathname !== '/echo-api/admin/user-sessions') return undefined
        const userId = url.searchParams.get('userId')
        if (userId === 'panel-user-a') {
          aCalls += 1
          if (aCalls === 1) return jsonResponse({ sessions: [session('A-session')] })
          return lateA.promise
        }
        if (userId === 'panel-user-b') {
          bCalls += 1
          if (bCalls === 1) return failedB.promise
          return jsonResponse({ sessions: [session('B-session')] })
        }
        return jsonResponse({ sessions: [] })
      },
    })
    await openUserWorkspace()

    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => text('#user-sessions-list').includes('A-session'))
    click('button[data-user-id="panel-user-b"]')
    expect(text('#user-sessions-list')).not.toContain('A-session')
    failedB.reject(new Error('session lookup failed'))
    await waitForCondition(() => text('#user-sessions-resource').includes('会话加载失败'))
    expect(text('#user-sessions-list')).not.toContain('A-session')

    click('button[data-user-id="panel-user-a"]')
    click('button[data-user-id="panel-user-b"]')
    await waitForCondition(() => text('#user-sessions-list').includes('B-session'))
    lateA.resolve(jsonResponse({ sessions: [session('late-A-session')] }))
    await eventLoopBarrier()
    expect(text('#user-sessions-list')).toContain('B-session')
    expect(text('#user-sessions-list')).not.toContain('late-A-session')
  })

  it('keeps mobile drafts reachable and locks provider inputs for the whole refresh lease', async () => {
    const refreshedProviders = deferred<Response>()
    let providerReads = 0
    const mounted = await mountPanel({
      mobile: true,
      route: (url, init) => {
        if (url.pathname === '/echo-api/admin/providers' && requestMethod(init) === 'GET') {
          providerReads += 1
          if (providerReads === 1) return jsonResponse({ providers: [provider()] })
          return refreshedProviders.promise
        }
        return undefined
      },
    })
    click('[data-view="provider"]')
    await waitForCondition(() => document.querySelector('[data-provider-kind="llm"]') !== null)
    click('[data-provider-kind="llm"]')
    expect(element('#provider-detail').classList.contains('is-open')).toBe(true)

    setValue('#provider-form [name="endpoint"]', 'https://provider.example/draft')
    click('[data-close-panel="provider-detail"]')
    expect(element('#provider-detail').classList.contains('is-open')).toBe(false)
    click('[data-provider-kind="llm"]')
    expect(element('#provider-detail').classList.contains('is-open')).toBe(true)
    expect(value('#provider-form [name="endpoint"]')).toBe('https://provider.example/draft')
    expect(element('#danger-confirm').hidden).toBe(true)

    mounted.media.setMatches(false)
    expect(element('#provider-detail').classList.contains('is-open')).toBe(false)
    mounted.media.setMatches(true)
    expect(element('#provider-detail').classList.contains('is-open')).toBe(true)

    click('[data-retry="provider"]')
    expect(element('#danger-confirm').hidden).toBe(false)
    click('#confirm-accept')
    await waitForCondition(() => input('#provider-form [name="endpoint"]').disabled)
    const writesBefore = mounted.calls.filter(
      (call) => call.url.pathname === '/echo-api/admin/providers' && call.method === 'POST',
    ).length
    click('#provider-form button[type="submit"]')
    expect(
      mounted.calls.filter(
        (call) => call.url.pathname === '/echo-api/admin/providers' && call.method === 'POST',
      ),
    ).toHaveLength(writesBefore)

    refreshedProviders.resolve(jsonResponse({ providers: [provider()] }))
    await waitForCondition(() => !input('#provider-form [name="endpoint"]').disabled)
  })

  it('locks stale user rows and task forms until the newest list read owns the UI', async () => {
    const refreshedUsers = deferred<Response>()
    let userReads = 0
    const mounted = await mountPanel({
      mobile: false,
      route: (url) => {
        if (url.pathname !== '/echo-api/admin/users') return undefined
        userReads += 1
        if (userReads === 1) return jsonResponse(usersPayload(users))
        return refreshedUsers.promise
      },
    })
    await openUserWorkspace()
    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => text('#user-detail-title').includes('user-a@example.com'))

    setValue('#user-search', 'user-b')
    element('#user-search-form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await waitForCondition(() => input('button[data-user-id="panel-user-a"]').disabled)
    expect(input('#quota-level-form [name="quotaLevel"]').disabled).toBe(true)
    const writesBefore = mounted.calls.filter((call) => call.method === 'POST').length
    click('button[data-user-id="panel-user-a"]')
    click('#quota-level-form button[type="submit"]')
    expect(mounted.calls.filter((call) => call.method === 'POST')).toHaveLength(writesBefore)

    refreshedUsers.resolve(jsonResponse(usersPayload([users[1]!], 'user-b')))
    await waitForCondition(() => !input('button[data-user-id="panel-user-b"]').disabled)
    expect(text('#selected-user-email')).toContain('请先')
  })

  it('refreshes same-user forms from the newest server payload after discarding old state', async () => {
    const refreshedUsers = deferred<Response>()
    let userReads = 0
    await mountPanel({
      mobile: false,
      route: (url) => {
        if (url.pathname !== '/echo-api/admin/users') return undefined
        userReads += 1
        if (userReads === 1) return jsonResponse(usersPayload(users))
        return refreshedUsers.promise
      },
    })
    await openUserWorkspace()
    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => value('#admin-form [name="role"]') === 'operator')
    expect(value('#quota-level-form [name="quotaLevel"]')).toBe('2')

    click('[data-retry="user"]')
    await waitForCondition(() => input('#admin-form [name="role"]').disabled)
    refreshedUsers.resolve(
      jsonResponse(
        usersPayload([
          panelUser('panel-user-a', 'user-a@example.com', {
            name: 'User A updated',
            quotaLevel: 1,
            adminRole: 'owner',
          }),
          users[1]!,
        ]),
      ),
    )
    await waitForCondition(() => !input('#admin-form [name="role"]').disabled)

    expect(value('#admin-form [name="role"]')).toBe('owner')
    expect(value('#quota-level-form [name="quotaLevel"]')).toBe('1')
    expect(text('#selected-user-id')).toContain('User A updated')
  })

  it('sends the immutable page actor on every admin read and preserves persisted quota exits', async () => {
    const mounted = await mountPanel({ mobile: true })
    await openUserWorkspace()
    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => text('#user-detail-title').includes('user-a@example.com'))

    const body = {
      userId: 'panel-user-a',
      periodKey: '2026-07',
      mode: 'grant',
      kind: 'llm_tokens',
      amount: 25,
      reason: 'persisted recovery',
    }
    const storageKey =
      'echolike.admin.quota.pending.v3.' +
      encodeURIComponent('/echo-api') +
      '.' +
      encodeURIComponent(owner.id)
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        schema: 3,
        apiBasePath: '/echo-api',
        key: 'persisted-quota-key',
        identity: JSON.stringify(body),
        actorUserId: owner.id,
        uncertain: true,
        body,
      }),
    )
    setValue('#quota-form [name="reason"]', 'persisted recovery')

    click('[data-close-panel="user-detail"]')
    expect(element('#user-detail').classList.contains('is-open')).toBe(false)
    click('[data-view="overview"]')
    await waitForCondition(() => !element('[data-workspace="overview"]').hidden)
    expect(localStorage.getItem(storageKey)).not.toBeNull()
    expect(
      mounted.calls
        .filter((call) => call.url.pathname.startsWith('/echo-api/admin/'))
        .every((call) => call.headers.get(ADMIN_ACTOR_HEADER) === owner.id),
    ).toBe(true)
  })

  it('server-searches usage accounts and rejects late or failed account data', async () => {
    const lateAOverview = deferred<Response>()
    const lateAOperations = deferred<Response>()
    let aOverviewReads = 0
    let aOperationReads = 0
    const mounted = await mountPanel({
      mobile: true,
      route: (url) => {
        if (url.pathname === '/echo-api/admin/users') {
          const query = url.searchParams.get('q') || ''
          const cursor = url.searchParams.get('cursor')
          if (query) return jsonResponse({ ...usersPayload(users, query), limit: 10 })
          if (cursor === 'usage-users-next') {
            return jsonResponse({
              ...usersPayload([users[1]!]),
              limit: 10,
              nextCursor: null,
            })
          }
          return jsonResponse({
            ...usersPayload([users[0]!]),
            limit: 10,
            nextCursor: 'usage-users-next',
          })
        }
        if (url.pathname === '/echo-api/admin/usage-overview') {
          const userId = url.searchParams.get('userId')
          if (userId === 'panel-user-a') {
            aOverviewReads += 1
            return aOverviewReads === 1
              ? lateAOverview.promise
              : jsonResponse({ error: 'account A lookup failed' }, 500)
          }
          if (userId === 'panel-user-b') {
            return jsonResponse({
              overview: usageOverview('panel-user-b', 'user-b@example.com', 'User B', 22),
            })
          }
          return jsonResponse({ overview: usageOverview(null, null, null, 99) })
        }
        if (url.pathname === '/echo-api/admin/quota-operations') {
          const userId = url.searchParams.get('userId')
          if (userId === 'panel-user-a') {
            aOperationReads += 1
            return aOperationReads === 1
              ? lateAOperations.promise
              : jsonResponse({ error: 'account A operations failed' }, 500)
          }
          if (userId === 'panel-user-b') {
            return jsonResponse({
              items: [usageOperation('panel-user-b', 'user-b@example.com', 'User B', 22)],
              nextCursor: null,
            })
          }
          return jsonResponse({ items: [], nextCursor: null })
        }
        return undefined
      },
    })

    click('[data-view="usage"]')
    await waitForCondition(() => text('#usage-usage-metrics').includes('99'))
    click('#usage-account-trigger')
    await waitForCondition(
      () => document.querySelector('[data-usage-user-id="panel-user-a"]') !== null,
    )
    expect(element('#usage-account-menu').hidden).toBe(false)

    const firstSearch = mounted.calls.find(
      (call) => call.url.pathname === '/echo-api/admin/users' && !call.url.searchParams.has('q'),
    )
    expect(firstSearch?.url.searchParams.get('limit')).toBe('10')
    click('#usage-account-more')
    await waitForCondition(
      () => document.querySelector('[data-usage-user-id="panel-user-b"]') !== null,
    )
    expect(
      mounted.calls.some(
        (call) =>
          call.url.pathname === '/echo-api/admin/users' &&
          call.url.searchParams.get('cursor') === 'usage-users-next',
      ),
    ).toBe(true)

    setValue('#usage-account-search', 'user')
    click('#usage-account-search-submit')
    await waitForCondition(() =>
      mounted.calls.some(
        (call) =>
          call.url.pathname === '/echo-api/admin/users' &&
          call.url.searchParams.get('q') === 'user' &&
          call.url.searchParams.get('limit') === '10',
      ),
    )
    await waitForCondition(
      () =>
        document.querySelector('[data-usage-user-id="panel-user-a"]') !== null &&
        document.querySelector('[data-usage-user-id="panel-user-b"]') !== null,
    )

    click('[data-usage-user-id="panel-user-a"]')
    expect(text('#usage-context-label')).toContain('user-a@example.com')
    expect(text('#usage-usage-metrics')).not.toContain('99')
    click('#usage-account-trigger')
    click('[data-usage-user-id="panel-user-b"]')
    await eventLoopBarrier()
    await waitForCondition(() =>
      mounted.calls.some(
        (call) =>
          call.url.pathname === '/echo-api/admin/usage-overview' &&
          call.url.searchParams.get('userId') === 'panel-user-b',
      ),
    )
    await eventLoopBarrier()
    expect(text('#usage-context-label')).toContain('user-b@example.com')
    expect(text('#usage-resource')).toBe('')
    expect(text('#usage-usage-metrics')).toContain('22')
    expect(text('#usage-table')).toContain('user-b@example.com')
    expect(text('#usage-cards')).toContain('user-b@example.com')

    lateAOverview.resolve(
      jsonResponse({
        overview: usageOverview('panel-user-a', 'user-a@example.com', 'User A', 11),
      }),
    )
    lateAOperations.resolve(
      jsonResponse({
        items: [usageOperation('panel-user-a', 'user-a@example.com', 'User A', 11)],
        nextCursor: null,
      }),
    )
    await eventLoopBarrier()
    expect(text('#usage-context-label')).toContain('user-b@example.com')
    expect(text('#usage-usage-metrics')).toContain('22')
    expect(text('#usage-usage-metrics')).not.toContain('11')
    expect(text('#usage-table')).not.toContain('user-a@example.com')

    click('#usage-account-trigger')
    click('[data-usage-user-id="panel-user-a"]')
    await waitForCondition(() => text('#usage-resource').includes('当前筛选加载失败'))
    expect(text('#usage-context-label')).toContain('user-a@example.com')
    expect(text('#usage-usage-metrics')).not.toContain('22')
    expect(text('#usage-table')).not.toContain('user-b@example.com')
  })

  it('reuses the selected user when entering usage and binds both reads to one scope', async () => {
    const mounted = await mountPanel({ mobile: false })
    await openUserWorkspace()
    click('button[data-user-id="panel-user-a"]')
    await waitForCondition(() => text('#user-detail-title').includes('user-a@example.com'))

    click('[data-view="usage"]')
    await waitForCondition(() => text('#usage-context-label').includes('user-a@example.com'))
    const usageReads = mounted.calls.filter((call) =>
      ['/echo-api/admin/usage-overview', '/echo-api/admin/quota-operations'].includes(
        call.url.pathname,
      ),
    )
    const selectedReads = usageReads.slice(-2)
    expect(selectedReads).toHaveLength(2)
    expect(
      selectedReads.every(
        (call) =>
          call.url.searchParams.get('userId') === 'panel-user-a' &&
          call.url.searchParams.get('periodKey') === new Date().toISOString().slice(0, 7),
      ),
    ).toBe(true)
  })

  it('keeps the actor-change sign-out message and freezes dynamic OTA actions', async () => {
    await mountPanel({
      mobile: false,
      route: (url, init) => {
        const method = requestMethod(init)
        if (url.pathname === '/echo-api/admin/ota-releases' && method === 'GET') {
          return jsonResponse({
            releases: [
              {
                id: 'release-draft',
                appName: 'EcholIKE',
                version: '0.2.13',
                channel: 'stable',
                platform: 'windows',
                arch: 'x86_64',
                enabled: false,
                autoUpdate: false,
                forceUpdate: false,
                revision: 1,
              },
            ],
          })
        }
        if (url.pathname === '/echo-api/auth/sign-out' && method === 'POST') {
          return jsonResponse({ code: 'admin_actor_changed' }, 409)
        }
        return undefined
      },
    })

    click('[data-view="publish"]')
    await waitForCondition(() => document.querySelector('[data-ota-action="validate"]') !== null)
    expect(input('[data-ota-action="validate"]').disabled).toBe(false)

    click('#cmd-signout')
    await waitForCondition(() => text('#global-status').includes('登录账号已在其他窗口切换'))

    expect(text('#global-status')).not.toContain('检查网络')
    expect(input('#cmd-signout').disabled).toBe(true)
    expect(input('[data-ota-action="validate"]').disabled).toBe(true)
  })
})

async function mountPanel(options: {
  mobile: boolean
  route?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined
}) {
  const html = await dashboardHtml()
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? '',
  )
  expect(scripts).toHaveLength(2)
  document.open()
  document.write(html.replace(/<script nonce="[^"]+">[\s\S]*?<\/script>/g, ''))
  document.close()
  localStorage.clear()

  const media = controlledMatchMedia(options.mobile)
  vi.stubGlobal('matchMedia', media.matchMedia)
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: media.matchMedia })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: unknown, action: (lock: object) => unknown) =>
        action({}),
    },
  })

  const calls: Array<{ url: URL; method: string; headers: Headers }> = []
  const fetchMock = vi.fn(async (inputValue: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof inputValue === 'string' ? inputValue : inputValue.toString(),
      location.origin,
    )
    const method = requestMethod(init)
    const headers = new Headers(init?.headers)
    calls.push({ url, method, headers })
    const routed = options.route?.(url, init)
    if (routed !== undefined) return await routed
    return defaultResponse(url, method)
  })
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'fetch', { configurable: true, value: fetchMock })

  new Function(scripts[0]!)()
  new Function(scripts[1]!)()
  await waitForCondition(() => text('#status-bar').includes('已连接'))
  return { calls, media }
}

async function openUserWorkspace() {
  click('[data-view="user"]')
  await waitForCondition(() => document.querySelector('[data-user-id="panel-user-a"]') !== null)
}

async function dashboardHtml(): Promise<string> {
  const env = testEnv()
  const adminStore = createMemoryAdminStore([
    {
      userId: owner.id,
      role: 'owner',
      status: 'active',
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    },
  ])
  const app = createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({ 'panel-dom-token': owner }),
    services: { ...testServices(env), admin: createAdminService(adminStore) },
  })
  const response = await app.fetch(
    request('/echo-panel/', { headers: { authorization: 'Bearer panel-dom-token' } }),
  )
  expect(response.status).toBe(200)
  return response.text()
}

function defaultResponse(url: URL, method: string): Response {
  if (method === 'POST') return jsonResponse({ ok: true })
  if (url.pathname === '/echo-api/admin/summary') return jsonResponse(summary())
  if (url.pathname === '/echo-api/admin/operations-overview') return jsonResponse({ overview: {} })
  if (url.pathname === '/echo-api/admin/usage-overview') {
    const userId = url.searchParams.get('userId')
    const user = users.find((item) => item.id === userId)
    return jsonResponse({
      overview: {
        subject: user ? { id: user.id, email: user.email, name: user.name } : null,
        usage: { stt_seconds: 0, llm_tokens: 0, ocr_images: 0, tts_chars: 0 },
        operations: { reserved: 0, completed: 0, released: 0 },
        expiredReservations: 0,
        unreconciledOperations: 0,
        adjustments: 0,
      },
    })
  }
  if (url.pathname === '/echo-api/admin/quota-operations') {
    return jsonResponse({ items: [], nextCursor: null })
  }
  if (url.pathname === '/echo-api/admin/proxy-status') return jsonResponse({})
  if (url.pathname === '/echo-api/admin/desktop-policy') return jsonResponse({ providerStatus: {} })
  if (url.pathname === '/echo-api/admin/users') return jsonResponse(usersPayload(users))
  if (url.pathname === '/echo-api/admin/user-sessions') return jsonResponse({ sessions: [] })
  if (url.pathname === '/echo-api/admin/providers') return jsonResponse({ providers: [provider()] })
  if (url.pathname === '/echo-api/admin/scenes') return jsonResponse({ scenes: [] })
  if (url.pathname === '/echo-api/admin/ota-releases') return jsonResponse({ releases: [] })
  if (url.pathname === '/echo-api/admin/system')
    return jsonResponse({ runtime: {}, dependencies: {} })
  return jsonResponse({ ok: true })
}

function summary() {
  return {
    ok: true,
    admin: {
      userId: owner.id,
      role: 'owner',
      capabilities: capabilitiesForAdminRole('owner'),
    },
    overview: { userCount: users.length, subscriptionCount: 0 },
  }
}

function usersPayload(items: typeof users, query = '') {
  return {
    users: items,
    total: items.length,
    limit: 25,
    query,
    nextCursor: null,
    planLimits: {
      free: { sttSeconds: 100, llmTokens: 100, ocrImages: 100, ttsChars: 100 },
      pro: { sttSeconds: 1000, llmTokens: 1000, ocrImages: 1000, ttsChars: 1000 },
    },
    quotaLevels: [
      { quotaLevel: 1, quotaMultiplier: 1, label: 'Lv.1' },
      { quotaLevel: 2, quotaMultiplier: 2, label: 'Lv.2' },
    ],
  }
}

function panelUser(
  id: string,
  email: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    email,
    name: null,
    plan: 'free',
    subscriptionStatus: null,
    subscriptionEnd: null,
    adminRole: 'viewer',
    adminStatus: 'active',
    quotaLevel: 1,
    sttSecondsUsed: 0,
    sttSecondsLimit: 100,
    llmTokensUsed: 0,
    llmTokensLimit: 100,
    ocrImagesUsed: 0,
    ocrImagesLimit: 100,
    ttsCharsUsed: 0,
    ttsCharsLimit: 100,
    ...overrides,
  }
}

function provider() {
  return {
    id: 'provider-llm',
    kind: 'llm',
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    enabled: true,
    mode: 'proxy',
    endpoint: 'https://provider.example/v1',
    defaultModel: 'test-model',
    models: [{ id: 'test-model', name: 'Test Model' }],
    capabilities: { requiresApiKey: true },
    priority: 10,
    revision: 1,
    apiKeyPreview: 'configured',
  }
}

function session(fingerprint: string) {
  return {
    active: true,
    createdAt: '2026-07-30T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    ipFingerprint: fingerprint,
    userAgentFingerprint: fingerprint,
  }
}

function usageOverview(
  id: string | null,
  email: string | null,
  name: string | null,
  amount: number,
) {
  return {
    periodKey: '2026-07',
    subject: id && email ? { id, email, name } : null,
    usage: {
      stt_seconds: amount,
      llm_tokens: amount,
      ocr_images: amount,
      tts_chars: amount,
    },
    operations: { reserved: 0, completed: 1, released: 0 },
    expiredReservations: 0,
    unreconciledOperations: 0,
    adjustments: 0,
  }
}

function usageOperation(userId: string, userEmail: string, userName: string, amount: number) {
  return {
    id: `operation-${userId}`,
    userId,
    userEmail,
    userName,
    kind: 'llm_tokens',
    source: 'proxy_llm',
    periodKey: '2026-07',
    requestId: `request-${userId}`,
    reservedAmount: amount,
    actualAmount: amount,
    status: 'completed',
    leaseExpiresAt: null,
    responseStatus: 200,
    responseCached: false,
    ledgerNetAmount: amount,
    ledgerEventCount: 2,
    reconciled: true,
    createdAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:01.000Z',
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function requestMethod(init: RequestInit | undefined): string {
  return String(init?.method ?? 'GET').toUpperCase()
}

function controlledMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const query = '(max-width: 760px)'
  const list = {
    get matches() {
      return matches
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList
  return {
    matchMedia: () => list,
    setMatches(next: boolean) {
      matches = next
      const event = { matches: next, media: query } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
  }
}

function click(selector: string) {
  input(selector).click()
}

function setValue(selector: string, next: string) {
  const control = input(selector)
  control.value = next
  control.dispatchEvent(new Event('input', { bubbles: true }))
  control.dispatchEvent(new Event('change', { bubbles: true }))
}

function value(selector: string): string {
  return input(selector).value
}

function text(selector: string): string {
  return element(selector).textContent ?? ''
}

function input(selector: string): HTMLInputElement | HTMLSelectElement | HTMLButtonElement {
  const found = document.querySelector(selector)
  if (
    !(
      found instanceof HTMLInputElement ||
      found instanceof HTMLSelectElement ||
      found instanceof HTMLButtonElement
    )
  ) {
    throw new Error(`Expected form control: ${selector}`)
  }
  return found
}

function element(selector: string): HTMLElement {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`Expected element: ${selector}`)
  return found
}

function waitForCondition(condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve()
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!condition()) return
      observer.disconnect()
      resolve()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
  })
}

function eventLoopBarrier(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
