import { ApiError } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService } from '../desktop/desktop-config-service.js'
import type { LocalOcrExecutionGate } from '../ocr/document-ocr-service.js'
import type {
  LocalOcrProbeResult,
  LocalOcrRuntime,
  LocalOcrTargetSnapshot,
} from '../ocr/local-ocr-runtime.js'
import { resolveOcrProviderConfig } from './provider-config.js'

export interface OcrReadInput {
  imageBase64: string
  imageMimeType: string | null
  documentPage?: boolean
  requestId?: string
  signal?: AbortSignal
}

export interface OcrReadResult {
  text: string
  model: string
  usageTokens: number | null
  route?: 'direct'
  processingReason?: string
  warnings?: string[]
  degraded?: boolean
  pageCount?: number
}

export interface OcrProxyService {
  read(input: OcrReadInput): Promise<OcrReadResult>
}

export type OcrFailureStage =
  | 'provider_config'
  | 'target_resolution'
  | 'request_body'
  | 'connect'
  | 'upstream_status'
  | 'response_body'
  | 'response_json'
  | 'completion'
  | 'content'
  | 'deadline'
  | 'cancelled'

export interface OcrFailureDiagnostic {
  event: 'ocr_provider_failure'
  timestamp: string
  requestId: string | null
  provider: string | null
  protocol: string | null
  model: string | null
  endpointHost: string | null
  failureStage: OcrFailureStage
  elapsedMs: number
  errorStatus: number | null
  errorCode: string | null
  upstreamStatus: number | null
  causeCode: string | null
  terminalReason: string | null
  attemptCount: number
  retryCount: number
}

export type OcrDiagnosticSink = (diagnostic: OcrFailureDiagnostic) => void

type FetchLike = typeof fetch

interface OcrFailureTrace {
  stage: OcrFailureStage
  upstreamStatus: number | null
  causeCode: string | null
  terminalReason: string | null
  attemptCount: number
  retryCount: number
}

export const OCR_TIMEOUT_MS = 120_000
export const OCR_MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_TOKENS = 8192
const GLM_OCR_CONTEXT_TOKENS = 16_384
const LOCAL_OLLAMA_RETRY_DELAY_MS = 250
const GLM_OCR_TEXT_RECOGNITION_PROMPT = 'Text Recognition:'
const BLANK_DOCUMENT_PAGE_WARNING = '当前文档页未识别到文字，可能是空白页；已保留该页。'
const OCR_PROMPT = `你是严格的 OCR 与版面还原引擎。请完整读取图片、窗口截图或 PDF 页面中的全部可见文字，不要摘要、不要改写、不要省略、不要只返回局部。

输出要求：
1. 只输出工整 Markdown，不要输出 JSON，也不要输出解释性前后缀。
2. 保持自然阅读顺序、标题层级、列表、表格、代码块、按钮/标签等结构。
3. 表格要尽量还原为标准 Markdown 表格；内容很多时也要持续读取到所有可见文字，不要只返回页面上半部分或第一块区域。
4. 看不清的文字用 [无法识别] 标记；不要凭空编造。
5. 不要把 Markdown 整体包在 \`\`\`markdown 代码围栏里。
6. 不要重复输出同一行、同一段或同一截图片段；已经输出过的内容不要再次复述。`

function isGlmOcrModel(model: string) {
  const name = model.trim().split('/').at(-1)?.split(':')[0]
  return name?.toLowerCase() === 'glm-ocr'
}

function ollamaOcrPrompt(model: string) {
  return isGlmOcrModel(model)
    ? GLM_OCR_TEXT_RECOGNITION_PROMPT
    : `${OCR_PROMPT}\n\nRead this image or document page and return clean Markdown.`
}

export function createOcrProxyService(
  env: ServerEnv,
  fetchImpl: FetchLike = fetch,
  desktopConfig?: DesktopConfigService,
  diagnosticSink: OcrDiagnosticSink = () => undefined,
  localOcrExecutionGate?: LocalOcrExecutionGate,
  localOcrRuntime?: LocalOcrRuntime,
): OcrProxyService {
  return {
    async read(input) {
      const startedAt = Date.now()
      const trace: OcrFailureTrace = {
        stage: 'provider_config',
        upstreamStatus: null,
        causeCode: null,
        terminalReason: null,
        attemptCount: 0,
        retryCount: 0,
      }
      let providerContext: {
        provider: string
        protocol: string
        model: string
        endpointHost: string | null
      } | null = null

      try {
        const config = await resolveOcrProviderConfig(env, desktopConfig)
        providerContext = {
          provider: config.provider,
          protocol: config.protocol,
          model: config.model,
          endpointHost: diagnosticEndpointHost(config.endpoint),
        }
        const execute = async (signal: AbortSignal | undefined): Promise<OcrReadResult> => {
          let localTarget: LocalOcrTargetSnapshot | null = null
          if (
            localOcrRuntime &&
            config.provider === 'ollama-ocr-local' &&
            config.protocol === 'ollama-generate'
          ) {
            trace.stage = 'target_resolution'
            try {
              localTarget = await localOcrRuntime.resolveCurrent(signal)
            } catch (error) {
              if (signal?.aborted) throw cancelledOcrError()
              trace.causeCode = localRuntimeCauseCode(error)
              throw new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
            }
            trace.stage = 'connect'
            let probe: LocalOcrProbeResult
            try {
              probe = await localOcrRuntime.probe(localTarget, signal)
            } catch {
              if (signal?.aborted) throw cancelledOcrError()
              throw new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
            }
            if (!probe.available) {
              trace.stage = 'connect'
              trace.causeCode = probe.reason
              throw new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
            }
            providerContext = {
              provider: config.provider,
              protocol: config.protocol,
              model: localTarget.model,
              endpointHost: diagnosticEndpointHost(localTarget.logicalEndpoint),
            }
          }
          const activeModel = localTarget?.model ?? config.model
          const requestBody =
            config.protocol === 'ollama-generate'
              ? {
                  model: activeModel,
                  prompt: ollamaOcrPrompt(activeModel),
                  images: [input.imageBase64],
                  stream: false,
                  options: {
                    ...(isGlmOcrModel(activeModel) ? { num_ctx: GLM_OCR_CONTEXT_TOKENS } : {}),
                    num_predict: MAX_OUTPUT_TOKENS,
                    temperature: 0,
                  },
                }
              : {
                  model: activeModel,
                  messages: [
                    {
                      role: 'system',
                      content: OCR_PROMPT,
                    },
                    {
                      role: 'user',
                      content: [
                        {
                          type: 'text',
                          text: 'Read this image or document page and return clean Markdown.',
                        },
                        {
                          type: 'image_url',
                          image_url: {
                            url: `data:${input.imageMimeType ?? 'image/png'};base64,${input.imageBase64}`,
                          },
                        },
                      ],
                    },
                  ],
                  stream: false,
                  temperature: 0,
                  max_tokens: MAX_OUTPUT_TOKENS,
                }
          const requestFetch: FetchLike = localTarget
            ? (_input, init) => localOcrRuntime!.request(localTarget, init ?? {})
            : fetchImpl
          const responseBody = await fetchJson(
            requestFetch,
            localTarget?.logicalEndpoint ?? config.endpoint,
            config.apiKey,
            requestBody,
            trace,
            config.provider === 'ollama-ocr-local' && config.protocol === 'ollama-generate',
            signal,
          )
          trace.stage = 'completion'
          trace.terminalReason = providerCompletionReason(responseBody, config.protocol)
          assertProviderCompleted(responseBody, config.protocol, trace.terminalReason)
          trace.stage = 'content'
          const extracted = extractOcrText(responseBody)
          if (!extracted.present) {
            throw new ApiError(502, 'ocr_failed', 'Cloud OCR response is missing text content')
          }
          const text = extracted.text
          const blankDocumentPage = Boolean(input.documentPage) && !text.trim()
          if (!text.trim() && !blankDocumentPage) {
            throw new ApiError(502, 'ocr_failed', 'Cloud OCR returned an empty response')
          }

          return {
            text,
            model: activeModel,
            usageTokens: extractUsageTokens(responseBody),
            route: 'direct',
            processingReason: 'cloud-provider-direct',
            warnings: blankDocumentPage ? [BLANK_DOCUMENT_PAGE_WARNING] : [],
            degraded: blankDocumentPage,
            pageCount: 1,
          }
        }
        if (
          localOcrExecutionGate &&
          config.provider === 'ollama-ocr-local' &&
          config.protocol === 'ollama-generate'
        ) {
          return await localOcrExecutionGate.run(input.signal, execute)
        }
        return await execute(input.signal)
      } catch (error) {
        emitOcrFailureDiagnostic(diagnosticSink, {
          event: 'ocr_provider_failure',
          timestamp: new Date().toISOString(),
          requestId: diagnosticLabel(input.requestId),
          provider: diagnosticLabel(providerContext?.provider),
          protocol: diagnosticLabel(providerContext?.protocol),
          model: diagnosticLabel(providerContext?.model),
          endpointHost: providerContext?.endpointHost ?? null,
          failureStage: trace.stage,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          errorStatus: error instanceof ApiError ? error.status : null,
          errorCode: error instanceof ApiError ? error.code : null,
          upstreamStatus: trace.upstreamStatus,
          causeCode: trace.causeCode,
          terminalReason: diagnosticTerminalReason(trace.terminalReason),
          attemptCount: trace.attemptCount,
          retryCount: trace.retryCount,
        })
        throw error
      }
    },
  }
}

export function writeOcrFailureDiagnostic(diagnostic: OcrFailureDiagnostic): void {
  console.warn(JSON.stringify(diagnostic))
}

export const disabledOcrProxyService: OcrProxyService = {
  async read() {
    throw new ApiError(501, 'not_implemented', 'Cloud OCR proxy is not configured')
  },
}

async function fetchJson(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  body: unknown,
  trace: OcrFailureTrace,
  retryLocalOllama: boolean,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  if (callerSignal?.aborted) {
    trace.stage = 'cancelled'
    throw cancelledOcrError()
  }
  trace.stage = 'request_body'
  const serializedBody = JSON.stringify(body)
  const scope = createOcrRequestScope(callerSignal)

  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      trace.attemptCount = attempt
      trace.retryCount = attempt - 1
      trace.stage = 'connect'
      trace.upstreamStatus = null
      trace.causeCode = null
      const response = await scope.wait(
        fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            ...authHeaders(apiKey),
            'content-type': 'application/json',
          },
          body: serializedBody,
          signal: scope.signal,
        }),
      )
      trace.upstreamStatus = response.status

      if (!response.ok) {
        trace.stage = 'upstream_status'
        if (retryLocalOllama && attempt === 1 && isRetryableLocalOllamaStatus(response.status)) {
          void cancelResponseBody(response)
          await delay(LOCAL_OLLAMA_RETRY_DELAY_MS, scope.signal)
          continue
        }
        throw await upstreamOcrError(response)
      }

      trace.stage = 'response_body'
      const text = await readResponseText(response, OCR_MAX_PROVIDER_RESPONSE_BYTES, scope)
      trace.stage = 'response_json'
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new ApiError(502, 'ocr_failed', 'Cloud OCR returned invalid JSON')
      }
    }
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
  } catch (error) {
    const abortError = scope.failure()
    if (abortError) {
      trace.stage = abortError.status === 499 ? 'cancelled' : 'deadline'
      throw abortError
    }
    if (error instanceof ApiError) throw error
    if (isAbortError(error)) {
      trace.stage = 'deadline'
      throw new ApiError(504, 'ocr_timeout', 'Cloud OCR timed out')
    }
    trace.causeCode = providerCauseCode(error)
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
  } finally {
    scope.dispose()
  }
}

function isRetryableLocalOllamaStatus(status: number): boolean {
  return status === 500 || status === 503
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function authHeaders(apiKey: string | null): HeadersInit {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

async function upstreamOcrError(response: Response): Promise<ApiError> {
  void cancelResponseBody(response)
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'ocr_invalid_key', 'Cloud OCR provider credentials are invalid')
  }
  return new ApiError(502, 'ocr_failed', 'Cloud OCR provider request failed')
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Response cleanup must not replace the stable provider failure returned to the caller.
  }
}

interface OcrRequestScope {
  signal: AbortSignal
  wait<T>(operation: Promise<T>): Promise<T>
  failure(): ApiError | null
  dispose(): void
}

function createOcrRequestScope(callerSignal?: AbortSignal): OcrRequestScope {
  const controller = new AbortController()
  let currentFailure: ApiError | null = null
  let rejectAbort: (error: ApiError) => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const fail = (error: ApiError) => {
    if (currentFailure) return
    currentFailure = error
    controller.abort(error)
    rejectAbort(error)
  }
  const onCallerAbort = () => fail(cancelledOcrError())
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(
    () => fail(new ApiError(504, 'ocr_timeout', 'Cloud OCR timed out')),
    OCR_TIMEOUT_MS,
  )

  return {
    signal: controller.signal,
    wait<T>(operation: Promise<T>) {
      return Promise.race([operation, aborted])
    },
    failure() {
      return currentFailure
    },
    dispose() {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

function cancelledOcrError(): ApiError {
  return new ApiError(499, 'ocr_failed', 'Cloud OCR request was cancelled')
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  scope: OcrRequestScope,
): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && contentLengthExceeds(declaredLength, maxBytes)) {
    void response.body?.cancel().catch(() => undefined)
    throw providerBodyTooLargeError()
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await scope.wait(reader.read())
      if (done) break
      if (!value?.byteLength) continue
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw providerBodyTooLargeError()
      }
      chunks.push(value)
      total += value.byteLength
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A pending provider read is released by cancellation/abort.
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function contentLengthExceeds(value: string, maxBytes: number): boolean {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const length = Number(trimmed)
  return Number.isSafeInteger(length) && length > maxBytes
}

function providerBodyTooLargeError(): ApiError {
  return new ApiError(502, 'ocr_failed', 'Cloud OCR provider response is too large')
}

function assertProviderCompleted(
  body: unknown,
  protocol: string,
  completionReason: string | null,
): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR returned an invalid response object')
  }
  const record = body as Record<string, unknown>

  if (protocol === 'ollama-generate') {
    if (record.done !== true || !completionReason) {
      throw new ApiError(502, 'ocr_failed', 'Cloud OCR did not report a terminal done_reason')
    }
    if (completionReason === 'stop') return
    if (completionReason === 'length') {
      throw new ApiError(502, 'ocr_failed', 'Cloud OCR output was truncated (done_reason=length)')
    }
    throw new ApiError(
      502,
      'ocr_failed',
      `Cloud OCR stopped before completion (done_reason=${diagnosticTerminalReason(completionReason) ?? 'unrecognized'})`,
    )
  }

  if (!completionReason) {
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR did not report a terminal finish_reason')
  }
  if (completionReason === 'stop') return
  if (completionReason === 'length') {
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR output was truncated (finish_reason=length)')
  }
  if (completionReason === 'content_filter') {
    throw new ApiError(502, 'ocr_failed', 'Cloud OCR output was blocked by the content filter')
  }
  throw new ApiError(
    502,
    'ocr_failed',
    `Cloud OCR stopped before completion (finish_reason=${diagnosticTerminalReason(completionReason) ?? 'unrecognized'})`,
  )
}

function providerCompletionReason(body: unknown, protocol: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (protocol === 'ollama-generate') {
    return typeof record.done_reason === 'string' ? record.done_reason : null
  }
  const choices = record.choices
  const first = Array.isArray(choices) ? choices[0] : null
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const finishReason = (first as Record<string, unknown>).finish_reason
  return typeof finishReason === 'string' ? finishReason : null
}

function emitOcrFailureDiagnostic(
  diagnosticSink: OcrDiagnosticSink,
  diagnostic: OcrFailureDiagnostic,
): void {
  try {
    diagnosticSink(diagnostic)
  } catch {
    // Diagnostics must never replace the provider error returned to the caller.
  }
}

function diagnosticEndpointHost(endpoint: string): string | null {
  try {
    return diagnosticLabel(new URL(endpoint).host)
  } catch {
    return null
  }
}

function diagnosticLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 160) : null
}

function diagnosticTerminalReason(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return SAFE_TERMINAL_REASONS.has(trimmed) ? trimmed : 'unrecognized'
}

const SAFE_TERMINAL_REASONS = new Set(['stop', 'length', 'content_filter'])

const SAFE_PROVIDER_CAUSE_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

function providerCauseCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') return null
    const record = current as Record<string, unknown>
    if (typeof record.code === 'string' && SAFE_PROVIDER_CAUSE_CODES.has(record.code)) {
      return record.code
    }
    current = record.cause
  }
  return null
}

const SAFE_LOCAL_RUNTIME_CAUSE_CODES = new Set([
  'address_scope_forbidden',
  'dns_resolution_failed',
  'endpoint_invalid',
  'insecure_http_forbidden',
  'mixed_address_scope',
  'provider_mismatch',
  'wsl_gateway_invalid',
  'wsl_network_unavailable',
  'wsl_runtime_unavailable',
])

function localRuntimeCauseCode(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== 'object') return null
    const record = current as Record<string, unknown>
    if (typeof record.code === 'string' && SAFE_LOCAL_RUNTIME_CAUSE_CODES.has(record.code)) {
      return record.code
    }
    current = record.cause
  }
  return null
}

function extractOcrText(body: unknown): { text: string; present: boolean } {
  const raw = extractProviderText(body)
  if (raw === null) return { text: '', present: false }
  const stripped = stripWrappingCodeFence(raw)
  try {
    const parsed = JSON.parse(stripped) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const text = (parsed as Record<string, unknown>).text
      if (typeof text === 'string') return { text: cleanOcrText(text), present: true }
    }
  } catch {
    // Providers occasionally ignore JSON mode; keep usable Markdown instead.
  }
  return { text: cleanOcrText(stripped), present: true }
}

function extractProviderText(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.response === 'string') return record.response
  const providerMessage = record.message
  if (providerMessage && typeof providerMessage === 'object' && !Array.isArray(providerMessage)) {
    const content = (providerMessage as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }

  const choices = record.choices
  if (!Array.isArray(choices)) return null
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null
    const text = (part as Record<string, unknown>).text
    if (typeof text !== 'string') return null
    parts.push(text)
  }
  return parts.join('')
}

function cleanOcrText(text: string): string {
  return stripWrappingCodeFence(text.trim())
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function stripWrappingCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed
  const lines = trimmed.split(/\r?\n/)
  const first = lines[0]?.trimStart()
  const last = lines.at(-1)?.trim()
  if (!first?.startsWith('```') || last !== '```') return trimmed
  return lines.slice(1, -1).join('\n').trim()
}

function extractUsageTokens(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const usage = (body as Record<string, unknown>).usage
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    const totalTokens = (usage as Record<string, unknown>).total_tokens
    return typeof totalTokens === 'number' && Number.isInteger(totalTokens) && totalTokens >= 0
      ? totalTokens
      : null
  }
  const promptTokens = (body as Record<string, unknown>).prompt_eval_count
  const outputTokens = (body as Record<string, unknown>).eval_count
  if (typeof promptTokens === 'number' || typeof outputTokens === 'number') {
    const promptCount = typeof promptTokens === 'number' ? promptTokens : 0
    const outputCount = typeof outputTokens === 'number' ? outputTokens : 0
    return Math.max(0, Math.trunc(promptCount) + Math.trunc(outputCount))
  }
  return null
}
