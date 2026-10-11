import { ApiError } from '../../errors.js'
import type {
  ProviderKind,
  ProviderModelRecord,
  ProviderRegistryInput,
  ProviderRegistryRecord,
} from '../desktop/desktop-config-service.js'
import {
  providerPreset,
  resolvePresetEndpoint,
  type ProviderPreset,
} from '../proxy/provider-presets.js'
import {
  requestProviderEndpoint,
  sameProviderOrigin,
  validateProviderEndpoint,
  validateProviderEndpointShape,
  type ProviderAddressResolver,
  type ProviderEgressTransport,
  type ProviderEndpointPolicy,
} from './provider-egress-policy.js'
import { createProviderNodeTransport } from './provider-node-transport.js'
import {
  isWslWindowsHostEndpointFor,
  providerRuntimeAddressResolver,
} from './provider-runtime-address.js'

export interface ProviderControlService {
  assertSavable(input: {
    provider: ProviderRegistryInput
    existing: ProviderRegistryRecord | null
    signal?: AbortSignal
  }): Promise<void>
  listModels(input: {
    kind: ProviderKind
    providerId: string
    endpoint: string
    apiKey: string | null
    /** Server-authoritative active native endpoint; never populate this from the request body. */
    trustedLocalEndpoint?: string | null
    signal?: AbortSignal
  }): Promise<ProviderModelRecord[]>
}

export interface ProviderControlServiceOptions {
  deadlineMs: number
  maxInFlight: number
  resolver?: ProviderAddressResolver
  transport?: ProviderEgressTransport
}

const MODEL_RESPONSE_LIMIT_BYTES = 512 * 1024

export function createProviderControlService(
  options: ProviderControlServiceOptions,
): ProviderControlService {
  if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new Error('Provider control deadline must be a positive integer')
  }
  if (!Number.isSafeInteger(options.maxInFlight) || options.maxInFlight <= 0) {
    throw new Error('Provider control concurrency must be a positive integer')
  }
  const resolver = options.resolver ?? providerRuntimeAddressResolver
  const transport =
    options.transport ??
    createProviderNodeTransport({ maxResponseBytes: MODEL_RESPONSE_LIMIT_BYTES })

  let inFlight = 0
  const runBounded = async <T>(
    callerSignal: AbortSignal | undefined,
    operation: (scope: ProviderControlRequestScope) => Promise<T>,
  ): Promise<T> => {
    if (inFlight >= options.maxInFlight) {
      throw new ApiError(429, 'provider_busy', '服务地址检查正在执行，请等待当前操作完成')
    }
    inFlight += 1
    const scope = createProviderControlRequestScope(options.deadlineMs, callerSignal)
    try {
      return await operation(scope)
    } finally {
      scope.dispose()
      inFlight -= 1
    }
  }

  return {
    async assertSavable({ provider, existing, signal }) {
      if (provider.endpoint?.trim()) {
        try {
          validateProviderEndpointShape(provider.endpoint)
        } catch (error) {
          throw providerEndpointError(error)
        }
      }
      if (!provider.enabled) return
      return await runBounded(signal, async (scope) => {
        const preset = requiredPreset(provider.kind, provider.providerId)
        const endpoint = resolvePresetEndpoint(preset, provider.endpoint)
        if (!endpoint) throw validationError('启用服务前必须填写有效的后端服务地址')

        assertEnabledCredential(provider, existing, preset, endpoint)
        if (
          provider.kind !== 'stt' &&
          !(provider.defaultModel?.trim() || preset.defaultModel?.trim())
        ) {
          throw validationError('启用服务前必须选择默认模型')
        }

        await scope
          .wait(
            validateProviderEndpoint(endpoint, endpointPolicy(preset, null, endpoint), resolver),
          )
          .catch((error) => {
            if (scope.failure()) throw scope.failure()
            throw providerEndpointError(error)
          })
      })
    },

    async listModels(input) {
      return await runBounded(input.signal, async (scope) => {
        const preset = requiredPreset(input.kind, input.providerId)
        const candidates = providerModelEndpointCandidates(input.providerId, input.endpoint)
        let lastFailure: unknown = null

        for (const url of candidates) {
          if (scope.failure()) throw scope.failure()
          try {
            const headers = new Headers()
            if (input.apiKey) headers.set('authorization', `Bearer ${input.apiKey}`)
            const { response } = await scope.wait(
              requestProviderEndpoint(
                url,
                { method: 'GET', headers, signal: scope.signal },
                {
                  resolver,
                  transport,
                  policy: endpointPolicy(preset, input.trustedLocalEndpoint, input.endpoint),
                },
              ),
            )
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined)
              lastFailure = new Error(`HTTP ${response.status}`)
              continue
            }
            const body = await scope.wait(
              response.json().catch((error) => {
                throw new Error('Provider returned invalid JSON', { cause: error })
              }),
            )
            const models = extractProviderModels(body)
            if (models.length) return models
            lastFailure = new Error('Provider returned an empty model list')
          } catch (error) {
            if (scope.failure()) throw scope.failure()
            lastFailure = error
          }
        }

        throw new ApiError(502, 'provider_failed', providerFailureMessage(lastFailure))
      })
    },
  }
}

interface ProviderControlRequestScope {
  signal: AbortSignal
  wait<T>(operation: Promise<T>): Promise<T>
  failure(): Error | null
  dispose(): void
}

function createProviderControlRequestScope(
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
): ProviderControlRequestScope {
  const controller = new AbortController()
  let currentFailure: Error | null = null
  let rejectFailure: (error: Error) => void = () => undefined
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  void failed.catch(() => undefined)
  const fail = (error: Error) => {
    if (currentFailure) return
    currentFailure = error
    controller.abort(error)
    rejectFailure(error)
  }
  const onCallerAbort = () => fail(abortError(callerSignal))
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  if (callerSignal?.aborted) onCallerAbort()
  const timer = setTimeout(
    () => fail(new ApiError(504, 'provider_timeout', '服务地址检查超时')),
    deadlineMs,
  )

  return {
    signal: controller.signal,
    wait<T>(operation: Promise<T>) {
      return Promise.race([operation, failed])
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

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function requiredPreset(kind: ProviderKind, providerId: string): ProviderPreset {
  const preset = providerPreset(kind, providerId)
  if (!preset) throw validationError(`${kind} provider is not supported`)
  return preset
}

function assertEnabledCredential(
  provider: ProviderRegistryInput,
  existing: ProviderRegistryRecord | null,
  preset: ProviderPreset,
  endpoint: string,
): void {
  if (!preset.capabilities.requiresApiKey) return
  const submittedKey = provider.apiKey?.trim() ?? ''
  const hasNewKey = Boolean(submittedKey && !submittedKey.includes('****'))
  if (hasNewKey) return

  const previousEndpoint = existing
    ? resolvePresetEndpoint(requiredPreset(existing.kind, existing.providerId), existing.endpoint)
    : null
  const canReuseExistingKey = Boolean(
    existing?.apiKeyPreview && previousEndpoint && sameProviderOrigin(previousEndpoint, endpoint),
  )
  if (!canReuseExistingKey) {
    throw validationError('启用该服务需要重新输入 API 密钥')
  }
}

function endpointPolicy(
  preset: ProviderPreset,
  trustedLocalEndpoint: string | null | undefined = null,
  candidateEndpoint: string | null | undefined = null,
): ProviderEndpointPolicy {
  const origins = new Set<string>()
  const endpointValues: Array<string | null | undefined> = [preset.baseUrl, preset.endpoint]
  if (preset.protocol !== 'openai') endpointValues.push(trustedLocalEndpoint)
  for (const value of endpointValues) {
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'http:') origins.add(url.origin)
    } catch {
      // Invalid product presets are rejected later by the endpoint validator.
    }
  }
  const productLocalEndpoint = preset.endpoint ?? preset.baseUrl
  if (
    candidateEndpoint &&
    preset.protocol !== 'openai' &&
    isWslWindowsHostEndpointFor(candidateEndpoint, productLocalEndpoint)
  ) {
    origins.add(new URL(candidateEndpoint).origin)
  }
  return { allowedLocalOrigins: [...origins] }
}

function providerModelEndpointCandidates(providerId: string, endpoint: string): string[] {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw validationError('后端服务地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw validationError('后端服务地址必须使用 HTTP 或 HTTPS')
  }

  const origin = parsed.origin
  const path = parsed.pathname.replace(/\/+$/, '')
  const candidates: string[] = []
  if (providerId.includes('ollama')) {
    const v1Index = path.indexOf('/v1')
    candidates.push(
      v1Index >= 0 ? `${origin}${path.slice(0, v1Index + 3)}/models` : `${origin}/v1/models`,
    )
    candidates.push(`${origin}/api/tags`)
  } else if (path.endsWith('/chat/completions')) {
    candidates.push(`${origin}${path.slice(0, -'/chat/completions'.length)}/models`)
  } else if (path.endsWith('/audio/speech')) {
    candidates.push(`${origin}${path.slice(0, -'/audio/speech'.length)}/models`)
  } else if (path.endsWith('/models')) {
    candidates.push(trimmed)
  } else {
    candidates.push(`${trimmed}/models`)
  }
  return [...new Set(candidates)]
}

function extractProviderModels(body: unknown): ProviderModelRecord[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const record = body as Record<string, unknown>
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const seen = new Set<string>()
  const models: ProviderModelRecord[] = []
  for (const item of rows) {
    const id = modelId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, label: id })
    if (models.length >= 100) break
  }
  return models
}

function modelId(item: unknown): string | null {
  if (typeof item === 'string') return boundedModelId(item)
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  for (const key of ['id', 'name', 'model']) {
    const value = record[key]
    if (typeof value === 'string') {
      const id = boundedModelId(value)
      if (id) return id
    }
  }
  return null
}

function boundedModelId(value: string): string | null {
  const id = value.trim()
  return id && id.length <= 180 ? id : null
}

function validationError(message: string): ApiError {
  return new ApiError(422, 'validation_failed', message)
}

function providerEndpointError(error: unknown): ApiError {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'endpoint_rejected'
  return validationError(`后端服务地址被安全策略拒绝（${code}）`)
}

function providerFailureMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code ? `模型读取失败（${code}）` : '模型读取失败，请检查服务地址、密钥和网络状态'
}
