import { json } from '../errors.js'
import type { Handler } from '../http.js'

const APP_NAME = 'EcholIKE'

export const appUpdateStatus: Handler = async (ctx) => {
  const url = new URL(ctx.request.url)
  const currentVersion = cleanVersion(url.searchParams.get('version')) || '0.0.0'
  const channel = url.searchParams.get('channel') || 'stable'
  const platform = normalizePolicyPlatform(url.searchParams.get('platform') || 'unknown')
  const arch = normalizePolicyArch(url.searchParams.get('arch') || 'all')
  const ota = await ctx.services.desktopConfig.resolveOtaPolicy({
    currentVersion,
    channel,
    platform,
    arch,
  })
  const newerVersionExists = compareVersions(ota.latestVersion, currentVersion) > 0

  return json({
    appName: ota.appName || APP_NAME,
    generatedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    channel,
    platform,
    currentVersion,
    latestVersion: ota.latestVersion,
    autoUpdate: ota.autoUpdate,
    updateAvailable: ota.updateAvailable,
    forceUpdate: ota.forceUpdate,
    downloadUrl: ota.updateAvailable ? ota.downloadUrl : null,
    sha256: ota.updateAvailable ? ota.sha256 : null,
    releaseNotes: ota.updateAvailable ? ota.releaseNotes : null,
    message: ota.updateAvailable
      ? ota.forceUpdate
        ? 'A required update is available.'
        : 'An update is available.'
      : newerVersionExists
        ? 'No downloadable update is available.'
        : 'You are on the latest version.',
  })
}

export const appUpdateTauriManifest: Handler = async (ctx) => {
  const url = new URL(ctx.request.url)
  const currentVersion = cleanVersion(url.searchParams.get('version')) || '0.0.0'
  const channel = url.searchParams.get('channel') || 'stable'
  const rawPlatform = url.searchParams.get('platform') || 'unknown'
  const rawArch = url.searchParams.get('arch') || 'all'
  const platform = normalizePolicyPlatform(rawPlatform)
  const arch = normalizePolicyArchWithTargetFallback(rawArch, rawPlatform)
  const ota = await ctx.services.desktopConfig.resolveOtaPolicy({
    currentVersion,
    channel,
    platform,
    arch,
  })

  if (!ota.updateAvailable || !ota.downloadUrl || !ota.signature) {
    return new Response(null, { status: 204 })
  }

  const target = normalizeTauriTarget(rawPlatform, rawArch)
  return json({
    version: ota.latestVersion,
    notes: ota.releaseNotes ?? '',
    pub_date: new Date().toISOString(),
    platforms: {
      [target]: {
        signature: ota.signature,
        url: ota.downloadUrl,
      },
    },
  })
}

function cleanVersion(value: string | null): string {
  return value?.trim().replace(/^v/i, '') ?? ''
}

function normalizePolicyPlatform(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'unknown'
  if (normalized.includes('windows')) return 'windows'
  if (normalized === 'win32') return 'windows'
  if (normalized.includes('darwin') || normalized.includes('macos')) return 'macos'
  if (normalized.includes('linux')) return 'linux'
  if (normalized.includes('freebsd')) return 'freebsd'
  if (normalized.includes('android')) return 'android'
  if (normalized.includes('ios')) return 'ios'
  if (normalized === 'darwin') return 'macos'
  return normalized || 'unknown'
}

function normalizePolicyArch(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'all'
  if (normalized === 'x64' || normalized === 'amd64' || normalized.includes('x86_64')) {
    return 'x86_64'
  }
  if (normalized === 'arm64' || normalized.includes('aarch64')) return 'aarch64'
  if (normalized.includes('i686')) return 'i686'
  return normalized || 'all'
}

function normalizePolicyArchWithTargetFallback(rawArch: string, rawPlatform: string): string {
  const arch = normalizePolicyArch(rawArch)
  if (arch !== 'all') return arch
  const targetArch = normalizePolicyArch(rawPlatform)
  return targetArch === normalizePolicyPlatform(rawPlatform) ? 'all' : targetArch
}

function normalizeTauriTarget(rawPlatform: string, rawArch: string): string {
  const normalizedPlatform = rawPlatform.trim().toLowerCase()
  if (/^(windows|linux|darwin|macos|freebsd|android|ios)-(x86_64|aarch64|i686)$/.test(normalizedPlatform)) {
    return normalizedPlatform.replace(/^macos-/, 'darwin-')
  }

  const platform = normalizePolicyPlatform(rawPlatform)
  const arch = normalizePolicyArchWithTargetFallback(rawArch, rawPlatform)
  return `${normalizeTauriPlatform(platform)}-${arch === 'all' ? 'x86_64' : arch}`
}

function normalizeTauriPlatform(platform: string): string {
  if (platform === 'macos') return 'darwin'
  return platform || 'unknown'
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

function versionParts(version: string): number[] {
  return version
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}
