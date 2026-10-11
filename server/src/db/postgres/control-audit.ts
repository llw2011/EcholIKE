import postgres from 'postgres'
import type { AdminAccount, AdminControlContext } from '../../services/admin/admin-service.js'
import { AdminAuthorizationChangedError } from '../../services/admin/admin-service.js'

export type LockedAdminAccount = Pick<AdminAccount, 'userId' | 'role' | 'status'>

export async function assertPostgresControlActor(
  transaction: postgres.TransactionSql,
  control: AdminControlContext | undefined,
  allowedRoles: readonly AdminAccount['role'][],
): Promise<LockedAdminAccount | null> {
  if (!control) throw new AdminAuthorizationChangedError()
  const rows = await transaction<
    { user_id: string; role: AdminAccount['role']; status: AdminAccount['status'] }[]
  >`
    select user_id, role, status
    from public.admin_account
    where user_id = ${control.actorUserId}
    for update
  `
  const row = rows[0]
  const actor = row ? { userId: row.user_id, role: row.role, status: row.status } : null
  if (!actor || actor.status !== 'active' || !allowedRoles.includes(actor.role)) {
    throw new AdminAuthorizationChangedError()
  }
  return actor
}

export async function insertPostgresControlAudit(
  transaction: postgres.TransactionSql,
  control: AdminControlContext | undefined,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!control) throw new AdminAuthorizationChangedError()
  await transaction`
    insert into public.audit_log (user_id, request_id, action, metadata_json)
    values (
      ${control.actorUserId},
      ${control.requestId},
      ${action},
      ${JSON.stringify(metadata)}::text::jsonb
    )
  `
}
