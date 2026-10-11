import { useEffect, useState } from 'react'
import { DESKTOP_BOOTSTRAP_URL } from '../../lib/branding'
import { isDesktopAuthSessionAuthenticated, readDesktopAuthToken } from '../../lib/desktopAuth'
import {
  applyDesktopBootstrapResponse,
  authenticatedDesktopToken,
  beginDesktopAuthLogin,
  beginDesktopAuthRequest,
  captureDesktopAuthLoginExpectation,
  clearCurrentDesktopAuth,
  handleDesktopBootstrapFailure,
  type DesktopAuthRequestContext,
} from '../../lib/desktopAuthRuntime'
import { backendAuthSignIn, fetchDesktopBootstrap, type DesktopBootstrap } from '../../lib/tauri'
import type { ErrorContext } from '../../lib/userErrors'
import { useAppStore } from '../../stores/appStore'

type SettingsErrorMessage = (error: unknown, fallback: string, context?: ErrorContext) => string

type UseBackendAccountOptions = {
  appVersion: string
  backendManaged: boolean
  settingsErrorMessage: SettingsErrorMessage
}

function formatBackendAccountLevel(user: DesktopBootstrap['user'] | undefined) {
  if (!user) return '等级待同步'
  const plan = user.plan === 'pro' ? 'Pro' : 'Free'
  const quotaLevel =
    typeof user.quotaLevel === 'number' && Number.isFinite(user.quotaLevel)
      ? `Lv.${user.quotaLevel}`
      : null
  const quotaMultiplier =
    typeof user.quotaMultiplier === 'number' && Number.isFinite(user.quotaMultiplier)
      ? `${user.quotaMultiplier}x 月额度`
      : null
  return [plan, quotaLevel, quotaMultiplier].filter(Boolean).join(' · ')
}

function desktopAuthSignInUrl() {
  const url = new URL(DESKTOP_BOOTSTRAP_URL, window.location.origin)
  url.pathname = url.pathname.replace(/\/desktop\/bootstrap\/?$/, '/auth/sign-in/email')
  url.search = ''
  return url.toString()
}

function backendAuthErrorMessage(error: unknown, settingsErrorMessage: SettingsErrorMessage) {
  return settingsErrorMessage(error, '后台授权失败。', 'auth')
}

export function useBackendAccount({
  appVersion,
  backendManaged,
  settingsErrorMessage,
}: UseBackendAccountOptions) {
  const [backendAuthEmail, setBackendAuthEmail] = useState('')
  const [backendAuthPassword, setBackendAuthPassword] = useState('')
  const desktopToken = useAppStore((s) => s.desktopAuthToken)
  const setDesktopToken = useAppStore((s) => s.setDesktopAuthToken)
  const desktopAuthStatus = useAppStore((s) => s.desktopAuthStatus)
  const desktopBootstrapAuthToken = useAppStore((s) => s.desktopBootstrapAuthToken)
  const desktopBootstrap = useAppStore((s) => s.desktopBootstrap)
  const tryStartSettingsOperation = useAppStore((s) => s.tryStartSettingsOperation)
  const isCurrentSettingsOperation = useAppStore((s) => s.isCurrentSettingsOperation)
  const completeSettingsAuth = useAppStore((s) => s.completeSettingsAuth)
  const failSettingsAuth = useAppStore((s) => s.failSettingsAuth)
  const completeSettingsSync = useAppStore((s) => s.completeSettingsSync)
  const failSettingsSync = useAppStore((s) => s.failSettingsSync)
  const publishSettingsNotice = useAppStore((s) => s.publishSettingsNotice)
  const dismissSettingsNotice = useAppStore((s) => s.dismissSettingsNotice)

  const visibleDesktopToken = readDesktopAuthToken()?.trim() || ''
  const hasDesktopToken = Boolean(visibleDesktopToken)
  const desktopAuthReady = isDesktopAuthSessionAuthenticated(
    desktopBootstrap,
    visibleDesktopToken,
    desktopAuthStatus,
    desktopBootstrapAuthToken,
  )
  const authorizedBackendEmail = desktopAuthReady
    ? desktopBootstrap?.user?.email?.trim() || ''
    : backendAuthEmail.trim()
  const backendAuthAccountValue = desktopAuthReady ? authorizedBackendEmail : backendAuthEmail
  const backendAuthLevelValue = desktopAuthReady
    ? formatBackendAccountLevel(desktopBootstrap?.user)
    : backendAuthPassword
  const desktopOwner = desktopAuthReady && desktopBootstrap?.user?.adminRole === 'owner'

  useEffect(() => {
    const persistedToken = readDesktopAuthToken()
    if (desktopToken !== persistedToken) setDesktopToken(persistedToken)
  }, [desktopToken, setDesktopToken])

  async function syncDesktopBootstrap(
    options: { requireAuth?: boolean; purpose?: 'auth' | 'config' | 'quota' } = {},
  ) {
    const requiresAuth = options.requireAuth ?? backendManaged
    const quotaRefresh = options.purpose === 'quota'
    const authVerification = options.purpose === 'auth'
    const leaseId = tryStartSettingsOperation(quotaRefresh ? 'quota-refresh' : 'bootstrap-sync')
    if (leaseId === null) return
    let request: DesktopAuthRequestContext | null = null
    try {
      request = await beginDesktopAuthRequest()
      if (!request) {
        if (authVerification && authenticatedDesktopToken()) {
          completeSettingsAuth(leaseId, '已保存的后台授权已重新验证。')
          return
        }
        if (authVerification) {
          failSettingsAuth(leaseId, '已保存的后台授权状态发生变化，请重试。')
        } else {
          failSettingsSync(
            leaseId,
            quotaRefresh ? 'quota' : 'config',
            '后台授权状态已变化，请重试。',
          )
        }
        return
      }
      if (requiresAuth && !request.token) {
        if (authVerification) {
          failSettingsAuth(leaseId, '已保存的后台授权已不存在，请重新登录。')
        } else {
          failSettingsSync(
            leaseId,
            quotaRefresh ? 'quota' : 'config',
            '请先登录授权，再拉取托管配置。',
          )
        }
        return
      }
      const bootstrap = await fetchDesktopBootstrap(
        DESKTOP_BOOTSTRAP_URL,
        appVersion,
        request.token,
      )
      if (!isCurrentSettingsOperation(leaseId)) return
      const result = await applyDesktopBootstrapResponse(bootstrap, request)
      if (!isCurrentSettingsOperation(leaseId)) return
      if (result.kind === 'rejected') {
        failSettingsAuth(leaseId, '后台授权已失效，请重新登录。')
        return
      }
      if (result.kind === 'stale') {
        if (authVerification && authenticatedDesktopToken()) {
          completeSettingsAuth(leaseId, '已保存的后台授权已重新验证。')
          return
        }
        if (authVerification) {
          failSettingsAuth(leaseId, '后台授权在验证期间发生变化，请重试。')
        } else {
          failSettingsSync(
            leaseId,
            quotaRefresh ? 'quota' : 'config',
            '后台授权已更新，本次旧响应已忽略。',
          )
        }
        return
      }
      if (result.kind === 'cache-error') {
        if (authVerification) {
          failSettingsAuth(leaseId, '后台已验证当前授权，但本机授权缓存保存失败，请重试。')
        } else {
          failSettingsSync(
            leaseId,
            quotaRefresh ? 'quota' : 'config',
            '托管身份缓存保存失败，本次结果未启用，请重试。',
          )
        }
        return
      }
      if (requiresAuth && result.kind !== 'authenticated') {
        failSettingsAuth(leaseId, '后台授权未通过验证，请重新登录。')
        return
      }
      if (authVerification) {
        completeSettingsAuth(leaseId, '已保存的后台授权已重新验证。')
        return
      }
      const currentSource = useAppStore.getState().config.config_source
      completeSettingsSync(
        leaseId,
        quotaRefresh ? 'quota' : 'config',
        quotaRefresh
          ? '全部服务额度已刷新。'
          : currentSource === 'backend'
            ? '账号配置已同步。'
            : '后台状态已刷新，本机配置仍生效。',
      )
    } catch (error) {
      const rejected = request ? await handleDesktopBootstrapFailure(error, request) : false
      if (!isCurrentSettingsOperation(leaseId)) return
      if (rejected) {
        failSettingsAuth(leaseId, '后台授权已失效，请重新登录。')
        return
      }
      const message = settingsErrorMessage(
        error,
        authVerification
          ? '已保存的后台授权验证失败。'
          : quotaRefresh
            ? '服务额度刷新失败。'
            : '后台配置同步失败。',
        'settings',
      )
      if (authVerification) failSettingsAuth(leaseId, message)
      else failSettingsSync(leaseId, quotaRefresh ? 'quota' : 'config', message)
    }
  }

  async function signInBackend() {
    const email = backendAuthEmail.trim()
    const password = backendAuthPassword
    if (!email || !password) {
      publishSettingsNotice('backend-auth', 'error', '请填写后台账号和密码。')
      return
    }

    const leaseId = tryStartSettingsOperation('auth-login')
    if (leaseId === null) return
    let loginExpectation: Awaited<ReturnType<typeof captureDesktopAuthLoginExpectation>>
    try {
      loginExpectation = await captureDesktopAuthLoginExpectation()
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      failSettingsAuth(leaseId, settingsErrorMessage(error, '本机授权状态读取失败。'))
      return
    }
    if (!isCurrentSettingsOperation(leaseId)) return
    let token: string
    try {
      const auth = await backendAuthSignIn(desktopAuthSignInUrl(), email, password)
      token = auth.token
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      const message = backendAuthErrorMessage(error, settingsErrorMessage)
      failSettingsAuth(leaseId, message)
      return
    }
    if (!isCurrentSettingsOperation(leaseId)) return

    let request: DesktopAuthRequestContext | null
    try {
      request = await beginDesktopAuthLogin(token, loginExpectation)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      failSettingsAuth(leaseId, settingsErrorMessage(error, '本机授权状态保存失败。'))
      return
    }
    if (!isCurrentSettingsOperation(leaseId)) return
    if (!request) {
      failSettingsAuth(leaseId, '登录状态已变化，请重试。')
      return
    }
    setBackendAuthPassword('')

    let bootstrap: DesktopBootstrap
    try {
      bootstrap = await fetchDesktopBootstrap(DESKTOP_BOOTSTRAP_URL, appVersion, request.token)
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      if (await handleDesktopBootstrapFailure(error, request)) {
        failSettingsAuth(leaseId, backendAuthErrorMessage(error, settingsErrorMessage))
        return
      }
      completeSettingsAuth(
        leaseId,
        `登录凭据已保存，托管身份待同步：${settingsErrorMessage(error, '后台配置同步失败。', 'settings')}`,
        'info',
      )
      return
    }

    if (!isCurrentSettingsOperation(leaseId)) return
    const result = await applyDesktopBootstrapResponse(bootstrap, request)
    if (!isCurrentSettingsOperation(leaseId)) return
    if (result.kind === 'rejected') {
      failSettingsAuth(leaseId, '后台授权已失效，请重新登录。')
      return
    }
    if (result.kind === 'cache-error') {
      completeSettingsAuth(
        leaseId,
        `登录凭据已保存，但本机授权缓存保存失败：${settingsErrorMessage(result.cacheError, '缓存保存失败。')}`,
        'info',
      )
      return
    }
    if (result.kind !== 'authenticated') {
      failSettingsAuth(leaseId, '登录状态已变化，请使用当前账号重试。')
      return
    }
    const accountEmail = bootstrap.user?.email?.trim() || email
    setBackendAuthEmail(accountEmail)
    completeSettingsAuth(leaseId, '后台授权已连接。')
  }

  async function cancelBackendAuthorization() {
    const leaseId = tryStartSettingsOperation('auth-cache-clear')
    if (leaseId === null) return
    try {
      const result = await clearCurrentDesktopAuth(false)
      if (!isCurrentSettingsOperation(leaseId)) return
      if (result !== 'cleared') {
        failSettingsAuth(
          leaseId,
          result === 'stale'
            ? '授权状态已变化，本次取消未执行。'
            : '本地授权状态清理失败，请重试。',
        )
        return
      }
      setBackendAuthPassword('')
      dismissSettingsNotice('managed-config')
      completeSettingsAuth(leaseId, '后台授权已取消，托管配置缓存已清理。', 'info')
    } catch (error) {
      if (!isCurrentSettingsOperation(leaseId)) return
      failSettingsAuth(
        leaseId,
        `取消授权失败，托管配置缓存未清理：${settingsErrorMessage(error, '请重试。')}`,
      )
    }
  }

  return {
    backendAuthAccountValue,
    backendAuthEmail,
    backendAuthLevelValue,
    backendAuthPassword,
    cancelBackendAuthorization,
    desktopAuthReady,
    desktopAuthStatus,
    desktopBootstrap,
    desktopOwner,
    hasDesktopToken,
    setBackendAuthEmail,
    setBackendAuthPassword,
    signInBackend,
    syncDesktopBootstrap,
    visibleDesktopToken,
  }
}
