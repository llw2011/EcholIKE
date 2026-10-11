import type { AdminAccount, AdminRole } from '../services/admin/admin-service.js'
import { forbidden } from '../errors.js'
import type { Middleware } from '../http.js'

export const ADMIN_ACCOUNT_STATE_KEY = 'adminAccount'

export type AdminCapability =
  | 'overview:read'
  | 'system:read'
  | 'users:read'
  | 'users:write'
  | 'quota:write'
  | 'services:read'
  | 'providers:write'
  | 'diagnostics:run'
  | 'scenes:read'
  | 'scenes:write'
  | 'releases:read'
  | 'releases:write'
  | 'audit:read'
  | 'usage:read'

const ADMIN_CAPABILITIES: Record<AdminRole, readonly AdminCapability[]> = {
  viewer: ['overview:read'],
  operator: [
    'overview:read',
    'users:read',
    'quota:write',
    'services:read',
    'diagnostics:run',
    'scenes:read',
    'scenes:write',
    'releases:read',
    'audit:read',
    'usage:read',
  ],
  admin: [
    'overview:read',
    'system:read',
    'users:read',
    'users:write',
    'quota:write',
    'services:read',
    'providers:write',
    'diagnostics:run',
    'scenes:read',
    'scenes:write',
    'releases:read',
    'releases:write',
    'audit:read',
    'usage:read',
  ],
  owner: [
    'overview:read',
    'system:read',
    'users:read',
    'users:write',
    'quota:write',
    'services:read',
    'providers:write',
    'diagnostics:run',
    'scenes:read',
    'scenes:write',
    'releases:read',
    'releases:write',
    'audit:read',
    'usage:read',
  ],
}

export function currentAdminAccount(ctx: Parameters<Middleware>[0]): AdminAccount | null {
  const value = ctx.state.get(ADMIN_ACCOUNT_STATE_KEY)
  return isAdminAccount(value) ? value : null
}

export const requireAdmin: Middleware = async (ctx, next) => {
  const user = ctx.user
  if (!user) throw forbidden()

  const account = await ctx.services.admin.getAccount(user.id)
  if (!account || account.status !== 'active') {
    throw forbidden()
  }

  ctx.state.set(ADMIN_ACCOUNT_STATE_KEY, account)
  return next(ctx)
}

export function capabilitiesForAdminRole(role: AdminRole): AdminCapability[] {
  return [...ADMIN_CAPABILITIES[role]]
}

export function requireAdminCapability(capability: AdminCapability): Middleware {
  return async (ctx, next) => {
    const account = currentAdminAccount(ctx)
    if (!account || !ADMIN_CAPABILITIES[account.role].includes(capability)) {
      throw forbidden()
    }
    return next(ctx)
  }
}

function isAdminAccount(value: unknown): value is AdminAccount {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AdminAccount>
  return Boolean(candidate.userId && candidate.role && candidate.status)
}
