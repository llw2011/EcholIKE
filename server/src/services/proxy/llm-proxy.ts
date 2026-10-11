import { ApiError } from '../../errors.js'
import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService } from '../desktop/desktop-config-service.js'
import { resolveLlmProviderConfig } from './provider-config.js'

export type LlmRole = 'system' | 'user' | 'assistant'

export interface LlmMessage {
  role: LlmRole
  content: string
}

export interface LlmCompletionResult {
  text: string
  usageTokens: number | null
}

export interface LlmStreamResult {
  response: Response
  completed: Promise<LlmCompletionResult>
}

export interface LlmProxyService {
  complete(input: { messages: LlmMessage[] }): Promise<LlmCompletionResult>
  stream(input: { messages: LlmMessage[] }): Promise<LlmStreamResult>
}

type FetchLike = typeof fetch

const LLM_TIMEOUT_MS = 60_000
const MAX_COMPLETION_TOKENS = 1024
export const LLM_MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024

export function createLlmProxyService(
  env: ServerEnv,
  fetchImpl: FetchLike = fetch,
  desktopConfig?: DesktopConfigService,
): LlmProxyService {
  return {
    async complete(input) {
      const config = await resolveLlmProviderConfig(env, desktopConfig)
      if (config.protocol === 'ollama-chat') {
        return completeOllama(fetchImpl, config.endpoint, config.apiKey, {
          model: config.model,
          messages: input.messages,
        })
      }

      const response = await fetchJson(
        fetchImpl,
        config.endpoint,
        config.apiKey,
        openAiChatBody(config.model, input.messages, false),
      )

      const body = await response.json().catch(() => {
        throw new ApiError(502, 'llm_failed', 'Cloud LLM returned invalid JSON')
      })
      const text = extractText(body)
      if (!text.trim()) {
        throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty response')
      }

      return {
        text,
        usageTokens: extractUsageTokens(body),
      }
    },

    async stream(input) {
      const config = await resolveLlmProviderConfig(env, desktopConfig)
      if (config.protocol === 'ollama-chat') {
        return streamOllama(fetchImpl, config.endpoint, config.apiKey, {
          model: config.model,
          messages: input.messages,
        })
      }

      const upstream = await fetchJson(
        fetchImpl,
        config.endpoint,
        config.apiKey,
        openAiChatBody(config.model, input.messages, true),
      )
      return openAiStreamResponse(upstream)
    },
  }
}

export const disabledLlmProxyService: LlmProxyService = {
  async complete() {
    throw new ApiError(501, 'not_implemented', 'Cloud LLM proxy is not configured')
  },
  async stream() {
    throw new ApiError(501, 'not_implemented', 'Cloud LLM proxy is not configured')
  },
}

async function fetchJson(
  fetchImpl: FetchLike,
  endpoint: string,
  apiKey: string | null,
  body: unknown,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(apiKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw await upstreamLlmError(response)
    }

    const responseBody = await readBoundedLlmResponse(response, controller)
    return new Response(responseBody, {
      status: response.status,
      headers: response.headers,
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (isAbortError(error)) {
      throw new ApiError(504, 'llm_timeout', 'Cloud LLM timed out')
    }
    throw new ApiError(502, 'llm_failed', 'Cloud LLM provider request failed')
  } finally {
    clearTimeout(timer)
  }
}

async function readBoundedLlmResponse(
  response: Response,
  controller: AbortController,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > LLM_MAX_PROVIDER_RESPONSE_BYTES
  ) {
    controller.abort()
    void response.body?.cancel().catch(() => undefined)
    throw new ApiError(502, 'llm_failed', 'Cloud LLM response is too large')
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      if (total + value.byteLength > LLM_MAX_PROVIDER_RESPONSE_BYTES) {
        controller.abort()
        throw new ApiError(502, 'llm_failed', 'Cloud LLM response is too large')
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
      // The abort path owns any pending read.
    }
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function authHeaders(apiKey: string | null): HeadersInit {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function openAiChatBody(
  model: string,
  messages: LlmMessage[],
  stream: boolean,
): Record<string, unknown> {
  return {
    model,
    messages,
    stream,
    max_tokens: MAX_COMPLETION_TOKENS,
  }
}

function ollamaChatBody(
  model: string,
  messages: LlmMessage[],
  stream: boolean,
): Record<string, unknown> {
  return {
    model,
    messages,
    stream,
    options: {
      num_predict: MAX_COMPLETION_TOKENS,
    },
  }
}

async function completeOllama(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string | null,
  input: { model: string; messages: LlmMessage[] },
): Promise<LlmCompletionResult> {
  let lastError: unknown = null
  for (const endpoint of ollamaEndpointCandidates(baseUrl)) {
    try {
      const response = await fetchJson(
        fetchImpl,
        endpoint.url,
        apiKey,
        endpoint.protocol === 'openai'
          ? openAiChatBody(input.model, input.messages, false)
          : ollamaChatBody(input.model, input.messages, false),
      )
      const body = await response.json().catch(() => {
        throw new ApiError(502, 'llm_failed', 'Cloud LLM returned invalid JSON')
      })
      const text = extractText(body)
      if (!text.trim()) {
        throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty response')
      }
      return {
        text,
        usageTokens: extractUsageTokens(body),
      }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(502, 'llm_failed', 'Cloud LLM provider request failed')
}

async function streamOllama(
  fetchImpl: FetchLike,
  baseUrl: string,
  apiKey: string | null,
  input: { model: string; messages: LlmMessage[] },
): Promise<LlmStreamResult> {
  let lastError: unknown = null
  for (const endpoint of ollamaEndpointCandidates(baseUrl)) {
    try {
      const upstream = await fetchJson(
        fetchImpl,
        endpoint.url,
        apiKey,
        endpoint.protocol === 'openai'
          ? openAiChatBody(input.model, input.messages, true)
          : ollamaChatBody(input.model, input.messages, true),
      )
      if (endpoint.protocol === 'openai') return openAiStreamResponse(upstream)
      return ollamaStreamResponse(upstream)
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof ApiError) throw lastError
  throw new ApiError(502, 'llm_failed', 'Cloud LLM provider request failed')
}

function openAiStreamResponse(upstream: Response): LlmStreamResult {
  if (!upstream.body) {
    throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty stream')
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const completed = relayOpenAiStream(upstream.body, writable)

  return streamResult(readable, completed)
}

function ollamaStreamResponse(upstream: Response): LlmStreamResult {
  if (!upstream.body) {
    throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty stream')
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const completed = relayOllamaStream(upstream.body, writable)

  return streamResult(readable, completed)
}

function streamResult(
  readable: ReadableStream<Uint8Array>,
  completed: Promise<LlmCompletionResult>,
): LlmStreamResult {
  return {
    response: new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      },
    }),
    completed,
  }
}

async function upstreamLlmError(response: Response): Promise<ApiError> {
  void response.body?.cancel().catch(() => undefined)
  if (response.status === 401 || response.status === 403) {
    return new ApiError(502, 'llm_invalid_key', 'Cloud LLM provider credentials are invalid')
  }
  return new ApiError(502, 'llm_failed', 'Cloud LLM provider request failed')
}

function ollamaEndpointCandidates(
  baseUrl: string,
): Array<{ url: string; protocol: 'openai' | 'ollama' }> {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  const origin = urlOrigin(trimmed)
  const path = httpUrl(trimmed).pathname.replace(/\/+$/, '')
  const openAiUrl =
    path === '' || path === '/' || path === '/api' || path === '/v'
      ? `${origin}/v1/chat/completions`
      : trimmed.endsWith('/chat/completions')
        ? trimmed
        : `${trimmed}/chat/completions`
  const nativeUrl = trimmed.endsWith('/api/chat') ? trimmed : `${origin}/api/chat`
  return openAiUrl === nativeUrl
    ? [{ url: openAiUrl, protocol: 'openai' }]
    : [
        { url: openAiUrl, protocol: 'openai' },
        { url: nativeUrl, protocol: 'ollama' },
      ]
}

function urlOrigin(value: string): string {
  const parsed = httpUrl(value)
  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

function httpUrl(value: string): URL {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol')
    }
    return parsed
  } catch {
    throw new ApiError(502, 'llm_failed', 'Cloud LLM provider endpoint is invalid')
  }
}

function extractText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.response === 'string') return record.response
  const providerMessage = record.message
  if (providerMessage && typeof providerMessage === 'object' && !Array.isArray(providerMessage)) {
    const content = (providerMessage as Record<string, unknown>).content
    if (typeof content === 'string') return content
  }

  const choices = record.choices
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return ''
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return ''
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : ''
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

async function relayOpenAiStream(
  body: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): Promise<LlmCompletionResult> {
  const reader = body.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let text = ''
  let sawTerminalEvent = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writer.write(value)
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (isOpenAiTerminalLine(line)) sawTerminalEvent = true
        text += extractStreamContent(line)
        newline = buffer.indexOf('\n')
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      const line = buffer.trim()
      if (isOpenAiTerminalLine(line)) sawTerminalEvent = true
      text += extractStreamContent(line)
    }
    if (!sawTerminalEvent) {
      throw new ApiError(502, 'llm_failed', 'Cloud LLM stream ended before completion')
    }
    if (!text.trim()) {
      throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty response')
    }
    await writer.close()
    return {
      text,
      usageTokens: null,
    }
  } catch (error) {
    await writer
      .write(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ error: 'Cloud LLM stream failed' })}\n\n`,
        ),
      )
      .catch(() => undefined)
    await writer.close().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
    writer.releaseLock()
  }
}

async function relayOllamaStream(
  body: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): Promise<LlmCompletionResult> {
  const reader = body.getReader()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let text = ''
  let usageTokens: number | null = null
  let sawTerminalEvent = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const chunk = parseOllamaStreamLine(line)
        if (chunk.content) {
          text += chunk.content
          await writer.write(encoder.encode(openAiStreamData(chunk.content)))
        }
        if (chunk.usageTokens !== null) usageTokens = chunk.usageTokens
        if (chunk.done) sawTerminalEvent = true
        newline = buffer.indexOf('\n')
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      const chunk = parseOllamaStreamLine(buffer.trim())
      if (chunk.content) {
        text += chunk.content
        await writer.write(encoder.encode(openAiStreamData(chunk.content)))
      }
      if (chunk.usageTokens !== null) usageTokens = chunk.usageTokens
      if (chunk.done) sawTerminalEvent = true
    }
    if (!sawTerminalEvent) {
      throw new ApiError(502, 'llm_failed', 'Cloud LLM stream ended before completion')
    }
    if (!text.trim()) {
      throw new ApiError(502, 'llm_failed', 'Cloud LLM returned an empty response')
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'))
    await writer.close()
    return {
      text,
      usageTokens,
    }
  } catch (error) {
    await writer
      .write(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ error: 'Cloud LLM stream failed' })}\n\n`,
        ),
      )
      .catch(() => undefined)
    await writer.close().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
    writer.releaseLock()
  }
}

function parseOllamaStreamLine(line: string): {
  content: string
  usageTokens: number | null
  done: boolean
} {
  if (!line) return { content: '', usageTokens: null, done: false }
  try {
    const parsed = JSON.parse(line) as unknown
    const record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    return {
      content: extractText(parsed),
      usageTokens: extractUsageTokens(parsed),
      done: record?.done === true,
    }
  } catch {
    return { content: '', usageTokens: null, done: false }
  }
}

function openAiStreamData(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

function extractStreamContent(line: string): string {
  const payload = line.startsWith('data:') ? line.slice(5).trim() : ''
  if (!payload || payload === '[DONE]') return ''
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const choices = (parsed as Record<string, unknown>).choices
    if (!Array.isArray(choices)) return ''
    const first = choices[0]
    if (!first || typeof first !== 'object' || Array.isArray(first)) return ''
    const delta = (first as Record<string, unknown>).delta
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return ''
    const content = (delta as Record<string, unknown>).content
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

function isOpenAiTerminalLine(line: string): boolean {
  return line.startsWith('data:') && line.slice(5).trim() === '[DONE]'
}
