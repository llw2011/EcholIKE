export type ApiErrorBody = {
  service?: unknown
  code?: unknown
  message?: unknown
  error?: unknown
  requestId?: unknown
  status?: unknown
  stage?: unknown
}

export type BackendErrorDiagnostic = {
  service: string | null
  status: number | null
  code: string | null
  requestId: string | null
  stage: string | null
}

export type ErrorContext =
  | 'auth'
  | 'general'
  | 'llm'
  | 'ocr'
  | 'settings'
  | 'stt'
  | 'tts'
  | 'update'

type ServiceContext = Extract<ErrorContext, 'llm' | 'ocr' | 'stt' | 'tts'>

export const quotaMessage = '额度不足，请充值。'

const quotaMessages: Record<ServiceContext, string> = {
  llm: quotaMessage,
  ocr: quotaMessage,
  stt: quotaMessage,
  tts: quotaMessage,
}

const serviceDisplayNames: Record<ServiceContext, string> = {
  llm: '文本 AI 服务',
  ocr: 'OCR 服务',
  stt: '语音识别服务',
  tts: '朗读服务',
}

const serviceContexts = new Set<ServiceContext>(['llm', 'ocr', 'stt', 'tts'])

export async function apiErrorFromResponse(
  response: Response,
  fallback: string,
  context: ErrorContext = 'general',
) {
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null
  return new Error(apiErrorMessage(body, fallback, context, response.status))
}

export function apiErrorMessage(
  body: ApiErrorBody | null | undefined,
  fallback: string,
  context: ErrorContext = 'general',
  status?: number,
) {
  const code = typeof body?.code === 'string' ? body.code.trim().toLowerCase() : ''
  const raw = rawApiErrorMessage(body)
  const resolvedStatus =
    typeof status === 'number' && Number.isInteger(status)
      ? status
      : typeof body?.status === 'number' && Number.isInteger(body.status)
        ? body.status
        : undefined
  const byCode = code ? messageFromCode(code, context) : null
  if (byCode) return byCode

  const byRaw = raw ? messageFromRaw(raw, context, resolvedStatus) : null
  if (byRaw) return byRaw

  const byStatus = messageFromStatus(resolvedStatus, context)
  if (byStatus) return byStatus

  if (raw && isUserFriendlyMessage(raw)) return raw
  return fallback
}

export function userFacingErrorMessage(
  error: unknown,
  fallback: string,
  context: ErrorContext = 'general',
) {
  if (error instanceof Error) {
    const structured = structuredErrorFromString(error.message)
    if (structured) return apiErrorMessage(structured.body, fallback, context, structured.status)
    return messageFromRaw(error.message, context) ?? readableFallback(error.message, fallback)
  }
  if (typeof error === 'string') {
    const structured = structuredErrorFromString(error)
    if (structured) return apiErrorMessage(structured.body, fallback, context, structured.status)
    return messageFromRaw(error, context) ?? readableFallback(error, fallback)
  }
  if (error && typeof error === 'object') {
    const record = error as ApiErrorBody
    return apiErrorMessage(record, fallback, context)
  }
  return fallback
}

export function userFacingWarningMessage(warning: unknown, fallback: string) {
  const message =
    warning instanceof Error ? warning.message : typeof warning === 'string' ? warning : ''
  return readableFallback(message, fallback)
}

export function backendErrorDiagnostic(error: unknown): BackendErrorDiagnostic | null {
  let body: ApiErrorBody | null = null
  let parsedStatus: number | undefined
  if (error instanceof Error || typeof error === 'string') {
    const structured = structuredErrorFromString(error instanceof Error ? error.message : error)
    body = structured?.body ?? null
    parsedStatus = structured?.status
  } else if (error && typeof error === 'object' && !Array.isArray(error)) {
    body = error as ApiErrorBody
  }
  if (!body) return null

  const service = diagnosticString(body.service)
  const code = diagnosticString(body.code)
  const requestId = diagnosticString(body.requestId)
  const stage = diagnosticString(body.stage)
  const statusValue = parsedStatus ?? body.status
  const status =
    typeof statusValue === 'number' && Number.isInteger(statusValue) ? statusValue : null
  if (!service && status === null && !code && !requestId && !stage) return null
  return { service, status, code, requestId, stage }
}

export function structuredErrorFromString(
  raw: string,
): { body: ApiErrorBody; status?: number } | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const body = parsed as ApiErrorBody
    const hasKnownField =
      typeof body.code === 'string' ||
      typeof body.message === 'string' ||
      typeof body.error === 'string'
    if (!hasKnownField) return null
    const status = typeof body.status === 'number' ? body.status : undefined
    return { body, status }
  } catch {
    return null
  }
}

function diagnosticString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function rawApiErrorMessage(body: ApiErrorBody | null | undefined) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  for (const key of ['message', 'error'] as const) {
    const value = body[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function messageFromCode(code: string, context: ErrorContext) {
  switch (code) {
    case 'bad_request':
    case 'validation_failed':
      return '提交内容不符合要求，请检查输入或文件后重试。'
    case 'forbidden':
      return '当前账号没有使用该功能的权限，请联系管理员确认授权。'
    case 'internal_error':
      return '后台服务暂时不可用，请稍后重试。'
    case 'idempotency_key_invalid':
      return '当前客户端无法安全恢复这次请求，请更新客户端后重试。'
    case 'idempotency_conflict':
      return '恢复信息与本次内容不一致，已停止请求。请重新发起；本次未重复扣费。'
    case 'operation_in_progress':
      return '服务仍在确认本次结果，请稍候再试。系统不会重复扣费。'
    case 'operation_stale':
      return '本次操作已由新的重试接管，请稍候查看结果。'
    case 'operation_result_expired':
      return '上次操作已按一次计费，系统没有再次扣费，但结果副本已过期。若重新发起，将作为一次新操作计费。'
    case 'method_not_allowed':
      return '当前客户端与后台服务不匹配，请检查是否需要更新。'
    case 'not_found':
      return '后台没有找到对应资源，请刷新后重试。'
    case 'not_implemented':
      return '后台暂未启用这个服务，请联系管理员完成配置。'
    case 'ocr_document_invalid':
      return '无法读取这份 PDF，请确认文件未损坏、未加密，然后重试。'
    case 'ocr_document_page_limit':
      return '这份 PDF 超过当前一次最多 20 页的处理上限。请拆分后重试。'
    case 'ocr_document_no_text':
      return '这份 PDF 没有提取到可用文字，请确认文档内容后重试。'
    case 'ocr_pipeline_unavailable':
      return '后台 PDF 文档识别暂时不可用，请稍后重试。'
    case 'ocr_cancelled':
      return 'PDF 识别已取消。'
    case 'payload_too_large':
      return '提交内容太大，请缩短内容或换一个更小的文件。'
    case 'rate_limited':
      return '请求太频繁，请稍等一会儿再试。'
    case 'stt_no_speech_detected':
      return '没有听到可识别的语音，请靠近麦克风后重试。'
    case 'unauthorized':
      return '后台授权已失效，请重新登录。'
    case 'user_already_exists':
      return '这个用户已经存在，请换一个邮箱或直接登录。'
  }

  if (code.endsWith('_quota_exceeded')) {
    const service = serviceFromCode(code) ?? serviceFromContext(context)
    return service ? quotaMessages[service] : quotaMessage
  }
  if (code.endsWith('_invalid_key')) {
    const service = serviceFromCode(code) ?? serviceFromContext(context)
    return service
      ? `${backendServiceDisplayName(service)}配置无效，请联系管理员处理。`
      : '后台服务配置无效，请联系管理员处理。'
  }
  if (code.endsWith('_timeout')) {
    const service = serviceFromCode(code) ?? serviceFromContext(context)
    return service
      ? `${backendServiceDisplayName(service)}响应超时，请稍后重试。`
      : '后台服务响应超时，请稍后重试。'
  }
  if (code.endsWith('_failed') || code === 'provider_failed') {
    const service = serviceFromCode(code) ?? serviceFromContext(context)
    return service
      ? `${backendServiceDisplayName(service)}暂时不可用，请稍后重试；若持续出现，请联系管理员。`
      : '后台服务暂时不可用，请稍后重试；若持续出现，请联系管理员。'
  }

  return null
}

function messageFromRaw(raw: string, context: ErrorContext, status?: number) {
  const message = raw.trim()
  if (!message) return null
  const normalized = message.toLowerCase()

  if (context === 'ocr') {
    const pageLimit = message.match(
      /pdf has\s+(\d+)\s+pages;\s*the current ocr upload limit is\s+(\d+)\s+pages/i,
    )
    if (pageLimit) {
      const actualPages = Number(pageLimit[1])
      const maxPages = Number(pageLimit[2])
      if (Number.isFinite(actualPages) && Number.isFinite(maxPages)) {
        return `这份 PDF 共 ${actualPages} 页，当前一次最多处理 ${maxPages} 页。请拆分后重试。`
      }
    }
  }

  if (/llm quota exceeded|ai quota exceeded/.test(normalized)) return quotaMessages.llm
  if (/ocr quota exceeded/.test(normalized)) return quotaMessages.ocr
  if (/stt quota exceeded|speech quota exceeded/.test(normalized)) return quotaMessages.stt
  if (/tts quota exceeded/.test(normalized)) return quotaMessages.tts
  if (normalized.includes('quota exceeded')) {
    const service = serviceFromContext(context)
    return service ? quotaMessages[service] : quotaMessage
  }

  if (context === 'ocr') {
    if (normalized.includes('another local ocr request is already running')) {
      return '本机 OCR 正在处理另一个任务，请等待当前任务完成。'
    }
    if (normalized.includes('pdf exceeds the 20-page local ocr limit')) {
      return '这份 PDF 超过当前一次最多 20 页的处理上限。请拆分后重试。'
    }
    if (normalized.includes('pdf has no pages')) {
      return '这份 PDF 没有可读取的页面，请重新导出文件后重试。'
    }
    if (normalized.includes('password protected') || normalized.includes('encrypted pdf')) {
      return '无法读取这份 PDF，请先移除密码保护后重试。'
    }
    if (normalized.includes('does not contain a valid pdf signature')) {
      return '上传文件不是有效的 PDF，请重新选择原始文档。'
    }
    if (normalized.includes('not a supported png, jpg, webp, or bmp image')) {
      return '上传文件不是有效的 PNG、JPG、WebP 或 BMP 图片。'
    }
    if (/uploaded (pdf|image).*too large|keep it under 25 mb/.test(normalized)) {
      return '附件超过 25 MB，请压缩或拆分后重试。'
    }
    if (/uploaded (pdf|image) is empty/.test(normalized)) {
      return '附件内容为空，请重新选择文件。'
    }
    if (normalized.includes('base64 decode failed')) {
      return '附件内容无法读取，请重新选择原始文件。'
    }
    if (normalized.includes('unsupported ocr file type')) {
      return '暂只支持 PNG、JPG、WebP、BMP 图片和 PDF 文件。'
    }
    if (/model .*not found|not found.*model|ollama model is unavailable/.test(normalized)) {
      return '没有找到当前 OCR 模型，请在设置里换一个可用模型，或先在本机拉取该模型。'
    }
    if (normalized.includes('vision router is not installed')) {
      return '本机图片识别组件未安装；PDF 文档识别可能仍可使用。'
    }
    if (normalized.includes('glm-ocr pipeline is not installed')) {
      return '本机 PDF 文档识别组件未安装；截图和图片识别可能仍可使用。'
    }
    if (normalized.includes('requires a loopback ollama address')) {
      return '增强本机 OCR 只允许连接本机 Ollama，请把地址设为 127.0.0.1 或 localhost。'
    }
    if (
      normalized.includes('pipeline pdf json') ||
      normalized.includes('pipeline json contains no text')
    ) {
      return 'PDF 文档识别组件没有返回可用内容，请检查文件后重试。'
    }
    if (normalized.includes('vision router')) {
      return '本机图片识别组件运行失败，请在设置中重新检查组件。'
    }
    if (normalized.includes('glm-ocr pipeline')) {
      return '本机 PDF 文档识别组件无法正常工作，请在设置中重新检查组件。'
    }
  }

  if (normalized.includes('invalid origin')) {
    return '后台未允许当前客户端连接，请更新客户端或联系管理员。'
  }
  const service = serviceFromContext(context)
  const rawHttpAuthStatus = normalized.match(/\bhttp\s+(401|403)\b/)
  if (rawHttpAuthStatus) {
    if (service) {
      return rawHttpAuthStatus[1] === '401'
        ? `${serviceDisplayNames[service]}配置无效，请在设置中检查服务密钥。`
        : `${serviceDisplayNames[service]}未获授权，请检查服务账号或密钥的权限。`
    }
    return rawHttpAuthStatus[1] === '401'
      ? '后台授权已失效，请重新登录。'
      : '当前账号没有使用该功能的权限，请联系管理员确认授权。'
  }
  if (
    service &&
    (normalized.includes('invalid key') ||
      normalized.includes('api key') ||
      normalized.includes('invalid credentials') ||
      normalized.includes('credentials are invalid') ||
      normalized.includes('unauthorized'))
  ) {
    return `${serviceDisplayNames[service]}配置无效，请在设置中检查服务密钥。`
  }
  if (
    context === 'auth' &&
    (normalized.includes('invalid email') ||
      normalized.includes('invalid password') ||
      normalized.includes('invalid credentials') ||
      normalized.includes('user not found'))
  ) {
    return '后台账号或密码不正确，请检查后重试。'
  }
  if (
    normalized.includes('authentication required') ||
    normalized.includes('unauthorized') ||
    normalized.includes('invalid token') ||
    normalized.includes('oauth session not found')
  ) {
    return '后台授权已失效，请重新登录。'
  }
  if (
    normalized.includes('pro plan required') ||
    normalized.includes('forbidden') ||
    normalized.includes('permission denied')
  ) {
    return '当前账号没有使用该功能的权限，请联系管理员确认授权。'
  }
  if (normalized.includes('not implemented')) {
    return '后台暂未启用这个服务，请联系管理员完成配置。'
  }
  if (normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return '请求太频繁，请稍等一会儿再试。'
  }
  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('fetch failed') ||
    normalized.includes('networkerror') ||
    normalized.includes('network error') ||
    normalized.includes('connection failed') ||
    normalized.includes('connect error')
  ) {
    return context === 'auth'
      ? '无法连接后台服务，请检查后台地址或网络。'
      : '无法连接服务，请检查网络或后台地址后重试。'
  }
  if (
    normalized.includes('base url') ||
    normalized.includes('endpoint') ||
    normalized.includes('invalid url')
  ) {
    return service
      ? `${serviceDisplayNames[service]}地址不正确，请在设置里检查服务地址。`
      : '服务地址不正确，请在设置里检查后重试。'
  }
  if (normalized.includes('no provider specified')) {
    return '请先选择要使用的服务商。'
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return service
      ? `${serviceDisplayNames[service]}响应超时，请稍后重试。`
      : '服务响应超时，请稍后重试。'
  }
  if (
    normalized.includes('invalid key') ||
    normalized.includes('api key') ||
    normalized.includes('credentials are invalid')
  ) {
    return service
      ? `${serviceDisplayNames[service]}配置无效，请在设置中检查服务密钥。`
      : '服务配置无效，请在设置中检查服务密钥。'
  }
  if (normalized.includes('returned invalid json') || normalized.includes('invalid json')) {
    return '服务返回的内容无法读取，请稍后重试；若持续出现，请联系管理员。'
  }
  if (normalized.includes('returned an empty') || normalized.includes('empty response')) {
    return service ? `${serviceDisplayNames[service]}没有返回可用内容。` : '服务没有返回可用内容。'
  }
  if (normalized.includes('provider request failed') || normalized.includes('provider failed')) {
    return service
      ? `${serviceDisplayNames[service]}暂时不可用，请稍后重试；若持续出现，请联系管理员。`
      : '服务暂时不可用，请稍后重试；若持续出现，请联系管理员。'
  }
  if (/\bhttp\s+404\b/.test(normalized)) {
    const service = serviceFromContext(context)
    return service
      ? `${serviceDisplayNames[service]}地址或模型不可用，请检查配置后重试。`
      : '没有找到对应服务，请检查配置后重试。'
  }
  if (/\bhttp\s+(400|422)\b/.test(normalized)) {
    return '请求内容格式不正确，请重试；如果仍然失败，请联系管理员。'
  }
  if (/\bhttp\s+429\b/.test(normalized)) return '请求太频繁，请稍等一会儿再试。'
  if (/\bhttp\s+5\d\d\b/.test(normalized)) return '服务暂时不可用，请稍后重试。'
  if (/model .*not found|not found.*model/.test(normalized)) {
    return '没有找到当前文本 AI 模型，请在设置里换一个可用模型，或先在本机拉取该模型。'
  }
  if (normalized.includes('model is empty') || normalized.includes('model is required')) {
    return '模型名称为空，请先在设置里填写可用模型。'
  }
  if (normalized.includes('no answer returned from model')) {
    return '模型没有返回可用回答，请稍后重试或换一个模型。'
  }
  if (normalized.includes('no signed updater package')) {
    return '当前版本暂时没有可安装的更新包，请稍后再试；若持续出现，请联系管理员检查更新服务。'
  }

  return messageFromStatus(status, context)
}

function messageFromStatus(status: number | undefined, context: ErrorContext) {
  if (!status) return null
  if (status === 401) return '后台授权已失效，请重新登录。'
  if (status === 403) return '当前账号没有使用该功能的权限，请联系管理员确认授权。'
  if (status === 404) return '后台没有找到对应服务，请同步配置或联系管理员检查服务设置。'
  if (status === 408 || status === 504) {
    const service = serviceFromContext(context)
    return service
      ? `${backendServiceDisplayName(service)}响应超时，请稍后重试。`
      : '后台服务响应超时，请稍后重试。'
  }
  if (status === 413) return '提交内容太大，请缩短内容或换一个更小的文件。'
  if (status === 422) return '请求内容格式不正确，请重试；如果仍然失败，请联系管理员。'
  if (status === 429) return '请求太频繁，请稍等一会儿再试。'
  if (status >= 500) {
    const service = serviceFromContext(context)
    return service
      ? `${backendServiceDisplayName(service)}暂时不可用，请稍后重试。`
      : '后台服务暂时不可用，请稍后重试。'
  }
  return null
}

function serviceFromCode(code: string) {
  const prefix = code.split('_')[0]
  return serviceContexts.has(prefix as ServiceContext) ? (prefix as ServiceContext) : null
}

function serviceFromContext(context: ErrorContext) {
  return serviceContexts.has(context as ServiceContext) ? (context as ServiceContext) : null
}

function backendServiceDisplayName(service: ServiceContext) {
  return service === 'ocr' ? '后台 OCR 服务' : `后台${serviceDisplayNames[service]}`
}

function readableFallback(message: string, fallback: string) {
  const trimmed = message.trim()
  if (isUserFriendlyMessage(trimmed)) return trimmed
  return fallback
}

function isUserFriendlyMessage(message: string) {
  const trimmed = message.trim()
  if (!trimmed || looksTechnical(trimmed)) return false
  return /[\u4e00-\u9fff]/u.test(trimmed)
}

function looksTechnical(message: string) {
  if (message.length > 600) return true
  return (
    /(?:\b[a-z]:\\[^\r\n]+|\/(?:tmp|var\/tmp|home|users|etc|opt)\/[^\r\n]+)/i.test(message) ||
    /\.(?:ps1|rs|ts|tsx|js|jsx):\d+|CategoryInfo|FullyQualifiedErrorId|RuntimeException|OperationStopped|StackTrace/i.test(
      message,
    ) ||
    /(?:^|\n)\s*(?:at\s+|\+\s*(?:throw|categoryinfo)|~{3,})/im.test(message) ||
    /(?:\{|\[)\s*["']?(?:code|error|message|status)["']?\s*:/i.test(message) ||
    /\b(?:http\s*[1-5]\d\d|json|api\s*key|bearer|token|provider|runtimeexception|exception|stacktrace|stt|tts|llm|os\s+error\s+\d+|access is denied|permission denied|failed|undefined|null)\b/i.test(
      message,
    ) ||
    /\b(?:error(?:\s+code)?|errno)\s*(?:[:=]\s*)?\d+\b/i.test(message) ||
    /�|锟斤拷/u.test(message) ||
    /[\u4e00-\u9fff][：:]\s*[a-z][^\u4e00-\u9fff\n]{16,}/iu.test(message) ||
    (!/[\u4e00-\u9fff]/u.test(message) &&
      /(^|\s)(http|json|api|token|unauthorized|forbidden|quota|provider|failed|timeout|exception|error|stack|trace|undefined|null)\b/i.test(
        message,
      ))
  )
}
