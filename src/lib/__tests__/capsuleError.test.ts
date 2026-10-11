import { describe, expect, it } from 'vitest'
import { capsuleErrorKeyFromPayload, capsuleErrorText, type CapsuleErrorKey } from '../capsuleError'

describe('capsuleErrorKeyFromPayload', () => {
  it('keeps structured STT quota errors short', () => {
    expect(
      capsuleErrorKeyFromPayload({
        code: 'stt_quota_exceeded',
        details: 'limit hit',
        retry_count: 0,
      }),
    ).toBe('stt_quota_exceeded')
  })

  it('keeps structured LLM quota errors short', () => {
    expect(
      capsuleErrorKeyFromPayload({
        code: 'llm_quota_exceeded',
        details: 'limit hit',
        retry_count: 0,
      }),
    ).toBe('llm_quota_exceeded')
  })

  it.each([
    ['backend_auth_required', 'backend_auth_required'],
    ['backend_auth_expired', 'backend_auth_expired'],
    ['backend_auth_changed', 'backend_auth_changed'],
    ['backend_policy_stale', 'backend_policy_stale'],
    ['backend_stt_unavailable', 'backend_stt_unavailable'],
  ] as const)('keeps structured backend STT preflight error %s', (code, expected) => {
    expect(capsuleErrorKeyFromPayload({ code, retry_count: 0 })).toBe(expected)
  })

  it.each([
    'config_unavailable',
    'audio_failed',
    'audio_no_frames',
    'audio_silent',
    'audio_overrun',
  ] as const)('keeps structured microphone error %s distinct', (code) => {
    expect(capsuleErrorKeyFromPayload({ code, retry_count: 0 })).toBe(code)
  })

  it('maps missing STT setup strings to a setup label', () => {
    expect(
      capsuleErrorKeyFromPayload(
        'STT API key is not configured. Please set it in Settings -> Speech Recognition.',
      ),
    ).toBe('stt_not_configured')
  })

  it('maps custom Whisper setup strings to a setup label', () => {
    expect(capsuleErrorKeyFromPayload('Local / Custom Whisper is missing base URL or model')).toBe(
      'stt_not_configured',
    )
  })

  it('maps accessibility errors to the short permission label', () => {
    expect(capsuleErrorKeyFromPayload('ACCESSIBILITY_REQUIRED')).toBe('accessibility_required')
  })

  it('maps output failures to a short output label', () => {
    expect(capsuleErrorKeyFromPayload('Output failed: permission denied')).toBe('output_failed')
  })

  it('falls back safely for unknown structured errors', () => {
    expect(
      capsuleErrorKeyFromPayload({
        code: 'new_backend_error',
        retry_count: 0,
      }),
    ).toBe('unknown')
  })

  it.each<[CapsuleErrorKey, string]>([
    ['stt_timeout', '语音识别超时'],
    ['stt_invalid_key', '检查语音识别设置'],
    ['stt_failed', '语音识别失败'],
    ['stt_quota_exceeded', '语音额度已用完'],
    ['stt_not_configured', '语音识别未配置'],
    ['stt_connection_failed', '无法连接语音识别服务'],
    ['audio_failed', '无法使用麦克风'],
    ['audio_no_frames', '未收到麦克风音频'],
    ['audio_silent', '麦克风没有声音'],
    ['audio_overrun', '录音数据处理不过来'],
    ['output_failed', '无法输入文字'],
    ['accessibility_required', '请开启辅助功能权限'],
    ['backend_auth_required', '请先登录授权'],
    ['backend_auth_expired', '请重新登录授权'],
    ['backend_auth_changed', '授权已更新，请重新开始'],
    ['backend_policy_stale', '请刷新网络服务状态'],
    ['backend_stt_unavailable', '后台语音识别暂不可用'],
    ['config_unavailable', '无法读取应用配置'],
    ['llm_quota_exceeded', 'AI 额度已用完'],
    ['unknown', '操作未完成'],
  ])('shows a short user-facing message for %s', (key, message) => {
    expect(capsuleErrorText(key)).toBe(message)
    expect(capsuleErrorText(key)).not.toMatch(/STT|LLM|output|failed|error/i)
  })
})
