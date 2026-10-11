import type { Plan, PlanLimits } from './types.js'
import { apiBasePathFromPublicUrl } from './paths.js'

export interface ServerEnv {
  nodeEnv: 'development' | 'test' | 'production'
  port: number
  publicApiBaseUrl: string
  apiBasePath: string
  databaseUrl: string
  redisUrl: string | null
  corsAllowedOrigins: string[]
  betterAuthSecret: string
  betterAuthUrl: string
  googleClientId: string | null
  googleClientSecret: string | null
  githubClientId: string | null
  githubClientSecret: string | null
  stripeSecretKey: string | null
  stripeWebhookSecret: string | null
  stripeProPriceId: string | null
  sttProvider: string | null
  sttApiKey: string | null
  sttBaseUrl: string | null
  sttModel: string | null
  llmProvider: string | null
  llmApiKey: string | null
  llmBaseUrl: string | null
  llmModel: string | null
  ttsProvider: string | null
  ttsApiKey: string | null
  ttsBaseUrl: string | null
  ttsModel: string | null
  ttsVoice: string | null
  providerControlDeadlineMs: number
  providerControlMaxInFlight: number
  glmocrPipelineBin: string | null
  glmocrPipelinePython: string | null
  desktopAutoUpdateEnabled: boolean
  desktopUpdateEnabled: boolean
  desktopUpdateForce: boolean
  desktopUpdateLatestVersion: string
  desktopUpdateMinVersion: string | null
  desktopUpdateDownloadUrl: string | null
  desktopUpdateSha256: string | null
  desktopUpdateSignature: string | null
  desktopUpdateReleaseNotes: string | null
  tauriUpdaterPublicKey: string | null
  planLimits: Record<Plan, PlanLimits>
}

const PLACEHOLDER_RE = /replace|example|changeme|placeholder/i
const DEV_CORS_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://tauri.localhost',
  'tauri://localhost',
]

function requireValue(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key]?.trim()
  if (!value) throw new Error(`Missing required env: ${key}`)
  return value
}

function optionalValue(source: NodeJS.ProcessEnv, key: string): string | null {
  const value = source[key]?.trim()
  return value ? value : null
}

function optionalUrl(source: NodeJS.ProcessEnv, key: string): string | null {
  const value = optionalValue(source, key)
  return value ? parseUrl(key, value) : null
}

function optionalBoolean(source: NodeJS.ProcessEnv, key: string): boolean {
  const value = optionalValue(source, key)
  if (!value) return false
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new Error(`${key} must be a boolean`)
}

function parseUrl(name: string, value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && name !== 'DATABASE_URL') {
      throw new Error(`${name} must use http or https`)
    }
    return value
  } catch {
    if (name === 'DATABASE_URL' && value.startsWith('postgres://')) return value
    throw new Error(`Invalid URL env: ${name}`)
  }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535')
  }
  return port
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function parseCorsAllowedOrigins(source: NodeJS.ProcessEnv, nodeEnv: string): string[] {
  const raw = optionalValue(source, 'CORS_ALLOWED_ORIGINS')
  const values = raw
    ? raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : nodeEnv === 'production'
      ? []
      : DEV_CORS_ALLOWED_ORIGINS

  return [...new Set(values.map(parseCorsOrigin))]
}

function parseCorsOrigin(value: string): string {
  if (value === 'null') return value

  try {
    const parsed = new URL(value)
    if (!parsed.host) throw new Error('missing host')
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('origin must not contain credentials, query, or hash')
    }
    if (parsed.pathname && parsed.pathname !== '/') {
      throw new Error('origin must not contain a path')
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    throw new Error(`Invalid CORS origin: ${value}`)
  }
}

function rejectProductionPlaceholder(name: string, value: string | null, nodeEnv: string): void {
  if (nodeEnv !== 'production' || !value) return
  if (PLACEHOLDER_RE.test(value)) {
    throw new Error(`Production env ${name} still contains a placeholder value`)
  }
}

export function parseEnv(source: NodeJS.ProcessEnv): ServerEnv {
  const nodeEnvRaw = source.NODE_ENV?.trim() || 'development'
  if (!['development', 'test', 'production'].includes(nodeEnvRaw)) {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  const nodeEnv = nodeEnvRaw as ServerEnv['nodeEnv']

  const publicApiBaseUrl = parseUrl(
    'PUBLIC_API_BASE_URL',
    requireValue(source, 'PUBLIC_API_BASE_URL'),
  )
  const betterAuthUrl = parseUrl('BETTER_AUTH_URL', requireValue(source, 'BETTER_AUTH_URL'))
  const databaseUrl = parseUrl('DATABASE_URL', requireValue(source, 'DATABASE_URL'))
  const tauriUpdaterPublicKey = optionalValue(source, 'TAURI_UPDATER_PUBLIC_KEY')
  if (nodeEnv === 'production' && !tauriUpdaterPublicKey) {
    throw new Error('Missing required env: TAURI_UPDATER_PUBLIC_KEY')
  }

  const env: ServerEnv = {
    nodeEnv,
    port: parsePort(source.PORT?.trim() || '8787'),
    publicApiBaseUrl,
    apiBasePath: apiBasePathFromPublicUrl(publicApiBaseUrl),
    databaseUrl,
    redisUrl: optionalValue(source, 'REDIS_URL'),
    corsAllowedOrigins: parseCorsAllowedOrigins(source, nodeEnv),
    betterAuthSecret: requireValue(source, 'BETTER_AUTH_SECRET'),
    betterAuthUrl,
    googleClientId: optionalValue(source, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: optionalValue(source, 'GOOGLE_CLIENT_SECRET'),
    githubClientId: optionalValue(source, 'GITHUB_CLIENT_ID'),
    githubClientSecret: optionalValue(source, 'GITHUB_CLIENT_SECRET'),
    stripeSecretKey: optionalValue(source, 'STRIPE_SECRET_KEY'),
    stripeWebhookSecret: optionalValue(source, 'STRIPE_WEBHOOK_SECRET'),
    stripeProPriceId: optionalValue(source, 'STRIPE_PRO_PRICE_ID'),
    sttProvider: optionalValue(source, 'STT_PROVIDER'),
    sttApiKey: optionalValue(source, 'STT_API_KEY'),
    sttBaseUrl: optionalUrl(source, 'STT_BASE_URL'),
    sttModel: optionalValue(source, 'STT_MODEL'),
    llmProvider: optionalValue(source, 'LLM_PROVIDER'),
    llmApiKey: optionalValue(source, 'LLM_API_KEY'),
    llmBaseUrl: optionalUrl(source, 'LLM_BASE_URL'),
    llmModel: optionalValue(source, 'LLM_MODEL'),
    ttsProvider: optionalValue(source, 'TTS_PROVIDER'),
    ttsApiKey: optionalValue(source, 'TTS_API_KEY'),
    ttsBaseUrl: optionalUrl(source, 'TTS_BASE_URL'),
    ttsModel: optionalValue(source, 'TTS_MODEL'),
    ttsVoice: optionalValue(source, 'TTS_VOICE'),
    providerControlDeadlineMs: parsePositiveInteger(
      'PROVIDER_CONTROL_DEADLINE_MS',
      requireValue(source, 'PROVIDER_CONTROL_DEADLINE_MS'),
    ),
    providerControlMaxInFlight: parsePositiveInteger(
      'PROVIDER_CONTROL_MAX_IN_FLIGHT',
      requireValue(source, 'PROVIDER_CONTROL_MAX_IN_FLIGHT'),
    ),
    glmocrPipelineBin: optionalValue(source, 'GLMOCR_PIPELINE_BIN'),
    glmocrPipelinePython: optionalValue(source, 'GLMOCR_PIPELINE_PYTHON'),
    desktopAutoUpdateEnabled: optionalBoolean(source, 'DESKTOP_AUTO_UPDATE_ENABLED'),
    desktopUpdateEnabled: optionalBoolean(source, 'DESKTOP_UPDATE_ENABLED'),
    desktopUpdateForce: optionalBoolean(source, 'DESKTOP_UPDATE_FORCE'),
    desktopUpdateLatestVersion: optionalValue(source, 'DESKTOP_UPDATE_LATEST_VERSION') ?? '0.1.0',
    desktopUpdateMinVersion: optionalValue(source, 'DESKTOP_UPDATE_MIN_VERSION'),
    desktopUpdateDownloadUrl: optionalUrl(source, 'DESKTOP_UPDATE_DOWNLOAD_URL'),
    desktopUpdateSha256: optionalValue(source, 'DESKTOP_UPDATE_SHA256'),
    desktopUpdateSignature: optionalValue(source, 'DESKTOP_UPDATE_SIGNATURE'),
    desktopUpdateReleaseNotes: optionalValue(source, 'DESKTOP_UPDATE_RELEASE_NOTES'),
    tauriUpdaterPublicKey,
    planLimits: {
      free: {
        sttSecondsLimit: 900,
        llmTokensLimit: 100_000,
        ocrImagesLimit: 50,
        ttsCharsLimit: 50_000,
      },
      pro: {
        sttSecondsLimit: 36_000,
        llmTokensLimit: 5_000_000,
        ocrImagesLimit: 5_000,
        ttsCharsLimit: 2_000_000,
      },
    },
  }

  for (const [key, value] of Object.entries({
    BETTER_AUTH_SECRET: env.betterAuthSecret,
    GOOGLE_CLIENT_ID: env.googleClientId,
    GOOGLE_CLIENT_SECRET: env.googleClientSecret,
    GITHUB_CLIENT_ID: env.githubClientId,
    GITHUB_CLIENT_SECRET: env.githubClientSecret,
    STRIPE_SECRET_KEY: env.stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: env.stripeWebhookSecret,
    STT_API_KEY: env.sttApiKey,
    STT_BASE_URL: env.sttBaseUrl,
    LLM_API_KEY: env.llmApiKey,
    LLM_BASE_URL: env.llmBaseUrl,
    TTS_API_KEY: env.ttsApiKey,
    TTS_BASE_URL: env.ttsBaseUrl,
  })) {
    rejectProductionPlaceholder(key, value, nodeEnv)
  }

  return env
}

export function loadEnv(): ServerEnv {
  return parseEnv(process.env)
}
