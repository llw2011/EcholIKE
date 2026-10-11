import { ApiError, forbidden, json } from '../../errors.js'
import type { Handler } from '../../http.js'
import { AdminAuthorizationChangedError } from '../../services/admin/admin-service.js'
import {
  OtaReleaseStateError,
  type OtaReleaseInput,
} from '../../services/desktop/desktop-config-service.js'
import { OtaArtifactValidationError } from '../../services/desktop/ota-artifact-validator.js'
import { requireControlRole } from './control.js'
import {
  booleanField,
  integerField,
  optionalIntegerField,
  optionalStringField,
  POSTGRES_INTEGER_MAX,
  readJsonObject,
  stringField,
} from './http-fields.js'

export const adminOtaReleases: Handler = async (ctx) =>
  json({
    generatedAt: new Date().toISOString(),
    releases: await ctx.services.desktopConfig.listOtaReleases({ includeDownloadUrl: true }),
  })

export const adminUpsertOtaRelease: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  let release
  try {
    release = await ctx.services.desktopConfig.upsertOtaRelease(otaReleaseInput(body), {
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
      signal: ctx.request.signal,
    })
  } catch (error) {
    throwOtaAdminError(error)
  }

  return json({ ok: true, release })
}

export const adminValidateOtaRelease: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  let result
  try {
    result = await ctx.services.desktopConfig.validateOtaRelease(otaActionInput(body), {
      signal: ctx.request.signal,
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
    })
  } catch (error) {
    throwOtaAdminError(error)
  }
  return json({ ok: true, ...result })
}

export const adminActivateOtaRelease: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const forceUpdate = body.forceUpdate === undefined ? false : booleanField(body, 'forceUpdate')
  if (forceUpdate && actor.role !== 'owner') {
    throw forbidden('只有 owner 可以启用强制更新')
  }

  let result
  try {
    result = await ctx.services.desktopConfig.activateOtaRelease(
      {
        ...otaActionInput(body),
        forceUpdate,
      },
      {
        signal: ctx.request.signal,
        control: { actorUserId: actor.userId, requestId: ctx.requestId },
      },
    )
  } catch (error) {
    throwOtaAdminError(error)
  }
  return json({ ok: true, ...result })
}

export const adminDeactivateOtaRelease: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  let release
  try {
    release = await ctx.services.desktopConfig.deactivateOtaRelease(otaActionInput(body), {
      signal: ctx.request.signal,
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
    })
  } catch (error) {
    throwOtaAdminError(error)
  }
  return json({ ok: true, release })
}

function otaReleaseInput(body: Record<string, unknown>): OtaReleaseInput {
  const id = optionalStringField(body, 'id', 80) ?? undefined
  const expectedRevision = optionalIntegerField(body, 'expectedRevision', 0, POSTGRES_INTEGER_MAX)
  if (id && expectedRevision === null) {
    throw new ApiError(422, 'validation_failed', '修改 OTA 草稿时必须携带当前 revision')
  }
  const hasArtifactBytes = Object.prototype.hasOwnProperty.call(body, 'artifactBytes')
  return {
    ...(id ? { id } : {}),
    ...(id ? { expectedRevision: expectedRevision as number } : {}),
    appName: optionalStringField(body, 'appName', 80) ?? 'EcholIKE',
    version: stringField(body, 'version', 40).replace(/^v/i, ''),
    channel: optionalStringField(body, 'channel', 40) ?? 'stable',
    platform: optionalStringField(body, 'platform', 40) ?? 'all',
    arch: optionalStringField(body, 'arch', 40) ?? 'all',
    enabled: body.enabled === undefined ? false : booleanField(body, 'enabled'),
    autoUpdate: body.autoUpdate === undefined ? false : booleanField(body, 'autoUpdate'),
    forceUpdate: body.forceUpdate === undefined ? false : booleanField(body, 'forceUpdate'),
    minVersion: optionalStringField(body, 'minVersion', 40),
    ...(hasArtifactBytes
      ? { artifactBytes: optionalIntegerField(body, 'artifactBytes', 1, POSTGRES_INTEGER_MAX) }
      : {}),
    downloadUrl: Object.prototype.hasOwnProperty.call(body, 'downloadUrl')
      ? optionalStringField(body, 'downloadUrl', 1000)
      : undefined,
    sha256: optionalStringField(body, 'sha256', 128),
    signature: optionalStringField(body, 'signature', 1000),
    releaseNotes: optionalStringField(body, 'releaseNotes', 4000),
    publishedAt: optionalStringField(body, 'publishedAt', 80),
  }
}

function otaActionInput(body: Record<string, unknown>): {
  id: string
  expectedRevision: number
} {
  return {
    id: stringField(body, 'id', 80),
    expectedRevision: integerField(body, 'expectedRevision', 0, POSTGRES_INTEGER_MAX),
  }
}

function throwOtaAdminError(error: unknown): never {
  if (error instanceof OtaReleaseStateError) {
    if (error.code === 'release_not_found') {
      throw new ApiError(404, 'not_found', '找不到这条 OTA 发布记录')
    }
    if (error.code === 'release_active') {
      throw new ApiError(409, 'validation_failed', '请先停用这条 OTA 发布记录再修改')
    }
    if (error.code === 'release_stale') {
      throw new ApiError(409, 'validation_failed', 'OTA 发布记录已变化，请刷新后重试')
    }
    if (error.code === 'release_validation_in_progress') {
      throw new ApiError(409, 'operation_in_progress', '已有 OTA 安装包正在校验，请稍后重试')
    }
    if (error.code === 'release_incomplete') {
      throw new ApiError(422, 'validation_failed', 'OTA 草稿缺少安装包地址、字节数、SHA 或签名')
    }
    throw new ApiError(422, 'validation_failed', '保存操作只能创建或修改停用中的 OTA 草稿')
  }

  if (error instanceof OtaArtifactValidationError) {
    const upstreamFailure =
      error.code === 'artifact_fetch_failed' ||
      error.code === 'artifact_read_failed' ||
      error.code === 'version_inspector_failed'
    throw new ApiError(
      upstreamFailure ? 502 : 422,
      upstreamFailure ? 'provider_failed' : 'validation_failed',
      `OTA 安装包校验失败（${error.code}）`,
    )
  }
  if (error instanceof AdminAuthorizationChangedError) {
    throw forbidden('管理员权限状态已变化，请刷新页面后重试')
  }
  throw error
}
