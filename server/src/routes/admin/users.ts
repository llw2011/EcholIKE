import { hashPassword } from 'better-auth/crypto'
import { ApiError, forbidden, json } from '../../errors.js'
import type { Handler } from '../../http.js'
import type { AdminRole, AdminStatus } from '../../services/admin/admin-service.js'
import { isInvalidAdminUserCursorError } from '../../services/admin/admin-service.js'
import { userQuotaLevelOptions } from '../../services/billing/entitlements.js'
import { utcPeriodKey } from '../../services/quota/usage-ledger.js'
import { requireControlRole, throwAdminMutationError } from './control.js'
import {
  assertPeriodKey,
  booleanField,
  optionalStringField,
  readJsonObject,
  stringField,
} from './http-fields.js'

export const adminUsers: Handler = async (ctx) => {
  const searchParams = new URL(ctx.request.url).searchParams
  const periodKey = searchParams.get('periodKey') ?? utcPeriodKey()
  assertPeriodKey(periodKey)
  const query = adminUserSearchQuery(searchParams.get('q'))
  const cursor = adminUserCursor(searchParams.get('cursor'))
  const limit = adminUserPageLimit(searchParams.get('limit'))

  let page
  try {
    page = await ctx.services.admin.listUsers({ periodKey, query, cursor, limit })
  } catch (error) {
    if (isInvalidAdminUserCursorError(error)) {
      throw new ApiError(422, 'validation_failed', '用户列表位置已失效，请刷新后重试')
    }
    throw error
  }

  return json({
    generatedAt: new Date().toISOString(),
    periodKey,
    query,
    limit,
    planLimits: ctx.env.planLimits,
    quotaLevels: userQuotaLevelOptions(),
    users: page.users,
    total: page.total,
    nextCursor: page.nextCursor,
  })
}

export const adminCreateUser: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const input = createUserInput(body)
  const passwordHash = await hashPassword(input.password)
  let user
  try {
    user = await ctx.services.admin.createUser({
      email: input.email,
      name: input.name,
      passwordHash,
      emailVerified: input.emailVerified,
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
    })
  } catch (error) {
    throwAdminMutationError(error)
  }
  if (!user) {
    throw new ApiError(409, 'user_already_exists', 'A user with this email already exists')
  }

  return json({ ok: true, user })
}

export const adminResetUserPassword: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const userId = stringField(body, 'userId')

  if (userId === actor.userId) {
    throw new ApiError(422, 'validation_failed', '请使用“我的登录密码”修改自己的密码')
  }

  const targetAdmin = await ctx.services.admin.getAccount(userId)
  if (targetAdmin?.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('只有 owner 可以重置 owner 的密码')
  }
  const password = passwordField(body, 'password')

  let result
  try {
    result = await ctx.services.admin.resetUserPassword({
      userId,
      passwordHash: await hashPassword(password),
      control: { actorUserId: actor.userId, requestId: ctx.requestId },
    })
  } catch (error) {
    throwAdminMutationError(error)
  }
  if (!result) {
    throw new ApiError(404, 'not_found', '该用户没有可重置的密码登录方式')
  }

  return json({
    ok: true,
    userId: result.userId,
    sessionsRevoked: result.sessionsRevoked,
  })
}

export const adminSetAdminAccount: Handler = async (ctx) => {
  const actor = requireControlRole(ctx, ['owner', 'admin'])
  const body = await readJsonObject(ctx.request)
  const userId = stringField(body, 'userId')
  const role = adminRoleField(body, 'role')
  const status = adminStatusField(body, 'status')
  const targetAdmin = await ctx.services.admin.getAccount(userId)

  if (userId === actor.userId && status === 'disabled') {
    throw new ApiError(422, 'validation_failed', '不能停用自己的管理员账号')
  }
  if (targetAdmin?.role === 'owner' && actor.role !== 'owner') {
    throw forbidden('只有 owner 可以修改 owner 的管理员权限')
  }
  if (role === 'owner' && actor.role !== 'owner') {
    throw forbidden('只有 owner 可以授予 owner 角色')
  }

  let account
  try {
    account = await ctx.services.admin.setAdminAccount({
      userId,
      role,
      status,
      actorUserId: actor.userId,
      requestId: ctx.requestId,
    })
  } catch (error) {
    throwAdminMutationError(error)
  }

  return json({ ok: true, account })
}

function adminUserSearchQuery(value: string | null): string | null {
  const query = value?.trim() ?? ''
  if (!query) return null
  if (query.length > 120) {
    throw new ApiError(422, 'validation_failed', '用户搜索内容不能超过 120 个字符')
  }
  return query
}

function adminUserCursor(value: string | null): string | null {
  const cursor = value?.trim() ?? ''
  if (!cursor) return null
  if (cursor.length > 2048) {
    throw new ApiError(422, 'validation_failed', '用户列表位置已失效，请刷新后重试')
  }
  return cursor
}

function adminUserPageLimit(value: string | null): number {
  if (value === null || value === '') return 25
  if (!/^\d+$/.test(value)) {
    throw new ApiError(422, 'validation_failed', '每页数量必须是 1 到 100 的整数')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(422, 'validation_failed', '每页数量必须是 1 到 100 的整数')
  }
  return limit
}

function emailField(body: Record<string, unknown>, key: string): string {
  const email = stringField(body, key, 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, 'validation_failed', `${key} must be a valid email`)
  }
  return email
}

function passwordField(body: Record<string, unknown>, key: string): string {
  const password = body[key]
  if (typeof password !== 'string' || !password || password.length > 128) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  if (password.length < 8) {
    throw new ApiError(422, 'validation_failed', `${key} must be at least 8 characters`)
  }
  return password
}

function adminRoleField(body: Record<string, unknown>, key: string): AdminRole {
  const value = stringField(body, key)
  if (!isAdminRole(value)) {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function adminStatusField(body: Record<string, unknown>, key: string): AdminStatus {
  const value = stringField(body, key)
  if (value !== 'active' && value !== 'disabled') {
    throw new ApiError(422, 'validation_failed', `${key} is invalid`)
  }
  return value
}

function isAdminRole(value: string): value is AdminRole {
  return value === 'owner' || value === 'admin' || value === 'operator' || value === 'viewer'
}

function createUserInput(body: Record<string, unknown>): {
  email: string
  name: string | null
  password: string
  emailVerified: boolean
} {
  return {
    email: emailField(body, 'email'),
    name: optionalStringField(body, 'name', 120),
    password: passwordField(body, 'password'),
    emailVerified: body.emailVerified === undefined ? true : booleanField(body, 'emailVerified'),
  }
}
