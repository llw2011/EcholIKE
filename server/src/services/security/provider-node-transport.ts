import { request as nodeHttpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as nodeHttpsRequest, type RequestOptions as NodeRequestOptions } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type {
  ProviderEgressTransport,
  ProviderResolvedAddress,
  ValidatedProviderEndpoint,
} from './provider-egress-policy.js'

export type ProviderNodeTransportErrorCode =
  | 'invalid_max_response_bytes'
  | 'method_forbidden'
  | 'request_body_forbidden'
  | 'request_body_unsupported'
  | 'validated_address_missing'
  | 'validated_address_mismatch'
  | 'invalid_response_status'
  | 'response_too_large'
  | 'response_aborted'

export class ProviderNodeTransportError extends Error {
  constructor(
    readonly code: ProviderNodeTransportErrorCode,
    options: { cause?: unknown } = {},
  ) {
    super(`Provider transport failed: ${code}`, options)
    this.name = 'ProviderNodeTransportError'
  }
}

export type ProviderNodeRequestFactory = (
  options: NodeRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest

export interface ProviderNodeTransportOptions {
  /** Maximum number of response-body bytes accepted for every request. */
  maxResponseBytes: number
  /** POST bodies remain forbidden unless the caller explicitly owns their input limits. */
  allowRequestBody?: boolean
  /** Test seam; production callers use Node's HTTP implementation. */
  httpRequest?: ProviderNodeRequestFactory
  /** Test seam; production callers use Node's HTTPS implementation. */
  httpsRequest?: ProviderNodeRequestFactory
}

const NULL_BODY_STATUSES = new Set([204, 205, 304])
const FORBIDDEN_REQUEST_HEADERS = [
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const

const defaultHttpRequest: ProviderNodeRequestFactory = (options, callback) =>
  nodeHttpRequest(options, callback)
const defaultHttpsRequest: ProviderNodeRequestFactory = (options, callback) =>
  nodeHttpsRequest(options, callback)

/**
 * Creates the production transport for endpoints already approved by the egress policy.
 * DNS is never performed here: Node receives the original hostname plus a lookup callback
 * which can return only the selected validated address.
 */
export function createProviderNodeTransport(
  options: ProviderNodeTransportOptions,
): ProviderEgressTransport {
  const maxResponseBytes = validatedMaximum(options.maxResponseBytes)
  const httpRequest = options.httpRequest ?? defaultHttpRequest
  const httpsRequest = options.httpsRequest ?? defaultHttpsRequest
  const allowRequestBody = options.allowRequestBody === true

  return {
    async request(endpoint, init) {
      return await requestPinnedEndpoint(
        endpoint,
        init,
        maxResponseBytes,
        allowRequestBody,
        httpRequest,
        httpsRequest,
      )
    },
  }
}

async function requestPinnedEndpoint(
  endpoint: ValidatedProviderEndpoint,
  init: RequestInit,
  maxResponseBytes: number,
  allowRequestBody: boolean,
  httpRequest: ProviderNodeRequestFactory,
  httpsRequest: ProviderNodeRequestFactory,
): Promise<Response> {
  const method = (init.method ?? 'GET').trim().toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && !(allowRequestBody && method === 'POST')) {
    throw new ProviderNodeTransportError('method_forbidden')
  }
  if ((method === 'GET' || method === 'HEAD') && init.body !== undefined && init.body !== null) {
    throw new ProviderNodeTransportError('request_body_forbidden')
  }
  if (init.signal?.aborted) throw abortReason(init.signal)

  const serialized = await serializeRequest(endpoint, init, method, allowRequestBody)
  if (init.signal?.aborted) throw abortReason(init.signal)

  const pinnedAddress = endpoint.addresses[0]
  if (!pinnedAddress) throw new ProviderNodeTransportError('validated_address_missing')
  assertPinnedAddress(endpoint, pinnedAddress)

  const requestOptions = nodeRequestOptions(
    endpoint,
    pinnedAddress,
    method,
    serialized.headers,
    serialized.body,
  )
  const requestFactory = endpoint.url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<Response>((resolve, reject) => {
    let request: ClientRequest | null = null
    let incoming: IncomingMessage | null = null
    let promiseSettled = false
    let abortListenerAttached = false

    const removeAbortListener = () => {
      if (!abortListenerAttached || !init.signal) return
      init.signal.removeEventListener('abort', onAbort)
      abortListenerAttached = false
    }
    const rejectBeforeResponse = (error: unknown) => {
      if (promiseSettled) return
      promiseSettled = true
      removeAbortListener()
      reject(error)
    }
    const onAbort = () => {
      const error = abortReason(init.signal)
      if (incoming) safelyDestroyIncoming(incoming, error)
      request?.destroy(error)
      rejectBeforeResponse(error)
    }

    try {
      request = requestFactory(requestOptions, (response) => {
        if (promiseSettled) {
          safelyDestroyIncoming(response, new ProviderNodeTransportError('response_aborted'))
          return
        }
        incoming = response
        if (init.signal?.aborted) {
          onAbort()
          return
        }

        try {
          const status = validResponseStatus(response.statusCode)
          rejectOversizedContentLength(response, maxResponseBytes)
          const headers = responseHeaders(response)
          const responseInit: ResponseInit = {
            status,
            headers,
          }
          if (response.statusMessage) responseInit.statusText = response.statusMessage

          const hasBody = method !== 'HEAD' && !NULL_BODY_STATUSES.has(status)
          const body = hasBody
            ? boundedResponseBody(response, request!, maxResponseBytes, removeAbortListener)
            : null

          if (!hasBody) {
            const finishNullBody = () => {
              response.off('end', finishNullBody)
              response.off('close', finishNullBody)
              response.off('error', finishNullBody)
              response.off('aborted', finishNullBody)
              removeAbortListener()
            }
            response.once('end', finishNullBody)
            response.once('close', finishNullBody)
            response.once('error', finishNullBody)
            response.once('aborted', finishNullBody)
            response.resume()
          }

          const fetchResponse = new Response(body, responseInit)
          promiseSettled = true
          resolve(fetchResponse)
        } catch (error) {
          safelyDestroyIncoming(response, asError(error))
          request?.destroy(asError(error))
          rejectBeforeResponse(error)
        }
      })
    } catch (error) {
      rejectBeforeResponse(error)
      return
    }

    request.once('error', (error) => {
      if (!promiseSettled) {
        rejectBeforeResponse(error)
        return
      }
      if (incoming) safelyDestroyIncoming(incoming, error)
    })

    if (init.signal) {
      init.signal.addEventListener('abort', onAbort, { once: true })
      abortListenerAttached = true
      if (init.signal.aborted) {
        onAbort()
        return
      }
    }

    try {
      if (serialized.body) request.write(serialized.body)
      request.end()
    } catch (error) {
      request.destroy(asError(error))
      rejectBeforeResponse(error)
    }
  })
}

function nodeRequestOptions(
  endpoint: ValidatedProviderEndpoint,
  pinnedAddress: ProviderResolvedAddress,
  method: 'GET' | 'HEAD' | 'POST',
  initHeaders: Headers,
  requestBody: Uint8Array | null,
): NodeRequestOptions {
  const headers = new Headers(initHeaders)
  for (const name of FORBIDDEN_REQUEST_HEADERS) headers.delete(name)
  headers.set('host', endpoint.url.host)
  if (requestBody) headers.set('content-length', String(requestBody.byteLength))

  const requestOptions: NodeRequestOptions = {
    protocol: endpoint.url.protocol,
    hostname: endpoint.hostname,
    path: `${endpoint.url.pathname}${endpoint.url.search}`,
    method,
    headers: Object.fromEntries(headers.entries()),
    family: pinnedAddress.family,
    lookup: pinnedLookup(endpoint.hostname, pinnedAddress),
    // A shared Agent could reuse a socket opened before this endpoint was validated.
    // A one-shot Agent forces every request through the pinned lookup above.
    agent: false,
  }
  if (endpoint.url.port) requestOptions.port = Number(endpoint.url.port)
  if (endpoint.url.protocol === 'https:') requestOptions.servername = endpoint.hostname
  return requestOptions
}

async function serializeRequest(
  endpoint: ValidatedProviderEndpoint,
  init: RequestInit,
  method: string,
  allowRequestBody: boolean,
): Promise<{ headers: Headers; body: Uint8Array | null }> {
  if (init.body === undefined || init.body === null) {
    return { headers: new Headers(init.headers), body: null }
  }
  if (!allowRequestBody) throw new ProviderNodeTransportError('request_body_forbidden')
  if (method !== 'POST' || init.body instanceof ReadableStream) {
    throw new ProviderNodeTransportError('request_body_unsupported')
  }

  try {
    const request = new Request(endpoint.url, {
      method,
      headers: init.headers ?? {},
      body: init.body,
      ...(init.signal ? { signal: init.signal } : {}),
    })
    return {
      headers: new Headers(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
    }
  } catch (error) {
    if (init.signal?.aborted) throw abortReason(init.signal)
    throw new ProviderNodeTransportError('request_body_unsupported', { cause: error })
  }
}

function pinnedLookup(
  expectedHostname: string,
  pinnedAddress: ProviderResolvedAddress,
): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    if (hostname !== expectedHostname) {
      const error = new Error(
        'Pinned provider lookup received an unexpected hostname',
      ) as NodeJS.ErrnoException
      error.code = 'EAI_FAIL'
      callback(error, '', 0)
      return
    }

    if (lookupOptions.all) {
      callback(null, [{ address: pinnedAddress.address, family: pinnedAddress.family }])
      return
    }
    callback(null, pinnedAddress.address, pinnedAddress.family)
  }
}

function boundedResponseBody(
  incoming: IncomingMessage,
  request: ClientRequest,
  maxResponseBytes: number,
  removeAbortListener: () => void,
): ReadableStream<Uint8Array> {
  let totalBytes = 0
  let done = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null

  const detach = () => {
    incoming.off('data', onData)
    incoming.off('end', onEnd)
    incoming.off('error', onError)
    incoming.off('aborted', onAborted)
    incoming.off('close', onClose)
    removeAbortListener()
  }
  const fail = (error: Error, destroy = false) => {
    if (done) return
    done = true
    detach()
    controller?.error(error)
    if (destroy) {
      safelyDestroyIncoming(incoming, error)
      request.destroy(error)
    }
  }
  const onData = (chunk: Buffer) => {
    const bytes = Uint8Array.from(chunk)
    if (bytes.byteLength > maxResponseBytes - totalBytes) {
      fail(new ProviderNodeTransportError('response_too_large'), true)
      return
    }
    totalBytes += bytes.byteLength
    controller?.enqueue(bytes)
    if ((controller?.desiredSize ?? 1) <= 0) incoming.pause()
  }
  const onEnd = () => {
    if (done) return
    done = true
    detach()
    controller?.close()
  }
  const onError = (error: Error) => fail(error)
  const onAborted = () => fail(new ProviderNodeTransportError('response_aborted'), true)
  const onClose = () => {
    if (!done && !incoming.complete) {
      fail(new ProviderNodeTransportError('response_aborted'), true)
    }
  }

  incoming.pause()
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController
      incoming.on('data', onData)
      incoming.once('end', onEnd)
      incoming.once('error', onError)
      incoming.once('aborted', onAborted)
      incoming.once('close', onClose)
    },
    pull() {
      if (!done) incoming.resume()
    },
    cancel(reason) {
      if (done) return
      done = true
      detach()
      incoming.destroy()
      request.destroy(reason instanceof Error ? reason : undefined)
    },
  })
}

function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

function rejectOversizedContentLength(incoming: IncomingMessage, maxResponseBytes: number): void {
  const value = incoming.headers['content-length']
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return
  const declaredBytes = Number(value)
  if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxResponseBytes) {
    throw new ProviderNodeTransportError('response_too_large')
  }
}

function validResponseStatus(status: number | undefined): number {
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599) {
    throw new ProviderNodeTransportError('invalid_response_status')
  }
  return status
}

function validatedMaximum(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderNodeTransportError('invalid_max_response_bytes')
  }
  return value
}

function assertPinnedAddress(
  endpoint: ValidatedProviderEndpoint,
  pinnedAddress: ProviderResolvedAddress,
): void {
  const addressFamily = isIP(pinnedAddress.address)
  if (addressFamily !== pinnedAddress.family) {
    throw new ProviderNodeTransportError('validated_address_mismatch')
  }

  const hostnameFamily = isIP(endpoint.hostname)
  if (
    hostnameFamily !== 0 &&
    (hostnameFamily !== pinnedAddress.family || endpoint.hostname !== pinnedAddress.address)
  ) {
    throw new ProviderNodeTransportError('validated_address_mismatch')
  }
}

function abortReason(signal: AbortSignal | null | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function safelyDestroyIncoming(incoming: IncomingMessage, error: Error): void {
  incoming.once('error', () => undefined)
  incoming.destroy(error)
}
