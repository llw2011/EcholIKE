export type PipelineErrorPayload =
  | string
  | {
      code: string
      details?: string
      retry_count?: number
    }

export type CapsuleErrorKey =
  | 'stt_timeout'
  | 'stt_invalid_key'
  | 'stt_failed'
  | 'stt_quota_exceeded'
  | 'stt_no_speech_detected'
  | 'output_fallback_clipboard'
  | 'output_wayland_unsupported'
  | 'llm_failed'
  | 'llm_quota_exceeded'
  | 'accessibility_required'
  | 'backend_auth_required'
  | 'backend_auth_expired'
  | 'backend_auth_changed'
  | 'backend_policy_stale'
  | 'backend_stt_unavailable'
  | 'config_unavailable'
  | 'stt_not_configured'
  | 'stt_connection_failed'
  | 'audio_failed'
  | 'audio_no_frames'
  | 'audio_silent'
  | 'audio_overrun'
  | 'output_failed'
  | 'unknown'

const structuredCapsuleErrorKeys = new Set<CapsuleErrorKey>([
  'stt_timeout',
  'stt_invalid_key',
  'stt_failed',
  'stt_quota_exceeded',
  'stt_no_speech_detected',
  'output_fallback_clipboard',
  'output_wayland_unsupported',
  'llm_failed',
  'llm_quota_exceeded',
  'backend_auth_required',
  'backend_auth_expired',
  'backend_auth_changed',
  'backend_policy_stale',
  'backend_stt_unavailable',
  'config_unavailable',
  'audio_failed',
  'audio_no_frames',
  'audio_silent',
  'audio_overrun',
])

function isStructuredCapsuleErrorKey(code: string): code is CapsuleErrorKey {
  return structuredCapsuleErrorKeys.has(code as CapsuleErrorKey)
}

export function capsuleErrorKeyFromPayload(payload: PipelineErrorPayload): CapsuleErrorKey {
  if (typeof payload !== 'string') {
    return isStructuredCapsuleErrorKey(payload.code) ? payload.code : 'unknown'
  }

  const normalized = payload.trim().toLowerCase()

  if (payload === 'ACCESSIBILITY_REQUIRED') {
    return 'accessibility_required'
  }

  if (
    normalized.includes('api key is not configured') ||
    normalized.includes('not configured') ||
    normalized.includes('missing base url') ||
    normalized.includes('missing base url or model') ||
    normalized.includes('configuration failed')
  ) {
    return 'stt_not_configured'
  }

  if (normalized.includes('quota')) {
    return normalized.includes('llm') || normalized.includes('ai')
      ? 'llm_quota_exceeded'
      : 'stt_quota_exceeded'
  }

  if (
    normalized.includes('auth error') ||
    normalized.includes('invalid key') ||
    normalized.includes('401') ||
    normalized.includes('403')
  ) {
    return 'stt_invalid_key'
  }

  if (normalized.includes('no speech')) {
    return 'stt_no_speech_detected'
  }

  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'stt_timeout'
  }

  if (normalized.includes('audio capture failed')) {
    return 'audio_failed'
  }

  if (normalized.includes('output failed')) {
    return 'output_failed'
  }

  if (normalized.includes('stt connection failed') || normalized.includes('connection failed')) {
    return 'stt_connection_failed'
  }

  if (normalized.includes('llm') || normalized.includes('polish')) {
    return 'llm_failed'
  }

  if (normalized.includes('stt') || normalized.includes('speech')) {
    return 'stt_failed'
  }

  return 'unknown'
}

const capsuleErrorMessages: Record<CapsuleErrorKey, string> = {
  stt_timeout: '语音识别超时',
  stt_invalid_key: '检查语音识别设置',
  stt_failed: '语音识别失败',
  stt_quota_exceeded: '语音额度已用完',
  stt_no_speech_detected: '未听到语音',
  output_fallback_clipboard: '已复制',
  output_wayland_unsupported: '已复制',
  llm_failed: '润色失败',
  llm_quota_exceeded: 'AI 额度已用完',
  accessibility_required: '请开启辅助功能权限',
  backend_auth_required: '请先登录授权',
  backend_auth_expired: '请重新登录授权',
  backend_auth_changed: '授权已更新，请重新开始',
  backend_policy_stale: '请刷新网络服务状态',
  backend_stt_unavailable: '后台语音识别暂不可用',
  config_unavailable: '无法读取应用配置',
  stt_not_configured: '语音识别未配置',
  stt_connection_failed: '无法连接语音识别服务',
  audio_failed: '无法使用麦克风',
  audio_no_frames: '未收到麦克风音频',
  audio_silent: '麦克风没有声音',
  audio_overrun: '录音数据处理不过来',
  output_failed: '无法输入文字',
  unknown: '操作未完成',
}

export function capsuleErrorText(key: CapsuleErrorKey) {
  return capsuleErrorMessages[key] ?? capsuleErrorMessages.unknown
}
