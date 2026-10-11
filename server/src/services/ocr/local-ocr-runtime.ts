import type { ServerEnv } from '../../env.js'
import type { DesktopConfigService } from '../desktop/desktop-config-service.js'
import { resolveOcrProviderConfig, type OcrProviderConfig } from '../proxy/provider-config.js'
import { providerPreset, resolvePresetEndpoint } from '../proxy/provider-presets.js'
import {
  validateProviderEndpoint,
  type ProviderAddressResolver,
  type ProviderEgressTransport,
  type ValidatedProviderEndpoint,
} from '../security/provider-egress-policy.js'
import { createProviderNodeTransport } from '../security/provider-node-transport.js'
import {
  isWslWindowsHostEndpointFor,
  providerRuntimeAddressResolver,
  WSL_WINDOWS_HOSTNAME,
} from '../security/provider-runtime-address.js'

const LOCAL_OCR_PROVIDER = 'ollama-ocr-local'
const LOCAL_OCR_PROTOCOL = 'ollama-generate'
const LOCAL_OCR_PROBE_MAX_BYTES = 512 * 1024
const LOCAL_OCR_RESPONSE_MAX_BYTES = 2 * 1024 * 1024
const LOCAL_OCR_PROBE_DEADLINE_MS = 1_000
const LOCAL_OCR_PROBE_CACHE_MS = 30_000

const localOcrPreset = providerPreset('ocr', LOCAL_OCR_PROVIDER)
const productLocalEndpoint = localOcrPreset ? resolvePresetEndpoint(localOcrPreset, null) : null

export type LocalOcrTargetSource = 'configured' | 'wsl-windows-host'

export interface LocalOcrTargetSnapshot {
  logicalEndpoint: string
  model: string
  source: LocalOcrTargetSource
  fingerprint: string
  validated: ValidatedProviderEndpoint
}

export type LocalOcrProbeResult =
  | { available: true; reason: 'ok' }
  | {
      available: false
      reason:
        | 'unreachable'
        | 'upstream_status'
        | 'invalid_response'
        | 'model_missing'
        | 'superseded'
    }

export interface LocalOcrRuntime {
  resolveCurrent(signal?: AbortSignal): Promise<LocalOcrTargetSnapshot>
  resolveConfig(config: OcrProviderConfig, signal?: AbortSignal): Promise<LocalOcrTargetSnapshot>
  request(target: LocalOcrTargetSnapshot, init: RequestInit): Promise<Response>
  probe(
    target: LocalOcrTargetSnapshot,
    signal?: AbortSignal,
    options?: { force?: boolean },
  ): Promise<LocalOcrProbeResult>
}

export interface LocalOcrRuntimeOptions {
  resolver?: ProviderAddressResolver
  transport?: ProviderEgressTransport
}

export function createLocalOcrRuntime(
  env: ServerEnv,
  desktopConfig: DesktopConfigService,
  options: LocalOcrRuntimeOptions = {},
): LocalOcrRuntime {
  const resolver = options.resolver ?? providerRuntimeAddressResolver
  const transport =
    options.transport ??
    createProviderNodeTransport({
      maxResponseBytes: LOCAL_OCR_RESPONSE_MAX_BYTES,
      allowRequestBody: true,
    })
  const probeCache = new Map<string, { checkedAt: number; result: LocalOcrProbeResult }>()
  const probeGenerations = new Map<string, number>()

  const resolveConfig = async (
    config: OcrProviderConfig,
    signal?: AbortSignal,
  ): Promise<LocalOcrTargetSnapshot> => {
    assertLocalOcrConfig(config)
    const logicalUrl = localOcrUrl(config.endpoint)
    const aliasTarget = logicalUrl.hostname.toLowerCase() === WSL_WINDOWS_HOSTNAME
    if (aliasTarget && !isWslWindowsHostEndpointFor(logicalUrl.toString(), productLocalEndpoint)) {
      throw localOcrRuntimeError('endpoint_invalid')
    }
    const validated = await validateProviderEndpoint(
      logicalUrl,
      { allowedLocalOrigins: [logicalUrl.origin] },
      resolver,
      signal,
    )
    const source: LocalOcrTargetSource = aliasTarget ? 'wsl-windows-host' : 'configured'
    return {
      logicalEndpoint: logicalUrl.toString(),
      model: config.model,
      source,
      fingerprint: targetFingerprint(logicalUrl, config.model, validated),
      validated,
    }
  }

  return {
    async resolveCurrent(signal) {
      const config = await resolveOcrProviderConfig(env, desktopConfig)
      return await resolveConfig(config, signal)
    },

    resolveConfig,

    async request(target, init) {
      if (init.signal?.aborted) throw abortReason(init.signal)
      return await transport.request(target.validated, { ...init, redirect: 'manual' })
    },

    async probe(target, signal, probeOptions = {}) {
      if (probeOptions.force) probeCache.delete(target.fingerprint)
      const cached = probeCache.get(target.fingerprint)
      if (
        !probeOptions.force &&
        cached &&
        Date.now() - cached.checkedAt < LOCAL_OCR_PROBE_CACHE_MS
      ) {
        return cached.result
      }
      const generation = (probeGenerations.get(target.fingerprint) ?? 0) + 1
      probeGenerations.set(target.fingerprint, generation)
      const isCurrentProbe = () => probeGenerations.get(target.fingerprint) === generation
      const superseded: LocalOcrProbeResult = { available: false, reason: 'superseded' }
      const deadline = createProbeDeadline(signal)
      const tagsEndpoint = endpointWithPath(target.validated, '/api/tags')
      let response: Response
      try {
        response = await transport.request(tagsEndpoint, {
          method: 'GET',
          signal: deadline.signal,
          redirect: 'manual',
        })
      } catch (error) {
        deadline.dispose()
        if (signal?.aborted) throw abortReason(signal)
        if (!isCurrentProbe()) return superseded
        probeCache.delete(target.fingerprint)
        return { available: false, reason: 'unreachable' }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        deadline.dispose()
        if (!isCurrentProbe()) return superseded
        probeCache.delete(target.fingerprint)
        return { available: false, reason: 'upstream_status' }
      }
      let body: unknown
      try {
        const declaredLength = response.headers.get('content-length')
        if (declaredLength && Number(declaredLength) > LOCAL_OCR_PROBE_MAX_BYTES) {
          await response.body?.cancel().catch(() => undefined)
          deadline.dispose()
          if (!isCurrentProbe()) return superseded
          probeCache.delete(target.fingerprint)
          return { available: false, reason: 'invalid_response' }
        }
        body = await readBoundedJson(response, LOCAL_OCR_PROBE_MAX_BYTES, deadline.signal)
      } catch (error) {
        deadline.dispose()
        if (signal?.aborted) throw abortReason(signal)
        if (!isCurrentProbe()) return superseded
        probeCache.delete(target.fingerprint)
        return { available: false, reason: 'invalid_response' }
      }
      deadline.dispose()
      if (!isCurrentProbe()) return superseded
      const result: LocalOcrProbeResult = ollamaModelIds(body).some((model) =>
        sameOllamaModel(model, target.model),
      )
        ? { available: true, reason: 'ok' }
        : { available: false, reason: 'model_missing' }
      if (result.available) {
        probeCache.set(target.fingerprint, { checkedAt: Date.now(), result })
      } else {
        probeCache.delete(target.fingerprint)
      }
      return result
    },
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal)
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw localOcrRuntimeError('probe_response_too_large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const text = new TextDecoder().decode(concatenate(chunks, total))
  return JSON.parse(text) as unknown
}

function concatenate(chunks: Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function createProbeDeadline(parent?: AbortSignal) {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onParentAbort, { once: true })
  if (parent?.aborted) onParentAbort()
  const timer = setTimeout(
    () => controller.abort('local-ocr-probe-deadline'),
    LOCAL_OCR_PROBE_DEADLINE_MS,
  )
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

function assertLocalOcrConfig(config: OcrProviderConfig): void {
  if (config.provider !== LOCAL_OCR_PROVIDER || config.protocol !== LOCAL_OCR_PROTOCOL) {
    throw localOcrRuntimeError('provider_mismatch')
  }
}

function localOcrUrl(endpoint: string): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw localOcrRuntimeError('endpoint_invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw localOcrRuntimeError('endpoint_invalid')
  }
  return url
}

function endpointWithPath(
  endpoint: ValidatedProviderEndpoint,
  pathname: string,
): ValidatedProviderEndpoint {
  const url = new URL(endpoint.url)
  url.pathname = pathname
  url.search = ''
  url.hash = ''
  return { ...endpoint, url }
}

function targetFingerprint(
  logicalUrl: URL,
  model: string,
  endpoint: ValidatedProviderEndpoint,
): string {
  const addresses = endpoint.addresses
    .map((address) => `${address.family}:${address.address}:${address.scope}`)
    .sort()
    .join(',')
  return `${logicalUrl.toString()}|${model}|${addresses}`
}

function ollamaModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const models = (body as Record<string, unknown>).models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const item of models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    for (const value of [record.name, record.model]) {
      if (typeof value === 'string' && value.trim()) ids.push(value.trim())
    }
  }
  return ids
}

function sameOllamaModel(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const model = value.trim().toLowerCase()
    return model.includes(':') ? model : `${model}:latest`
  }
  return normalize(left) === normalize(right)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function localOcrRuntimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Local OCR runtime failed: ${code}`), { code })
}
