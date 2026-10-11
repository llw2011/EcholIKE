import { describe, expect, it } from 'vitest'
import {
  completeSettingsConnectionTransition,
  completeSettingsModelsTransition,
  createInitialSettingsState,
  createSettingsNotice,
  dismissSettingsNoticeTransition,
  finishSettingsAuthTransition,
  markSettingsNoticeSeenTransition,
  settingsConnectionServiceForOperation,
  settingsDiagnosticKindForOperation,
  startSettingsConnectionTransition,
  startSettingsDiagnosticsTransition,
  startSettingsOperationTransition,
} from '../appStore.settings'
import { getState, setupAppStoreTestLifecycle, useAppStore } from './appStoreTestHarness'

describe('appStore settings transitions', () => {
  it('creates independent initial settings state objects', () => {
    const first = createInitialSettingsState()
    const second = createInitialSettingsState()

    expect(first).toEqual(second)
    expect(first.settingsNotices).not.toBe(second.settingsNotices)
    expect(first.settingsConnectionOutcomes).not.toBe(second.settingsConnectionOutcomes)
    expect(first.settingsDiagnosticsOutcome).not.toBe(second.settingsDiagnosticsOutcome)
    expect(first.llmModels).not.toBe(second.llmModels)
  })

  it('creates, marks, and dismisses scoped notices without accepting stale identities', () => {
    const notice = createSettingsNotice(7, 'stt', 'error', 'failed')
    const notices = { stt: notice }

    expect(markSettingsNoticeSeenTransition(notices, 'stt', 6, 1000, 9000)).toBeNull()
    const seen = markSettingsNoticeSeenTransition(notices, 'stt', 7, 1000, 9000)
    expect(seen?.settingsNotices.stt).toEqual({
      ...notice,
      seenAt: 1000,
      expiresAt: 9000,
    })
    expect(dismissSettingsNoticeTransition(notices, 'stt', 6)).toBeNull()
    expect(dismissSettingsNoticeTransition(notices, 'stt', 7)).toEqual({ settingsNotices: {} })
  })

  it('keeps operation, connection, and diagnostic start patches separate', () => {
    const initial = createInitialSettingsState()
    initial.settingsNotices['backend-auth'] = createSettingsNotice(
      1,
      'backend-auth',
      'error',
      'old auth',
    )
    initial.settingsNotices['managed-config'] = createSettingsNotice(
      2,
      'managed-config',
      'error',
      'old config',
    )

    expect(
      startSettingsOperationTransition(
        initial.settingsNotices,
        'auth-login',
        11,
        '2026-08-29T00:00:00.000Z',
      ),
    ).toEqual({
      settingsOperation: {
        kind: 'auth-login',
        leaseId: 11,
        startedAt: '2026-08-29T00:00:00.000Z',
      },
      settingsNotices: {},
    })
    expect(settingsConnectionServiceForOperation('llm-test')).toBe('llm')
    expect(settingsConnectionServiceForOperation('models-load')).toBeNull()
    expect(
      startSettingsConnectionTransition(initial.settingsConnectionOutcomes, 'llm')
        .settingsConnectionOutcomes.llm,
    ).toEqual({ status: 'running', service: 'llm', result: null, latencyMs: null })
    expect(settingsDiagnosticKindForOperation('combined-diagnostic')).toBe('combined')
    const previousTts = {
      ok: true,
      stage: 'complete',
      message: 'tts ok',
      elapsedMs: 1,
    }
    const previousPdf = {
      ok: true,
      stage: 'complete',
      message: 'pdf ok',
      elapsedMs: 2,
      fileName: 'sample.pdf',
    }
    expect(
      startSettingsDiagnosticsTransition(
        {
          kind: 'pdf',
          tts: previousTts,
          pdf: previousPdf,
          pdfFile: null,
        },
        'tts',
      ).settingsDiagnosticsOutcome,
    ).toEqual({ kind: 'tts', tts: null, pdf: previousPdf, pdfFile: null })
  })

  it('completes connection and model operations as single multi-field patches', () => {
    const initial = createInitialSettingsState()
    const infoNotice = createSettingsNotice(3, 'ocr', 'info', 'partial')
    expect(
      completeSettingsConnectionTransition(
        initial.settingsConnectionOutcomes,
        initial.settingsNotices,
        'ocr',
        'image only',
        25,
        infoNotice,
      ),
    ).toEqual({
      settingsOperation: null,
      settingsConnectionOutcomes: {
        ...initial.settingsConnectionOutcomes,
        ocr: { status: 'success', service: 'ocr', result: 'image only', latencyMs: 25 },
      },
      settingsNotices: { ocr: infoNotice },
    })

    const modelNotice = createSettingsNotice(4, 'text-ai', 'info', 'empty')
    expect(completeSettingsModelsTransition(initial.settingsNotices, [], modelNotice)).toEqual({
      settingsOperation: null,
      llmModels: [],
      settingsNotices: { 'text-ai': modelNotice },
    })
    expect(
      finishSettingsAuthTransition(
        { 'managed-config': createSettingsNotice(5, 'managed-config', 'error', 'old') },
        createSettingsNotice(6, 'backend-auth', 'success', 'connected'),
      ),
    ).toEqual({
      settingsOperation: null,
      settingsNotices: {
        'backend-auth': createSettingsNotice(6, 'backend-auth', 'success', 'connected'),
      },
    })
  })
})

describe('appStore', () => {
  setupAppStoreTestLifecycle()

  describe('Settings operation ownership', () => {
    it('starts idle and atomically admits only one concrete operation kind', () => {
      expect(getState().settingsOperation).toBeNull()

      const leaseId = getState().tryStartSettingsOperation('stt-test')

      expect(leaseId).not.toBeNull()
      expect(getState().settingsOperation).toMatchObject({ kind: 'stt-test', leaseId })
      expect(getState().tryStartSettingsOperation('models-load')).toBeNull()
      expect(getState().settingsOperation).toMatchObject({ kind: 'stt-test', leaseId })
    })

    it('preserves the staged operation then connection snapshots and one-shot completion patch', () => {
      const snapshots: Array<{
        operation: string | null
        status: string
        notice: string | null
      }> = []
      const unsubscribe = useAppStore.subscribe((state) => {
        snapshots.push({
          operation: state.settingsOperation?.kind ?? null,
          status: state.settingsConnectionOutcomes.stt.status,
          notice: state.settingsNotices.stt?.text ?? null,
        })
      })

      const leaseId = getState().tryStartSettingsOperation('stt-test') ?? -1
      expect(snapshots).toEqual([
        { operation: 'stt-test', status: 'idle', notice: null },
        { operation: 'stt-test', status: 'running', notice: null },
      ])

      snapshots.length = 0
      getState().failSettingsConnection(leaseId, 'stt', 'failed')
      unsubscribe()
      expect(snapshots).toEqual([{ operation: null, status: 'error', notice: 'failed' }])
    })

    it('only lets the matching lease release the current owner', () => {
      const first = getState().tryStartSettingsOperation('auth-login') ?? -1
      getState().finishSettingsOperation(first)
      const second = getState().tryStartSettingsOperation('quota-refresh') ?? -1

      getState().finishSettingsOperation(first)

      expect(getState().settingsOperation).toMatchObject({
        kind: 'quota-refresh',
        leaseId: second,
      })
      getState().finishSettingsOperation(second)
      expect(getState().settingsOperation).toBeNull()
    })

    it('keeps the initial process state idle after a runtime acquisition', () => {
      getState().tryStartSettingsOperation('combined-diagnostic')

      expect(useAppStore.getInitialState().settingsOperation).toBeNull()
    })

    it('publishes one scoped auth or sync notice and rejects stale completion', () => {
      const authLease = getState().tryStartSettingsOperation('auth-login') ?? -1
      expect(getState().settingsOperation).toMatchObject({ kind: 'auth-login' })
      getState().completeSettingsAuth(authLease, '后台授权已连接。')
      expect(getState().settingsNotices['backend-auth']).toMatchObject({
        phase: 'success',
        text: '后台授权已连接。',
      })

      const syncLease = getState().tryStartSettingsOperation('quota-refresh') ?? -1
      getState().failSettingsAuth(authLease, 'late auth error')
      expect(getState().settingsOperation).toMatchObject({ leaseId: syncLease })
      expect(getState().settingsNotices['backend-auth']).toBeUndefined()
      getState().completeSettingsSync(syncLease, 'quota', '全部服务额度已刷新。')
      expect(getState().settingsNotices['backend-auth']).toMatchObject({
        phase: 'success',
        text: '全部服务额度已刷新。',
      })
      const nextAuthLease = getState().tryStartSettingsOperation('auth-login') ?? -1
      getState().failSettingsSync(syncLease, 'quota', 'late sync error')
      expect(getState().settingsOperation).toMatchObject({ leaseId: nextAuthLease })
      expect(getState().settingsNotices['backend-auth']).toBeUndefined()
    })

    it('starts settings feedback empty in a fresh process', () => {
      expect(useAppStore.getInitialState().settingsNotices).toEqual({})
    })

    it('owns one unseen notice per visual settings scope and guards replacement from old timers', () => {
      getState().publishSettingsNotice('stt', 'error', 'STT connection failed')

      const first = getState().settingsNotices.stt
      expect(first).toMatchObject({
        phase: 'error',
        text: 'STT connection failed',
        seenAt: null,
        expiresAt: null,
      })
      if (!first) throw new Error('Expected STT settings notice')
      getState().markSettingsNoticeSeen('stt', first.id, 1000)
      expect(getState().settingsNotices.stt).toMatchObject({
        id: first.id,
        seenAt: 1000,
        expiresAt: 9000,
      })

      const replacementId = getState().publishSettingsNotice('stt', 'error', 'new failure')
      getState().dismissSettingsNotice('stt', first.id)
      expect(getState().settingsNotices.stt).toMatchObject({
        id: replacementId,
        text: 'new failure',
      })
    })

    it('keeps ordinary successful connection and model facts in outcomes without transient notices', () => {
      const sttLease = getState().tryStartSettingsOperation('stt-test') ?? -1
      getState().completeSettingsConnection(sttLease, 'stt', '123ms', 123)
      expect(getState().settingsConnectionOutcomes.stt).toMatchObject({
        status: 'success',
        result: '123ms',
        latencyMs: 123,
      })
      expect(getState().settingsNotices.stt).toBeUndefined()

      const modelLease = getState().tryStartSettingsOperation('models-load') ?? -1
      getState().completeSettingsModels(modelLease, ['model-a'], '读取到 1 个模型。')
      expect(getState().llmModels).toEqual(['model-a'])
      expect(getState().settingsNotices['text-ai']).toBeUndefined()

      const partialLease = getState().tryStartSettingsOperation('ocr-test') ?? -1
      getState().completeSettingsConnection(
        partialLease,
        'ocr',
        '图片识别可用，PDF 文档管线不可用',
        25,
        'info',
      )
      expect(getState().settingsNotices.ocr).toMatchObject({
        phase: 'info',
        text: expect.stringContaining('图片识别可用，PDF 文档管线不可用'),
      })
    })

    it('owns managed-cache cleanup with the existing settings lease and auth notice', () => {
      expect(getState().desktopAuthToken).toBeNull()
      getState().setDesktopAuthToken('desktop-token')
      expect(getState().desktopAuthToken).toBe('desktop-token')

      const leaseId = getState().tryStartSettingsOperation('auth-cache-clear') ?? -1
      getState().completeSettingsAuth(leaseId, '后台授权已取消，托管配置缓存已清理。', 'info')

      expect(getState().settingsNotices['backend-auth']).toMatchObject({
        phase: 'info',
        text: '后台授权已取消，托管配置缓存已清理。',
      })
      expect(getState().settingsOperation).toBeNull()
      getState().setDesktopAuthToken(null)
      expect(getState().desktopAuthToken).toBeNull()
    })

    it('authenticates only a user bootstrap paired with the current token identity', () => {
      const authenticatedBootstrap = {
        schemaVersion: 1,
        generatedAt: '2026-07-30T00:00:00.000Z',
        apiBaseUrl: 'https://example.test/echo-api',
        user: {
          email: 'user@example.com',
          name: null,
          plan: 'pro' as const,
          subscriptionEnd: null,
        },
      }

      getState().setDesktopAuthToken('session-a')
      expect(getState().desktopAuthStatus).toBe('unknown')
      expect(
        getState().acceptDesktopBootstrap(
          { ...authenticatedBootstrap, user: undefined },
          'session-a',
        ),
      ).toBe(false)
      expect(getState().desktopAuthStatus).toBe('unknown')

      expect(getState().acceptDesktopBootstrap(authenticatedBootstrap, 'session-a')).toBe(true)
      expect(getState().desktopAuthStatus).toBe('authenticated')
      expect(getState().desktopBootstrapAuthToken).toBe('session-a')

      getState().setDesktopAuthToken('session-b')
      expect(getState().desktopAuthStatus).toBe('unknown')
      expect(getState().desktopBootstrapAuthToken).toBeNull()
      expect(getState().rejectDesktopAuthToken('session-a')).toBe(false)
      expect(getState().desktopAuthToken).toBe('session-b')
      expect(getState().rejectDesktopAuthToken('session-b')).toBe(true)
      expect(getState().desktopAuthToken).toBeNull()
      expect(getState().desktopAuthStatus).toBe('rejected')
      expect(getState().desktopBootstrap).toBeNull()
    })

    it('lets an auth attempt supersede an obsolete managed-config notice', () => {
      getState().publishSettingsNotice('managed-config', 'error', 'login first')

      const leaseId = getState().tryStartSettingsOperation('auth-login') ?? -1
      getState().failSettingsAuth(leaseId, 'bad credentials')

      expect(getState().settingsNotices['managed-config']).toBeUndefined()
      expect(getState().settingsNotices['backend-auth']).toMatchObject({
        phase: 'error',
        text: 'bad credentials',
      })
    })

    it('keeps connection data and publishes model/proxy feedback without duplicate outcomes', () => {
      const connectionLease = getState().tryStartSettingsOperation('stt-test') ?? -1
      expect(getState().settingsConnectionOutcomes.stt.status).toBe('running')
      getState().completeSettingsConnection(connectionLease, 'stt', '123ms', 123)
      expect(getState().settingsConnectionOutcomes.stt).toMatchObject({
        status: 'success',
        service: 'stt',
        latencyMs: 123,
      })

      const modelLease = getState().tryStartSettingsOperation('models-load') ?? -1
      getState().failSettingsConnection(connectionLease, 'stt', 'late')
      expect(getState().settingsOperation?.leaseId).toBe(modelLease)
      getState().completeSettingsModels(modelLease, ['model-a'], '读取到 1 个模型。')
      expect(getState().llmModels).toEqual(['model-a'])

      const proxyLease = getState().tryStartSettingsOperation('system-proxy') ?? -1
      getState().completeSettingsProxy(proxyLease, '已使用系统代理')
      expect(getState().settingsNotices['network-proxy']).toMatchObject({
        phase: 'success',
        text: '已使用系统代理',
      })
    })

    it('holds a combined diagnostic lease across intermediate TTS and PDF results', () => {
      const leaseId = getState().tryStartSettingsOperation('combined-diagnostic') ?? -1
      getState().setSettingsDiagnosticPdfFile(leaseId, {
        fileName: 'sample.pdf',
        mimeType: 'application/pdf',
        fileBase64: 'cGRm',
        inputBytes: 3,
      })
      getState().updateSettingsDiagnosticTts(leaseId, {
        ok: true,
        stage: 'complete',
        httpStatus: 200,
        code: null,
        message: 'tts ok',
        requestId: null,
        mimeType: 'audio/mpeg',
        audioBytes: 3,
        elapsedMs: 1,
      })
      expect(getState().settingsOperation?.leaseId).toBe(leaseId)
      getState().updateSettingsDiagnosticPdf(leaseId, {
        ok: true,
        stage: 'complete',
        message: 'pdf ok',
        pageCount: 1,
        inputBytes: 3,
        elapsedMs: 2,
        fileName: 'sample.pdf',
      })
      expect(getState().settingsOperation?.leaseId).toBe(leaseId)
      getState().completeSettingsDiagnostics(leaseId)
      expect(getState().settingsOperation).toBeNull()
      expect(getState().settingsDiagnosticsOutcome).toMatchObject({
        kind: 'combined',
        tts: { message: 'tts ok' },
        pdf: { message: 'pdf ok' },
      })
    })
  })
})
