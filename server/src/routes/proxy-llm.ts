import { ApiError, json } from '../errors.js'
import type { Handler } from '../http.js'
import type { LlmMessage, LlmRole } from '../services/proxy/llm-proxy.js'
import { operationFingerprint } from '../services/quota/operation-fingerprint.js'
import {
  acquiredReservation,
  commitQuotaResponse,
  releaseQuotaReservation,
} from '../services/quota/quota-response.js'

const MAX_MESSAGES = 32
const MAX_TOTAL_CHARS = 24_000
const MAX_COMPLETION_TOKENS_RESERVE = 1024
const CLIENT_PROVIDER_FIELDS = ['apiKey', 'providerApiKey', 'baseUrl', 'model', 'provider'] as const
const ALLOWED_ROLES = new Set<LlmRole>(['system', 'user', 'assistant'])

export const proxyLlm: Handler = async (ctx) => {
  const user = ctx.user
  if (!user) throw new Error('proxyLlm must be mounted behind requireAuth')

  const body = await ctx.request.json().catch(() => {
    throw new ApiError(422, 'validation_failed', 'invalid JSON body')
  })
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'validation_failed', 'request body must be an object')
  }

  for (const field of CLIENT_PROVIDER_FIELDS) {
    if (field in body) {
      throw new ApiError(422, 'validation_failed', `${field} is not accepted by cloud proxy`)
    }
  }

  const { messages, totalChars } = parseMessages((body as { messages?: unknown }).messages)
  const stream = (body as { stream?: unknown }).stream
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new ApiError(422, 'validation_failed', 'stream must be a boolean')
  }

  const reservationResult = await ctx.services.quota.reserve(
    user,
    'llm_tokens',
    estimateTokens(totalChars) + MAX_COMPLETION_TOKENS_RESERVE,
    'proxy_llm',
    ctx.requestId,
    {
      idempotencyKey: ctx.idempotencyKey,
      payloadHash: operationFingerprint(
        'proxy-llm-v1',
        [JSON.stringify(messages), stream === true ? 'stream' : 'complete'],
        ctx.env.betterAuthSecret,
      ),
    },
  )
  const reservation = acquiredReservation(reservationResult)
  if (reservation instanceof Response) return reservation

  if (stream === true) {
    let result: Awaited<ReturnType<typeof ctx.services.proxy.llm.stream>>
    try {
      result = await ctx.services.proxy.llm.stream({ messages })
    } catch (error) {
      await releaseQuotaReservation(ctx.services.quota, reservation)
      throw error
    }

    let completion: Awaited<typeof result.completed>
    let body: ArrayBuffer
    try {
      ;[completion, body] = await Promise.all([result.completed, result.response.arrayBuffer()])
    } catch (error) {
      await releaseQuotaReservation(ctx.services.quota, reservation)
      throw error
    }

    const response = new Response(body, {
      status: result.response.status,
      headers: result.response.headers,
    })
    await commitQuotaResponse(
      ctx.services.quota,
      reservation,
      usageTokens(completion.usageTokens, completion.text, totalChars),
      response,
    )
    return response
  }

  let result: Awaited<ReturnType<typeof ctx.services.proxy.llm.complete>>
  try {
    result = await ctx.services.proxy.llm.complete({ messages })
  } catch (error) {
    await releaseQuotaReservation(ctx.services.quota, reservation)
    throw error
  }

  const response = json({ text: result.text })
  await commitQuotaResponse(
    ctx.services.quota,
    reservation,
    usageTokens(result.usageTokens, result.text, totalChars),
    response,
  )
  return response
}

function parseMessages(input: unknown): { messages: LlmMessage[]; totalChars: number } {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_MESSAGES) {
    throw new ApiError(422, 'validation_failed', 'messages must be a non-empty bounded array')
  }

  let totalChars = 0
  const messages: LlmMessage[] = []
  for (const message of input) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new ApiError(422, 'validation_failed', 'each message must be an object')
    }
    const { role, content } = message as { role?: unknown; content?: unknown }
    if (typeof role !== 'string' || !ALLOWED_ROLES.has(role as LlmRole)) {
      throw new ApiError(422, 'validation_failed', 'message role is not allowed')
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError(422, 'validation_failed', 'message content is required')
    }

    totalChars += content.length
    messages.push({ role: role as LlmRole, content })
  }

  if (totalChars > MAX_TOTAL_CHARS) {
    throw new ApiError(422, 'validation_failed', 'messages are too long')
  }

  return { messages, totalChars }
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4))
}

function usageTokens(providerUsage: number | null, outputText: string, inputChars: number): number {
  return Math.max(1, providerUsage ?? estimateTokens(inputChars + outputText.length))
}
