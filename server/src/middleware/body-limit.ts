import type { Middleware } from '../http.js'
import { ApiError } from '../errors.js'

export function requireContentLengthBelow(maxBytes: number): Middleware {
  return async (ctx, next) => {
    const length = ctx.request.headers.get('content-length')
    if (length && !contentLengthWithinLimit(length, maxBytes)) {
      throw new ApiError(413, 'payload_too_large', 'Payload too large')
    }
    if (ctx.request.body) {
      const body = await readBodyBelow(ctx.request, maxBytes)
      ctx.request = requestWithBody(ctx.request, body)
    }
    return next(ctx)
  }
}

function contentLengthWithinLimit(value: string, maxBytes: number): boolean {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return false
  const length = Number(trimmed)
  return Number.isSafeInteger(length) && length <= maxBytes
}

async function readBodyBelow(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ApiError(413, 'payload_too_large', 'Payload too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function requestWithBody(request: Request, body: Uint8Array): Request {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = body.byteLength ? body : new Uint8Array()
  }
  return new Request(request.url, init)
}
