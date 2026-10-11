import { createConnection } from 'node:net'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startLocalOcrRelay } from '../services/ocr/local-ocr-relay.js'
import type { LocalOcrRuntime, LocalOcrTargetSnapshot } from '../services/ocr/local-ocr-runtime.js'

function target(): LocalOcrTargetSnapshot {
  const url = new URL('http://wsl-host.echolike.invalid:11434/api/generate')
  return {
    logicalEndpoint: url.toString(),
    model: 'glm-ocr:latest',
    source: 'wsl-windows-host',
    fingerprint: 'target-a',
    validated: {
      url,
      origin: url.origin,
      hostname: url.hostname,
      addresses: [{ address: '172.26.128.1', family: 4, scope: 'private' }],
      network: 'explicit_local',
    },
  }
}

function runtimeWithRequest(request: LocalOcrRuntime['request']): LocalOcrRuntime {
  return {
    async resolveCurrent() {
      return target()
    },
    async resolveConfig() {
      return target()
    },
    request,
    async probe() {
      return { available: true, reason: 'ok' }
    },
  }
}

describe('server-owned PDF OCR loopback relay', () => {
  it('pins the target and canonicalizes Pipeline requests to the 16K GLM contract', async () => {
    const request = vi.fn(async (_target: LocalOcrTargetSnapshot, _init: RequestInit) =>
      Response.json({ response: 'recognized', done: true, done_reason: 'stop' }),
    )
    const controller = new AbortController()
    const relay = await startLocalOcrRelay(runtimeWithRequest(request), target(), controller.signal)

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'glm-ocr:latest',
          prompt: 'Text Recognition:',
          images: ['aW1hZ2U='],
          stream: false,
          ignored: 'field',
          options: {
            num_ctx: 4096,
            num_predict: 8192,
            temperature: 0,
            top_p: 0.00001,
            top_k: 1,
            repeat_penalty: 1.1,
            ignored: 123,
          },
        }),
        redirect: 'manual',
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ response: 'recognized', done: true })
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0]?.[0]).toMatchObject({
        fingerprint: 'target-a',
        validated: { addresses: [expect.objectContaining({ address: '172.26.128.1' })] },
      })
      expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'manual' })
      const forwarded = JSON.parse(String(request.mock.calls[0]?.[1].body))
      expect(forwarded).toEqual({
        model: 'glm-ocr:latest',
        prompt: 'Text Recognition:',
        images: ['aW1hZ2U='],
        stream: false,
        options: {
          num_ctx: 16_384,
          num_predict: 8_192,
          temperature: 0,
          top_p: 0.00001,
          top_k: 1,
          repeat_penalty: 1.1,
        },
      })
      expect(relay.snapshot()).toEqual({
        warmupAccepted: 0,
        formalAccepted: 1,
        formalTerminal: 1,
        formalNonEmpty: 1,
        formalEmpty: 0,
        fatal: false,
        active: 0,
      })
    } finally {
      await relay.close()
    }
  })

  it('accepts the official no-image warmup while retaining the same context fence', async () => {
    const request = vi.fn(async (_target: LocalOcrTargetSnapshot, _init: RequestInit) =>
      Response.json({ response: 'warmup token limit', done: true, done_reason: 'length' }),
    )
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          model: 'glm-ocr:latest',
          prompt: 'hello',
          stream: false,
          options: { num_predict: 10 },
        }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        response: 'warmup token limit',
        done: true,
        done_reason: 'stop',
      })
      expect(JSON.parse(String(request.mock.calls[0]?.[1].body))).toMatchObject({
        options: { num_ctx: 16_384, num_predict: 10 },
      })
      expect(relay.snapshot()).toEqual({
        warmupAccepted: 1,
        formalAccepted: 0,
        formalTerminal: 0,
        formalNonEmpty: 0,
        formalEmpty: 0,
        fatal: false,
        active: 0,
      })
    } finally {
      await relay.close()
    }
  })

  it('routes recovery images through the same pinned target and official sampling contract', async () => {
    const request = vi.fn(async (_target: LocalOcrTargetSnapshot, _init: RequestInit) =>
      Response.json({ response: 'recovered text', done: true, done_reason: 'stop' }),
    )
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      await expect(relay.recognizeImage(Buffer.from('image'))).resolves.toBe('recovered text')
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0]?.[0].fingerprint).toBe('target-a')
      expect(JSON.parse(String(request.mock.calls[0]?.[1].body))).toEqual({
        model: 'glm-ocr:latest',
        prompt: 'Text Recognition:',
        images: [Buffer.from('image').toString('base64')],
        stream: false,
        options: {
          num_ctx: 16_384,
          num_predict: 8_192,
          temperature: 0,
          top_p: 0.00001,
          top_k: 1,
          repeat_penalty: 1.1,
        },
      })
      expect(relay.snapshot()).toMatchObject({
        formalAccepted: 1,
        formalTerminal: 1,
        formalNonEmpty: 1,
        formalEmpty: 0,
        fatal: false,
      })
    } finally {
      await relay.close()
    }
  })

  it('rejects a terminal empty formal response and records fatal evidence', async () => {
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(async () =>
        Response.json({ response: ' \n ', done: true, done_reason: 'stop' }),
      ),
      target(),
      new AbortController().signal,
    )

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody({ images: ['aW1hZ2U='] }),
      })
      expect(response.status).toBe(422)
      expect(relay.snapshot()).toMatchObject({
        formalAccepted: 1,
        formalTerminal: 1,
        formalNonEmpty: 0,
        formalEmpty: 1,
        fatal: true,
        active: 0,
      })
    } finally {
      await relay.close()
    }
  })

  it('keeps fatal evidence irreversible after a later successful formal response', async () => {
    const responses = [
      { response: ' ', done: true, done_reason: 'stop' },
      { response: 'later success', done: true, done_reason: 'stop' },
    ]
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(async () => Response.json(responses.shift())),
      target(),
      new AbortController().signal,
    )

    try {
      const failed = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody({ images: ['aW1hZ2U='] }),
      })
      expect(failed.status).toBe(422)
      const succeeded = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody({ images: ['aW1hZ2U='] }),
      })
      expect(succeeded.status).toBe(200)
      expect(relay.snapshot()).toMatchObject({
        formalAccepted: 2,
        formalTerminal: 2,
        formalNonEmpty: 1,
        formalEmpty: 1,
        fatal: true,
      })
    } finally {
      await relay.close()
    }
  })

  it('rejects an empty images array instead of classifying it as a formal request', async () => {
    const request = vi.fn(async () =>
      Response.json({ response: 'must not run', done: true, done_reason: 'stop' }),
    )
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody({ images: [] }),
      })
      expect(response.status).toBe(422)
      expect(request).not.toHaveBeenCalled()
      expect(relay.snapshot()).toEqual({
        warmupAccepted: 0,
        formalAccepted: 0,
        formalTerminal: 0,
        formalNonEmpty: 0,
        formalEmpty: 0,
        fatal: true,
        active: 0,
      })
      expect(Object.keys(relay.snapshot()).sort()).not.toEqual(
        expect.arrayContaining(['endpoint', 'model', 'request', 'response', 'token']),
      )
    } finally {
      await relay.close()
    }
  })

  it('turns every upstream redirect into a terminal 502 without forwarding Location', async () => {
    const request = vi.fn(
      async (_target: LocalOcrTargetSnapshot, _init: RequestInit) =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
    )
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody(),
        redirect: 'manual',
      })
      expect(response.status).toBe(502)
      expect(response.headers.get('location')).toBeNull()
      await expect(response.json()).resolves.toEqual({ error: 'upstream_status' })
      expect(request).toHaveBeenCalledTimes(1)
    } finally {
      await relay.close()
    }
  })

  it('rejects wrong paths, methods, content types, and model switches before upstream', async () => {
    const request = vi.fn(async (_target: LocalOcrTargetSnapshot, _init: RequestInit) =>
      Response.json({ ok: true }),
    )
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      const endpoint = new URL(relay.endpoint)
      const cases: Array<[string, RequestInit]> = [
        [`${endpoint.origin}/api/generate`, { method: 'POST', body: '{}' }],
        [relay.endpoint, { method: 'GET' }],
        [relay.endpoint, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }],
        [
          relay.endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json-patch+json' },
            body: validRequestBody(),
          },
        ],
        [
          relay.endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: validRequestBody({ model: 'other-model' }),
          },
        ],
        [
          relay.endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: validRequestBody({ stream: true }),
          },
        ],
        [
          relay.endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: validRequestBody({ options: { num_predict: 8193 } }),
          },
        ],
      ]
      for (const [url, init] of cases) {
        const response = await fetch(url, { ...init, redirect: 'manual' })
        expect(response.status).toBeGreaterThanOrEqual(400)
      }
      expect(request).not.toHaveBeenCalled()
    } finally {
      await relay.close()
    }
  })

  it('rejects non-terminal Ollama completions without triggering Pipeline 5xx retries', async () => {
    const upstreamBodies = [
      { response: 'truncated', done: true, done_reason: 'length' },
      { response: 'partial', done: false },
      { done: true, done_reason: 'stop' },
    ]
    const request = vi.fn(async () => Response.json(upstreamBodies.shift()))
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(request),
      target(),
      new AbortController().signal,
    )

    try {
      for (let index = 0; index < 3; index += 1) {
        const response = await fetch(relay.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: validRequestBody({ images: ['aW1hZ2U='] }),
        })
        expect(response.status).toBe(422)
        await expect(response.json()).resolves.toEqual({ error: 'upstream_incomplete' })
      }
      expect(request).toHaveBeenCalledTimes(3)
      expect(relay.snapshot()).toMatchObject({
        formalAccepted: 3,
        formalTerminal: 0,
        fatal: true,
      })
    } finally {
      await relay.close()
    }
  })

  it('classifies malformed upstream JSON separately from deterministic incomplete output', async () => {
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(async () => new Response('{bad-json')),
      target(),
      new AbortController().signal,
    )

    try {
      const response = await fetch(relay.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validRequestBody(),
      })
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({ error: 'upstream_invalid_response' })
      expect(relay.snapshot()).toMatchObject({ fatal: true })
    } finally {
      await relay.close()
    }
  })

  it('binds parent cancellation to the active upstream and closes the relay', async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const upstreamSignals: AbortSignal[] = []
    const runtime = runtimeWithRequest(async (_target, init) => {
      const upstreamSignal = init.signal as AbortSignal
      upstreamSignals.push(upstreamSignal)
      markStarted()
      await new Promise<void>((_resolve, reject) => {
        upstreamSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return Response.json({ ok: true })
    })
    const controller = new AbortController()
    const relay = await startLocalOcrRelay(runtime, target(), controller.signal)
    const pending = fetch(relay.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validRequestBody(),
    }).catch((error: unknown) => error)

    await started
    controller.abort('cancelled')
    await expect(pending).resolves.toBeInstanceOf(Error)
    expect(upstreamSignals[0]?.aborted).toBe(true)
    await relay.close()
  })

  it('aborts upstream inference when the loopback client disconnects', async () => {
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const upstreamSignals: AbortSignal[] = []
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(async (_target, init) => {
        const upstreamSignal = init.signal as AbortSignal
        upstreamSignals.push(upstreamSignal)
        markStarted()
        await new Promise<void>((_resolve, reject) => {
          upstreamSignal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
        return Response.json({ response: 'late', done: true, done_reason: 'stop' })
      }),
      target(),
      new AbortController().signal,
    )
    const client = new AbortController()
    const pending = fetch(relay.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validRequestBody(),
      signal: client.signal,
    }).catch((error: unknown) => error)

    await started
    client.abort()
    await expect(pending).resolves.toBeInstanceOf(Error)
    await vi.waitFor(() => expect(upstreamSignals[0]?.aborted).toBe(true))
    await relay.close()
  })

  it('closes idempotently without waiting for a client that stalls mid-body', async () => {
    const relay = await startLocalOcrRelay(
      runtimeWithRequest(async () => {
        throw new Error('slow body must never reach upstream')
      }),
      target(),
      new AbortController().signal,
    )
    const endpoint = new URL(relay.endpoint)
    const socket = createConnection({ host: '127.0.0.1', port: Number(endpoint.port) })
    socket.on('error', () => undefined)
    await once(socket, 'connect')
    socket.write(
      `POST ${endpoint.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${endpoint.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":`,
    )

    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    await Promise.all([relay.close(), relay.close()])
    await socketClosed
    expect(socket.destroyed).toBe(true)
  })
})

function validRequestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'glm-ocr:latest',
    prompt: 'Text Recognition:',
    stream: false,
    options: { num_predict: 8192 },
    ...overrides,
  })
}
