import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { LocalOcrRuntime, LocalOcrTargetSnapshot } from './local-ocr-runtime.js'

const RELAY_MAX_REQUEST_BYTES = 36 * 1024 * 1024
const RELAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const GLM_OCR_CONTEXT_TOKENS = 16_384
const MAX_OUTPUT_TOKENS = 8_192

export interface LocalOcrRelaySnapshot {
  warmupAccepted: number
  formalAccepted: number
  formalTerminal: number
  formalNonEmpty: number
  formalEmpty: number
  fatal: boolean
  active: number
}

export interface LocalOcrRelay {
  endpoint: string
  recognizeImage(image: Uint8Array): Promise<string>
  settle(): Promise<void>
  snapshot(): LocalOcrRelaySnapshot
  close(): Promise<void>
}

export async function startLocalOcrRelay(
  runtime: LocalOcrRuntime,
  target: LocalOcrTargetSnapshot,
  signal: AbortSignal,
): Promise<LocalOcrRelay> {
  if (signal.aborted) throw abortReason(signal)
  const token = randomBytes(24).toString('hex')
  const pathname = `/${token}/api/generate`
  const active = new Set<Promise<void>>()
  const upstreamControllers = new Set<AbortController>()
  const sockets = new Set<Socket>()
  let closing = false
  let listening = false
  let closePromise: Promise<void> | null = null
  const evidence = {
    warmupAccepted: 0,
    formalAccepted: 0,
    formalTerminal: 0,
    formalNonEmpty: 0,
    formalEmpty: 0,
    fatal: false,
  }
  const markFailed = () => {
    evidence.fatal = true
  }

  const server = createServer((request, response) => {
    if (closing || signal.aborted) {
      request.destroy()
      return
    }
    const task = handleRelayRequest(runtime, target, pathname, request, response, signal, {
      register(controller) {
        upstreamControllers.add(controller)
      },
      unregister(controller) {
        upstreamControllers.delete(controller)
      },
      fail: markFailed,
      accept(imageRequest) {
        if (imageRequest) evidence.formalAccepted += 1
        else evidence.warmupAccepted += 1
      },
      complete(imageRequest, responseText) {
        if (!imageRequest) return
        evidence.formalTerminal += 1
        if (responseText.trim()) evidence.formalNonEmpty += 1
        else evidence.formalEmpty += 1
      },
      empty(imageRequest) {
        if (!imageRequest) return
        evidence.formalTerminal += 1
        evidence.formalEmpty += 1
      },
    }).catch(() => {
      markFailed()
      writeRelayError(response, 502, 'upstream_failed')
    })
    active.add(task)
    void task.finally(() => active.delete(task))
  })
  server.on('connection', (socket) => {
    if (closing || signal.aborted) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.maxConnections = 8
  server.headersTimeout = 5_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 1_000

  const stopRelayActivity = (reason: unknown) => {
    for (const controller of upstreamControllers) controller.abort(reason)
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    for (const socket of sockets) socket.destroy()
  }
  const settle = async () => {
    while (active.size) await Promise.allSettled([...active])
  }
  const beginClose = (reason: unknown): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    const serverClosed = closeServer(server)
    stopRelayActivity(reason)
    closePromise = (async () => {
      await serverClosed
      await settle()
      stopRelayActivity(reason)
      signal.removeEventListener('abort', onAbort)
    })()
    return closePromise
  }
  const onAbort = () => {
    closing = true
    stopRelayActivity(signal.reason)
    if (listening) void beginClose(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    await listenLoopback(server)
    listening = true
  } catch (error) {
    closing = true
    stopRelayActivity(error)
    signal.removeEventListener('abort', onAbort)
    throw error
  }
  if (signal.aborted || closing) {
    await beginClose(signal.reason)
    throw abortReason(signal)
  }

  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    signal.removeEventListener('abort', onAbort)
    throw new Error('Local OCR relay did not bind an IPv4 endpoint')
  }

  const endpoint = `http://127.0.0.1:${address.port}${pathname}`
  return {
    endpoint,
    async recognizeImage(image) {
      if (closing || signal.aborted) throw abortReason(signal)
      if (image.byteLength <= 0 || image.byteLength > RELAY_MAX_REQUEST_BYTES) {
        throw new Error('Local OCR recovery image is invalid')
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: target.model,
          prompt: 'Text Recognition:',
          images: [Buffer.from(image).toString('base64')],
          stream: false,
          options: {
            num_predict: MAX_OUTPUT_TOKENS,
            temperature: 0,
            top_p: 0.00001,
            top_k: 1,
            repeat_penalty: 1.1,
          },
        }),
        redirect: 'manual',
        signal,
      })
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Local OCR recovery request failed')
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > RELAY_MAX_RESPONSE_BYTES) {
        throw new Error('Local OCR recovery response is too large')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString('utf8')) as unknown
      } catch {
        throw new Error('Local OCR recovery response is invalid')
      }
      if (
        !isRecord(parsed) ||
        parsed.done !== true ||
        parsed.done_reason !== 'stop' ||
        typeof parsed.response !== 'string'
      ) {
        throw new Error('Local OCR recovery response is incomplete')
      }
      return parsed.response.trim()
    },
    settle,
    snapshot() {
      return { ...evidence, active: active.size }
    },
    async close() {
      await beginClose('relay-closing')
    },
  }
}

async function handleRelayRequest(
  runtime: LocalOcrRuntime,
  target: LocalOcrTargetSnapshot,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  parentSignal: AbortSignal,
  controllers: {
    register(controller: AbortController): void
    unregister(controller: AbortController): void
    fail(): void
    accept(imageRequest: boolean): void
    complete(imageRequest: boolean, responseText: string): void
    empty(imageRequest: boolean): void
  },
): Promise<void> {
  if (
    request.method !== 'POST' ||
    request.url !== pathname ||
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    if (request.url === pathname) controllers.fail()
    request.resume()
    writeRelayError(response, 404, 'not_found')
    return
  }

  let body: Buffer
  try {
    body = await readRelayBody(request, RELAY_MAX_REQUEST_BYTES, parentSignal)
  } catch {
    controllers.fail()
    writeRelayError(response, 413, 'request_too_large')
    return
  }
  const upstreamRequest = canonicalRelayRequest(body, target.model)
  if (!upstreamRequest) {
    controllers.fail()
    writeRelayError(response, 422, 'invalid_request')
    return
  }
  controllers.accept(upstreamRequest.imageRequest)

  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parentSignal.reason)
  const onClientAbort = () => controller.abort('relay-client-disconnected')
  const onResponseClose = () => {
    if (!response.writableEnded) onClientAbort()
  }
  parentSignal.addEventListener('abort', onParentAbort, { once: true })
  request.addListener('aborted', onClientAbort)
  response.addListener('close', onResponseClose)
  if (parentSignal.aborted) onParentAbort()
  if (request.aborted || (response.destroyed && !response.writableEnded)) onClientAbort()
  controllers.register(controller)
  try {
    const upstream = await runtime.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: upstreamRequest.body,
      signal: controller.signal,
      redirect: 'manual',
    })
    if (upstream.status < 200 || upstream.status >= 300) {
      await upstream.body?.cancel().catch(() => undefined)
      controllers.fail()
      writeRelayError(response, 502, 'upstream_status')
      return
    }
    const payload = await readRelayResponse(upstream, RELAY_MAX_RESPONSE_BYTES, controller.signal)
    const completion = canonicalRelayResponse(payload, upstreamRequest.imageRequest)
    if (!completion.ok) {
      if (completion.formalEmpty) controllers.empty(upstreamRequest.imageRequest)
      controllers.fail()
      writeRelayError(response, completion.status, completion.code)
      return
    }
    controllers.complete(upstreamRequest.imageRequest, completion.responseText)
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.setHeader('content-length', String(completion.payload.byteLength))
    response.end(completion.payload)
  } catch {
    controllers.fail()
    writeRelayError(response, 502, 'upstream_failed')
  } finally {
    controllers.unregister(controller)
    parentSignal.removeEventListener('abort', onParentAbort)
    request.removeListener('aborted', onClientAbort)
    response.removeListener('close', onResponseClose)
  }
}

async function readRelayBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    request.destroy()
    throw new Error('relay request too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    if (signal.aborted) throw abortReason(signal)
    const bytes = Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) {
      request.destroy()
      throw new Error('relay request too large')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

async function readRelayResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('relay response too large')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new Error('relay response too large')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function canonicalRelayRequest(
  body: Buffer,
  model: string,
): { body: Buffer; imageRequest: boolean } | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (!isRecord(parsed)) return null
    if (parsed.model !== model || parsed.stream !== false || typeof parsed.prompt !== 'string') {
      return null
    }
    if (parsed.images !== undefined) {
      if (
        !Array.isArray(parsed.images) ||
        parsed.images.length !== 1 ||
        !parsed.images.every((image) => typeof image === 'string' && image.length > 0)
      ) {
        return null
      }
    }
    const sourceOptions = parsed.options === undefined ? {} : parsed.options
    if (!isRecord(sourceOptions)) return null
    const numPredict = sourceOptions.num_predict ?? MAX_OUTPUT_TOKENS
    if (!isIntegerInRange(numPredict, 1, MAX_OUTPUT_TOKENS)) return null

    const options: Record<string, number> = {
      num_ctx: GLM_OCR_CONTEXT_TOKENS,
      num_predict: numPredict,
    }
    if (!copyFiniteOption(sourceOptions, options, 'temperature', 0, 2)) return null
    if (!copyFiniteOption(sourceOptions, options, 'top_p', 0, 1, false)) return null
    if (!copyIntegerOption(sourceOptions, options, 'top_k', 1, 1_000)) return null
    if (!copyFiniteOption(sourceOptions, options, 'repeat_penalty', 0, 10, false)) return null

    return {
      body: Buffer.from(
        JSON.stringify({
          model,
          prompt: parsed.prompt,
          ...(parsed.images === undefined ? {} : { images: parsed.images }),
          stream: false,
          options,
        }),
        'utf8',
      ),
      imageRequest: parsed.images !== undefined,
    }
  } catch {
    return null
  }
}

function canonicalRelayResponse(
  body: Buffer,
  imageRequest: boolean,
):
  | { ok: true; payload: Buffer; responseText: string }
  | {
      ok: false
      status: 422 | 502
      code: 'upstream_incomplete' | 'upstream_invalid_response'
      formalEmpty?: boolean
    } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return { ok: false, status: 502, code: 'upstream_invalid_response' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 502, code: 'upstream_invalid_response' }
  }
  const terminalReasonAccepted =
    parsed.done_reason === 'stop' || (!imageRequest && parsed.done_reason === 'length')
  if (parsed.done !== true || !terminalReasonAccepted || typeof parsed.response !== 'string') {
    // The official Pipeline retries 5xx responses. A non-terminal 200 response is a
    // deterministic completion failure, so return 422 and prevent duplicate inference.
    return { ok: false, status: 422, code: 'upstream_incomplete' }
  }
  if (imageRequest && !parsed.response.trim()) {
    return { ok: false, status: 422, code: 'upstream_incomplete', formalEmpty: true }
  }
  return {
    ok: true,
    responseText: parsed.response,
    payload: Buffer.from(
      JSON.stringify({ response: parsed.response, done: true, done_reason: 'stop' }),
      'utf8',
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function copyIntegerOption(
  source: Record<string, unknown>,
  target: Record<string, number>,
  key: string,
  minimum: number,
  maximum: number,
): boolean {
  const value = source[key]
  if (value === undefined) return true
  if (!isIntegerInRange(value, minimum, maximum)) return false
  target[key] = value
  return true
}

function copyFiniteOption(
  source: Record<string, unknown>,
  target: Record<string, number>,
  key: string,
  minimum: number,
  maximum: number,
  minimumInclusive = true,
): boolean {
  const value = source[key]
  if (value === undefined) return true
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (minimumInclusive ? value < minimum : value <= minimum) ||
    value > maximum
  ) {
    return false
  }
  target[key] = value
  return true
}

function writeRelayError(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent || response.destroyed || response.writableEnded) return
  const body = Buffer.from(JSON.stringify({ error: code }), 'utf8')
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.setHeader('content-length', String(body.byteLength))
  response.end(body)
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeIdleConnections?.()
  })
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}
