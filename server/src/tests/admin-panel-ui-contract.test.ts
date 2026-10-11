import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createStaticSessionVerifier } from '../auth/session.js'
import { createAdminService, createMemoryAdminStore } from '../services/admin/admin-service.js'
import type { AuthenticatedUser } from '../types.js'
import { request, testEnv, testServices } from './helpers.js'

const owner: AuthenticatedUser = {
  id: 'panel-contract-owner',
  email: 'panel-owner@example.com',
  name: 'Panel Owner',
  plan: 'pro',
  subscriptionEnd: null,
}

describe('admin panel browser contract', () => {
  it('uses a fresh nonce for every response and nonced inline assets only', async () => {
    const app = panelApp()
    const first = await app.fetch(panelRequest())
    const second = await app.fetch(panelRequest())
    const firstHtml = await first.text()
    const secondHtml = await second.text()
    const firstNonce = nonceFromCsp(first.headers.get('content-security-policy'))
    const secondNonce = nonceFromCsp(second.headers.get('content-security-policy'))

    expect(firstNonce).toBeTruthy()
    expect(secondNonce).toBeTruthy()
    expect(secondNonce).not.toBe(firstNonce)
    expect(firstHtml).not.toMatch(/<(?:script|style)(?! nonce=)/)
    expect(firstHtml).toContain(`<style nonce="${firstNonce}">`)

    const scripts = [...firstHtml.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(2)
    for (const [, nonce, source = ''] of scripts) {
      expect(nonce).toBe(firstNonce)
      expect(() => new Function(source ?? '')).not.toThrow()
    }

    const csp = first.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain(`script-src 'nonce-${firstNonce}'`)
    expect(csp).toContain(`style-src 'nonce-${firstNonce}'`)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("'unsafe-inline'")
  })

  it('binds every login-page inline asset to the response nonce', async () => {
    const response = await panelApp().fetch(request('/echo-panel/login'))
    const loginHtml = await response.text()
    const nonce = nonceFromCsp(response.headers.get('content-security-policy'))

    expect(nonce).toBeTruthy()
    expect(loginHtml).not.toMatch(/<(?:script|style)(?! nonce=)/)
    expect(loginHtml).toContain(`<style nonce="${nonce}">`)

    const scripts = [...loginHtml.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(2)
    for (const [, scriptNonce, source = ''] of scripts) {
      expect(scriptNonce).toBe(nonce)
      expect(() => new Function(source)).not.toThrow()
    }
  })

  it('keeps authentication cookie-only and clears only the retired panel token', async () => {
    const app = panelApp()
    const loginHtml = await (await app.fetch(request('/echo-panel/login'))).text()
    const dashboardHtml = await (await app.fetch(panelRequest())).text()

    expect(loginHtml).toContain("localStorage.removeItem('echoPanelToken')")
    expect(dashboardHtml).toContain("localStorage.removeItem('echoPanelToken')")
    expect(loginHtml).not.toContain("localStorage.setItem('echoPanelToken'")
    expect(dashboardHtml).not.toContain("localStorage.setItem('echoPanelToken'")
    expect(dashboardHtml).not.toContain('Authorization')
    expect(dashboardHtml).toContain("credentials: 'include'")
    expect(loginHtml).toContain('if (!loginCompleted)')
  })

  it('exposes capability-gated modules without automatic diagnostics or raw JSON editors', async () => {
    const dashboardHtml = await (await panelApp().fetch(panelRequest())).text()

    for (const path of [
      '/admin/operations-overview',
      '/admin/usage-overview',
      '/admin/quota-operations',
      '/admin/audit',
      '/admin/user-sessions',
    ]) {
      expect(dashboardHtml).toContain(path)
    }
    expect(dashboardHtml).toContain('admin.capabilities')
    expect(dashboardHtml).toContain('data-task-capability="quota:write"')
    expect(dashboardHtml).toContain('data-view="account"')
    expect(dashboardHtml).toContain('data-workspace="account"')
    expect(dashboardHtml).toContain('此入口不需要用户列表权限')
    expect(dashboardHtml).toContain('panel-owner@example.com')
    expect(dashboardHtml.match(/id="change-password-form"/g)).toHaveLength(1)
    expect(dashboardHtml).toContain(
      "viewCapabilities = { overview: 'overview:read', user: 'users:read'",
    )
    expect(dashboardHtml).not.toContain('data-user-task="own-password"')
    expect(dashboardHtml).not.toContain('capabilitiesText')
    expect(dashboardHtml).toContain('只读显示当前服务预设')
    expect(dashboardHtml).toContain('return { ...state.providerCapabilities }')
    expect(dashboardHtml).not.toContain('data-capability-key=')
    expect(dashboardHtml).toContain('启用后客户端可获取')
    expect(dashboardHtml).toContain("m('审计事件', operations ? operations.auditedRequests : '—')")
    expect(dashboardHtml).toContain('id="usage-account-trigger"')
    expect(dashboardHtml).toContain('邮箱、昵称或用户 ID')
    expect(dashboardHtml).toContain("limit: '10'")
    expect(dashboardHtml).toContain('本账期全部类型总量，不随下方明细的类型或状态筛选变化。')
    expect(dashboardHtml).toContain("m('人工调整', overview ? overview.adjustments : '—')")
    const usageRenderer = dashboardHtml.slice(
      dashboardHtml.indexOf('function renderUsage()'),
      dashboardHtml.indexOf('function operationStatusLabel'),
    )
    expect(usageRenderer).not.toContain("m('失败请求'")
    expect(dashboardHtml).not.toContain('showJson')
    expect(dashboardHtml).not.toContain('load().then(() => runCheckup())')
    expect(dashboardHtml).not.toContain('state.periodKey')
  })

  it('preserves mutation identity, explicit activation, and mobile task-panel ownership', async () => {
    const dashboardHtml = await (await panelApp().fetch(panelRequest())).text()

    expect(dashboardHtml).toContain("'x-idempotency-key': operation.key")
    expect(dashboardHtml).toContain(
      "quotaPendingStoragePrefix = 'echolike.admin.quota.pending.v3.' + encodeURIComponent(base)",
    )
    expect(dashboardHtml).toContain('quotaPendingStoragePrefix + encodeURIComponent(actorUserId)')
    expect(dashboardHtml).toContain('localStorage.setItem(storageKey, serialized)')
    expect(dashboardHtml).toContain('localStorage.getItem(storageKey) !== serialized')
    expect(dashboardHtml).toContain(
      "navigator.locks.request(storageKey, { mode: 'exclusive', ifAvailable: true }",
    )
    expect(dashboardHtml).toContain('pending.actorUserId === actorUserId')
    expect(dashboardHtml).toContain('state.pendingQuotaStorageCorrupt')
    expect(dashboardHtml).toContain('state.userQuery = String(pending.body.userId)')
    expect(dashboardHtml).toContain("setUserTask(pending ? 'quota' : 'quota-level'")
    expect(dashboardHtml).toContain('pending.body.userId !== user.id')
    expect(dashboardHtml).toContain('const safelyRejected = error && !operation.uncertain')
    expect(dashboardHtml).toContain('markPendingQuotaUncertain(operation.key)')
    expect(dashboardHtml).toContain('response.status === 409 || response.status === 428')
    expect(dashboardHtml).toContain("error.code = 'response_incomplete'")
    expect(dashboardHtml).toContain('discardSceneEdits()')
    expect(dashboardHtml).toContain('不会用 0 代替未知值')
    expect(dashboardHtml).toContain('restoredOrigin || origin')
    expect(dashboardHtml).toContain('body.reason')
    expect(dashboardHtml).toContain('name="artifactBytes"')
    expect(dashboardHtml).toContain('name="expectedRevision"')
    expect(dashboardHtml).toContain('body.expectedRevision = Number(body.expectedRevision)')
    expect(dashboardHtml).toContain('data-submit-mode="draft"')
    expect(dashboardHtml).not.toContain('data-submit-mode="validate"')
    expect(dashboardHtml).not.toContain('data-submit-mode="activate"')
    expect(dashboardHtml).toContain("const endpointAction = forceActivate ? 'activate' : action")
    expect(dashboardHtml).toContain('forceUpdate: forceActivate')
    expect(dashboardHtml).toContain('data-ota-action="validate"')
    expect(dashboardHtml).toContain('data-ota-action="activate"')
    expect(dashboardHtml).toContain('data-ota-action="force-activate"')
    expect(dashboardHtml).toContain('data-ota-action="deactivate"')
    expect(dashboardHtml).toContain('已通过重新读取服务器状态确认结果')
    expect(dashboardHtml).toContain('expectedRevision: previousRevision')
    expect(dashboardHtml).toContain('Number(current.revision) !== previousRevision + 1')
    expect(dashboardHtml).toContain("action === 'validate'")
    expect(dashboardHtml).toContain('revision 与目标状态不能证明是本次操作')
    expect(dashboardHtml).toContain("const key = 'ota-write'")
    expect(dashboardHtml).toContain("key: 'ota-write'")
    expect(dashboardHtml).toContain('findOtaDraftCandidate(body)')
    expect(dashboardHtml).toContain(
      'if (uncertain && candidate && otaDraftMatches(candidate, body))',
    )
    expect(dashboardHtml).toContain('otaDraftMatches(candidate, body)')
    expect(dashboardHtml).toContain('Number(release.revision) === expectedSavedRevision')
    expect(dashboardHtml).toContain(
      '? (Number.isSafeInteger(body.expectedRevision) ? body.expectedRevision + 1 : null)',
    )
    expect(dashboardHtml).toContain('已通过重新读取服务器状态恢复确认')
    expect(dashboardHtml).not.toContain('assertOtaActivation(body)')
    expect(dashboardHtml).toContain('!container.contains(document.activeElement)')
    expect(dashboardHtml).toContain('role="alertdialog"')
    expect(dashboardHtml).toContain(
      'id="ota-result" class="result-line" role="status" aria-live="polite"',
    )
    expect(dashboardHtml).toContain('syncModalIsolation()')
    expect(dashboardHtml).toContain('sibling.inert = true')
    expect(dashboardHtml).toContain('restoreFocusTarget(state.panelOrigin)')
    expect(dashboardHtml).toContain('pageActorUserId = window.__ECHO_PANEL__.actorUserId')
    expect(dashboardHtml).toContain('headers.set(adminActorHeader, pageActorUserId)')
    expect(dashboardHtml).toContain('return pageActorUserId')
    expect(dashboardHtml).toContain('resetUserTaskForms(state.selectedUser)')
    expect(dashboardHtml).toContain('state.userSessionsForId === state.selectedUser.id')
    expect(dashboardHtml).toContain('kind === state.selectedProviderKind')
    expect(dashboardHtml).toContain('scene.id === state.selectedSceneId')
    expect(dashboardHtml).toContain('state.providerDirty')
    expect(dashboardHtml).toContain('state.userFormDirty')
    expect(dashboardHtml).toContain('state.otaDirty')
    expect(dashboardHtml).toContain('syncProviderDefaults(true)')
    expect(dashboardHtml).toContain('if (configured) pick.value = configured.providerId')
    expect(dashboardHtml).toContain(
      'syncProviderDefaults(true, !configured || configured.providerId !== pick.value)',
    )
    expect(dashboardHtml).toContain("named(form, 'kind').value = state.selectedProviderKind")
    expect(dashboardHtml).toContain('state.userFormDirty && !discardUserEdits()')
    expect(dashboardHtml).not.toContain('本地服务可填 http://127.0.0.1:18771/tts')
    expect(dashboardHtml).toContain('留空使用服务预设；自定义时填写实际受控地址')
    expect(dashboardHtml).toContain('.detail-pane.is-open { position: fixed; inset: 0;')
    expect(dashboardHtml).toContain('body.panel-open { overflow: hidden; }')
    expect(dashboardHtml).toContain(
      '.btn-icon, .row-toggle, .detail-back { min-width: 44px; min-height: 44px; }',
    )
    expect(dashboardHtml).toContain('env(safe-area-inset-bottom)')
    expect(dashboardHtml).toContain('.ota-history > summary { min-height: 44px; }')
    expect(dashboardHtml).toContain('.user-table-wrap { display: none; }')
    expect(dashboardHtml).toContain(
      '.usage-account-menu { position: static; width: 100%; box-shadow: none; }',
    )
    expect(dashboardHtml).toContain('.insight-cards { display: grid; }')
    expect(dashboardHtml).not.toContain('.user-table-wrap { max-height:')
  })

  it('guards dirty refreshes, late model reads, unloads, and hidden password fields', async () => {
    const dashboardHtml = await (await panelApp().fetch(panelRequest())).text()

    const retryHandler = dashboardHtml.slice(
      dashboardHtml.indexOf("$$('[data-retry]')"),
      dashboardHtml.indexOf("$$('[data-close-panel]')"),
    )
    expect(retryHandler).toContain('await prepareActiveRefresh()')
    expect(retryHandler.indexOf('await prepareActiveRefresh()')).toBeLessThan(
      retryHandler.indexOf('await loadActiveView()'),
    )
    expect(dashboardHtml).toContain("state.activeView === 'publish' && state.otaDirty")

    expect(dashboardHtml).toContain('providerModelRequestEpoch')
    expect(dashboardHtml).toContain('providerModelFingerprint(form)')
    expect(dashboardHtml).toContain("named(form, 'kind').value")
    expect(dashboardHtml).toContain("named(form, 'providerId').value")
    expect(dashboardHtml).toContain("named(form, 'endpoint').value.trim()")
    expect(dashboardHtml.match(/requestEpoch !== state\.providerModelRequestEpoch/g)).toHaveLength(
      2,
    )

    expect(dashboardHtml).toContain("window.addEventListener('beforeunload'")
    expect(dashboardHtml).toContain("event.returnValue = ''")
    expect(dashboardHtml).toContain('return state.mutationLocks.size > 0')
    expect(dashboardHtml).toContain("if (view !== 'account') clearOwnPasswordForm()")
    expect(dashboardHtml).toContain('window.__ECHO_PANEL__.userEmail')
  })

  it('blocks lifecycle changes around writes and exposes refresh, diagnostic, and focus state', async () => {
    const dashboardHtml = await (await panelApp().fetch(panelRequest())).text()

    const signoutHandler = dashboardHtml.slice(
      dashboardHtml.indexOf("$('#cmd-signout').addEventListener"),
      dashboardHtml.indexOf('// ===== 启动 ====='),
    )
    expect(signoutHandler).toContain("blockDuringMutation($('#global-status'))")
    expect(signoutHandler).toContain('headers: { [adminActorHeader]: pageActorUserId }')
    expect(signoutHandler).not.toContain('不能退出管理台')
    expect(signoutHandler).not.toContain('clearPendingQuotaOperation')

    const otaAction = dashboardHtml.slice(
      dashboardHtml.indexOf('async function runOtaRecordAction'),
      dashboardHtml.indexOf('function otaActionReachedTarget'),
    )
    expect(otaAction).toContain("blockDuringMutation($('#ota-result'))")

    const selectedUserClearStart = dashboardHtml.indexOf(
      "$('#selected-user-clear').addEventListener",
    )
    const selectedUserClear = dashboardHtml.slice(
      selectedUserClearStart,
      dashboardHtml.indexOf("$$('[data-user-task]')", selectedUserClearStart),
    )
    expect(selectedUserClear).toContain("blockDuringMutation($('#user-list-summary'))")
    expect(selectedUserClear).toContain('hasPendingQuotaOperation()')

    expect(dashboardHtml).toContain("show($('#global-status'), loaded ? '当前模块已刷新。'")
    expect(dashboardHtml).toContain(
      "card.querySelector('.cu-status').textContent = '失败：' + message",
    )
    expect(dashboardHtml).toContain('--faint: #83899e;')
    expect(dashboardHtml).toContain('formId: form && form.id')
    expect(dashboardHtml).toContain("form.querySelectorAll('button, input, select, textarea')")
    expect(dashboardHtml).toContain('closeTaskPanel(panel.id, true)')
    expect(dashboardHtml).toContain("resource.status === 'loading'")
    expect(dashboardHtml).toContain(
      'if (draftPanel) openTaskPanel(draftPanel, document.activeElement)',
    )
  })
})

function panelApp() {
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
  return createApp({
    env,
    sessionVerifier: createStaticSessionVerifier({ 'panel-contract-token': owner }),
    services: {
      ...testServices(env),
      admin: createAdminService(adminStore),
    },
  })
}

function panelRequest(): Request {
  return request('/echo-panel/', {
    headers: { authorization: 'Bearer panel-contract-token' },
  })
}

function nonceFromCsp(value: string | null): string {
  return value?.match(/script-src 'nonce-([^']+)'/)?.[1] ?? ''
}
