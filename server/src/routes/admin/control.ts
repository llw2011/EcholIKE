import { ApiError, forbidden } from '../../errors.js'
import type { Handler } from '../../http.js'
import { currentAdminAccount } from '../../middleware/require-admin.js'
import type { AdminRole } from '../../services/admin/admin-service.js'
import {
  AdminAuthorizationChangedError,
  LastActiveOwnerError,
} from '../../services/admin/admin-service.js'

export function requireControlRole(
  ctx: Parameters<Handler>[0],
  roles: AdminRole[],
): { userId: string; role: AdminRole } {
  const admin = currentAdminAccount(ctx)
  if (!admin) throw forbidden()
  if (!roles.includes(admin.role)) throw forbidden('当前管理员角色无权执行此操作')
  return { userId: admin.userId, role: admin.role }
}

export function throwAdminMutationError(error: unknown): never {
  if (error instanceof LastActiveOwnerError) {
    throw new ApiError(409, 'validation_failed', '必须至少保留一个启用中的 owner 管理员')
  }
  if (error instanceof AdminAuthorizationChangedError) {
    throw forbidden('管理员权限状态已变化，请刷新页面后重试')
  }
  throw error
}
