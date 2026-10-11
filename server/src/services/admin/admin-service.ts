import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import type { QuotaKind } from '../quota/quota-service.js'
import { quotaMultiplierForLevel, normalizeQuotaLevel } from '../billing/entitlements.js'
import type { UserQuotaLevel } from '../../types.js'

export type AdminRole = 'owner' | 'admin' | 'operator' | 'viewer'
export type AdminStatus = 'active' | 'disabled'

export interface AdminAccount {
  userId: string
  role: AdminRole
  status: AdminStatus
  createdBy: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

export interface AdminOverview {
  userCount: number
  adminCount: number
  activeAdminCount: number
  subscriptionCount: number
  proSubscriptionCount: number
  usageLedgerCount: number
  scenePackCount: number
  auditLogCount: number
  latestAuditAt: string | null
}

export interface AdminUserRecord {
  id: string
  email: string
  name: string | null
  emailVerified: boolean
  createdAt: string | null
  updatedAt: string | null
  adminRole: AdminRole | null
  adminStatus: AdminStatus | null
  plan: 'free' | 'pro' | null
  subscriptionStatus: string | null
  subscriptionEnd: string | null
  quotaLevel: UserQuotaLevel
  quotaMultiplier: number
  sttSecondsUsed: number
  llmTokensUsed: number
  ocrImagesUsed: number
  ttsCharsUsed: number
}

export interface AdminCreateUserInput {
  email: string
  name: string | null
  passwordHash: string
  emailVerified: boolean
  control?: AdminControlContext
}

export interface AdminListUsersInput {
  periodKey: string
  query: string | null
  cursor: string | null
  limit: number
}

export interface AdminUserCursor {
  createdAt: string
  id: string
}

export interface AdminStoreListUsersInput {
  periodKey: string
  query: string | null
  cursor: AdminUserCursor | null
  limit: number
}

export interface AdminUserStorePage {
  users: AdminUserRecord[]
  total: number
  hasMore: boolean
}

export interface AdminUserPage {
  users: AdminUserRecord[]
  total: number
  nextCursor: string | null
}

export interface AdminResetUserPasswordInput {
  userId: string
  passwordHash: string
  control?: AdminControlContext
}

export interface AdminResetUserPasswordResult {
  userId: string
  sessionsRevoked: number
}

export class InvalidAdminUserCursorError extends Error {
  constructor() {
    super('Invalid admin user cursor')
    this.name = 'InvalidAdminUserCursorError'
  }
}

export class AdminIdempotencyConflictError extends Error {
  constructor() {
    super('Admin idempotency key was already used for a different operation')
    this.name = 'AdminIdempotencyConflictError'
  }
}

export class LastActiveOwnerError extends Error {
  constructor() {
    super('At least one active owner must remain')
    this.name = 'LastActiveOwnerError'
  }
}

export class AdminAuthorizationChangedError extends Error {
  constructor() {
    super('Admin authorization changed before the control mutation committed')
    this.name = 'AdminAuthorizationChangedError'
  }
}

export interface AdminControlContext {
  actorUserId: string
  requestId: string
}

export interface AdminControlAuditEntry {
  userId: string
  requestId: string
  action: string
  metadata: Record<string, unknown>
}

export function isInvalidAdminUserCursorError(
  error: unknown,
): error is InvalidAdminUserCursorError {
  return error instanceof InvalidAdminUserCursorError
}

export interface AdminSceneDictionaryTerm {
  word: string
  pronunciation?: string
}

export interface AdminScenePackRecord {
  id: string
  slug: string
  name: string
  description: string
  category: string
  promptTemplate: string
  dictionaryTerms: AdminSceneDictionaryTerm[]
  isPro: boolean
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface AdminAccountInput {
  userId: string
  role: AdminRole
  status: AdminStatus
  actorUserId: string
  requestId: string
}

export interface AdminQuotaAdjustmentInput {
  userId: string
  kind: QuotaKind
  amount: number
  periodKey: string
  requestId: string
  actorUserId: string
  idempotencyKey: string
  reason: string
}

export interface AdminQuotaAdjustmentStoreInput {
  userId: string
  kind: QuotaKind
  amount: number
  periodKey: string
  requestId: string
  actorUserId: string
  idempotencyKey: string
  payloadHash: string
  reason: string
}

export interface AdminQuotaAdjustmentResult {
  operationId: string
  userId: string
  kind: QuotaKind
  amount: number
  periodKey: string
  usageBefore: number
  usageAfter: number
  replayed: boolean
  reason: string
}

export interface AdminQuotaControlAuditRecord {
  action: 'admin.quota.adjust'
  operationId: string
  actorUserId: string
  targetUserId: string
  kind: QuotaKind
  amount: number
  periodKey: string
  usageBefore: number
  usageAfter: number
  reason: string
}

export interface AdminSetUserQuotaLevelInput {
  userId: string
  quotaLevel: UserQuotaLevel
  actorUserId: string
  requestId: string
}

export interface AdminUserQuotaProfile {
  userId: string
  quotaLevel: UserQuotaLevel
  quotaMultiplier: number
}

export interface AdminScenePackInput {
  id?: string
  slug: string
  name: string
  description: string
  category: string
  promptTemplate: string
  dictionaryTerms: AdminSceneDictionaryTerm[]
  isPro: boolean
  enabled: boolean
  control?: AdminControlContext
}

export interface AdminStore {
  getAccount(userId: string): Promise<AdminAccount | null>
  getOverview(): Promise<AdminOverview>
  listUsers(input: AdminStoreListUsersInput): Promise<AdminUserStorePage>
  createUser(input: AdminCreateUserInput): Promise<AdminUserRecord | null>
  resetUserPassword(
    input: AdminResetUserPasswordInput,
  ): Promise<AdminResetUserPasswordResult | null>
  setAdminAccount(input: AdminAccountInput): Promise<AdminAccount>
  adjustQuota(input: AdminQuotaAdjustmentStoreInput): Promise<AdminQuotaAdjustmentResult>
  setUserQuotaLevel(input: AdminSetUserQuotaLevelInput): Promise<AdminUserQuotaProfile>
  listScenePacks(): Promise<AdminScenePackRecord[]>
  upsertScenePack(input: AdminScenePackInput): Promise<AdminScenePackRecord>
}

export interface AdminService {
  getAccount(userId: string): Promise<AdminAccount | null>
  getOverview(): Promise<AdminOverview>
  listUsers(input: AdminListUsersInput): Promise<AdminUserPage>
  createUser(input: AdminCreateUserInput): Promise<AdminUserRecord | null>
  resetUserPassword(
    input: AdminResetUserPasswordInput,
  ): Promise<AdminResetUserPasswordResult | null>
  setAdminAccount(input: AdminAccountInput): Promise<AdminAccount>
  adjustQuota(input: AdminQuotaAdjustmentInput): Promise<AdminQuotaAdjustmentResult>
  setUserQuotaLevel(input: AdminSetUserQuotaLevelInput): Promise<AdminUserQuotaProfile>
  listScenePacks(): Promise<AdminScenePackRecord[]>
  upsertScenePack(input: AdminScenePackInput): Promise<AdminScenePackRecord>
}

export function createAdminService(store: AdminStore): AdminService {
  return {
    getAccount(userId) {
      return store.getAccount(userId)
    },
    getOverview() {
      return store.getOverview()
    },
    async listUsers(input) {
      assertAdminUserPageLimit(input.limit)
      const page = await store.listUsers({
        periodKey: input.periodKey,
        query: normalizeAdminUserQuery(input.query),
        cursor: decodeAdminUserCursor(input.cursor),
        limit: input.limit,
      })
      const lastUser = page.users.at(-1)
      return {
        users: page.users,
        total: page.total,
        nextCursor:
          page.hasMore && lastUser ? encodeAdminUserCursor(cursorForAdminUser(lastUser)) : null,
      }
    },
    createUser(input) {
      return store.createUser(input)
    },
    resetUserPassword(input) {
      return store.resetUserPassword(input)
    },
    setAdminAccount(input) {
      return store.setAdminAccount(input)
    },
    adjustQuota(input) {
      return store.adjustQuota({
        ...input,
        payloadHash: adminQuotaAdjustmentPayloadHash(input),
      })
    },
    setUserQuotaLevel(input) {
      return store.setUserQuotaLevel(input)
    },
    listScenePacks() {
      return store.listScenePacks()
    },
    upsertScenePack(input) {
      return store.upsertScenePack(input)
    },
  }
}

export function createMemoryAdminStore(
  accounts: AdminAccount[] = [],
  overview: Partial<AdminOverview> = {},
): AdminStore & {
  accounts: Map<string, AdminAccount>
  users: Map<string, AdminUserRecord>
  userCredentials: Map<
    string,
    { providerId: string; providerAccountId: string; passwordHash: string }
  >
  userSessionCounts: Map<string, number>
  sessionRevocations: AdminResetUserPasswordResult[]
  scenes: Map<string, AdminScenePackRecord>
  quotaAdjustments: AdminQuotaAdjustmentStoreInput[]
  quotaControlAudits: AdminQuotaControlAuditRecord[]
  controlAudits: AdminControlAuditEntry[]
} {
  const rows = new Map(accounts.map((account) => [account.userId, account]))
  const users = new Map<string, AdminUserRecord>()
  const userCredentials = new Map<
    string,
    { providerId: string; providerAccountId: string; passwordHash: string }
  >()
  const userSessionCounts = new Map<string, number>()
  const sessionRevocations: AdminResetUserPasswordResult[] = []
  const scenes = new Map<string, AdminScenePackRecord>()
  const quotaAdjustments: AdminQuotaAdjustmentStoreInput[] = []
  const quotaControlAudits: AdminQuotaControlAuditRecord[] = []
  const controlAudits: AdminControlAuditEntry[] = []
  const quotaOperations = new Map<
    string,
    { payloadHash: string; result: AdminQuotaAdjustmentResult }
  >()

  return {
    accounts: rows,
    users,
    userCredentials,
    userSessionCounts,
    sessionRevocations,
    scenes,
    quotaAdjustments,
    quotaControlAudits,
    controlAudits,
    async getAccount(userId) {
      return rows.get(userId) ?? null
    },
    async getOverview() {
      const adminCount = rows.size
      const activeAdminCount = [...rows.values()].filter(
        (account) => account.status === 'active',
      ).length

      return {
        userCount: overview.userCount ?? 0,
        adminCount: overview.adminCount ?? adminCount,
        activeAdminCount: overview.activeAdminCount ?? activeAdminCount,
        subscriptionCount: overview.subscriptionCount ?? 0,
        proSubscriptionCount: overview.proSubscriptionCount ?? 0,
        usageLedgerCount: overview.usageLedgerCount ?? 0,
        scenePackCount: overview.scenePackCount ?? 0,
        auditLogCount: overview.auditLogCount ?? 0,
        latestAuditAt: overview.latestAuditAt ?? null,
      }
    },
    async listUsers(input) {
      const matchingUsers = [...users.values()]
        .filter((user) => matchesAdminUserQuery(user, input.query))
        .sort(compareAdminUsersDescending)
      const cursor = input.cursor
      const usersAfterCursor = cursor
        ? matchingUsers.filter((user) => isAdminUserAfterCursor(user, cursor))
        : matchingUsers
      const candidates = usersAfterCursor.slice(0, input.limit + 1)
      return {
        users: candidates.slice(0, input.limit),
        total: matchingUsers.length,
        hasMore: candidates.length > input.limit,
      }
    },
    async createUser(input) {
      const actor = assertMemoryControlActor(input.control, ['owner', 'admin'], rows)
      if ([...users.values()].some((user) => user.email.toLowerCase() === input.email)) {
        return null
      }
      const id = `user_${users.size + 1}`
      const now = new Date().toISOString()
      const user: AdminUserRecord = {
        id,
        email: input.email,
        name: input.name,
        emailVerified: input.emailVerified,
        createdAt: now,
        updatedAt: now,
        adminRole: null,
        adminStatus: null,
        plan: null,
        subscriptionStatus: null,
        subscriptionEnd: null,
        quotaLevel: 1,
        quotaMultiplier: quotaMultiplierForLevel(1),
        sttSecondsUsed: 0,
        llmTokensUsed: 0,
        ocrImagesUsed: 0,
        ttsCharsUsed: 0,
      }
      users.set(id, user)
      userCredentials.set(id, {
        providerId: 'credential',
        providerAccountId: id,
        passwordHash: input.passwordHash,
      })
      recordMemoryControlAudit(controlAudits, input.control, 'admin.user.create', {
        actorUserId: actor?.userId ?? input.control?.actorUserId ?? null,
        targetUserId: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
      })
      return user
    },
    async resetUserPassword(input) {
      const actor = assertMemoryControlActor(input.control, ['owner', 'admin'], rows)
      const targetAdmin = rows.get(input.userId)
      if (input.control && targetAdmin?.role === 'owner' && actor?.role !== 'owner') {
        throw new AdminAuthorizationChangedError()
      }
      const credential = userCredentials.get(input.userId)
      if (!credential || credential.providerId !== 'credential') return null

      userCredentials.set(input.userId, {
        ...credential,
        passwordHash: input.passwordHash,
      })
      const sessionsRevoked = userSessionCounts.get(input.userId) ?? 0
      userSessionCounts.set(input.userId, 0)
      const result = { userId: input.userId, sessionsRevoked }
      sessionRevocations.push(result)
      recordMemoryControlAudit(controlAudits, input.control, 'admin.user.password_reset', {
        targetUserId: result.userId,
        sessionsRevoked: result.sessionsRevoked,
      })
      return result
    },
    async setAdminAccount(input) {
      const control = { actorUserId: input.actorUserId, requestId: input.requestId }
      const actor = assertMemoryControlActor(control, ['owner', 'admin'], rows)
      const current = rows.get(input.userId)
      if (
        control &&
        ((current?.role === 'owner' && actor?.role !== 'owner') ||
          (input.role === 'owner' && actor?.role !== 'owner') ||
          (input.userId === input.actorUserId && input.status === 'disabled'))
      ) {
        throw new AdminAuthorizationChangedError()
      }
      const removesActiveOwner =
        current?.role === 'owner' &&
        current.status === 'active' &&
        (input.role !== 'owner' || input.status !== 'active')
      if (removesActiveOwner) {
        const activeOwnerCount = [...rows.values()].filter(
          (account) => account.role === 'owner' && account.status === 'active',
        ).length
        if (activeOwnerCount <= 1) throw new LastActiveOwnerError()
      }
      const account: AdminAccount = {
        userId: input.userId,
        role: input.role,
        status: input.status,
        createdBy: input.actorUserId,
        createdAt: null,
        updatedAt: null,
      }
      rows.set(input.userId, account)
      recordMemoryControlAudit(controlAudits, control, 'admin.account.set', {
        targetUserId: input.userId,
        role: input.role,
        status: input.status,
      })
      return account
    },
    async adjustQuota(input) {
      const actorUserId = input.actorUserId
      assertMemoryControlActor(
        { actorUserId, requestId: input.requestId },
        ['owner', 'admin', 'operator'],
        rows,
      )
      const idempotencyKey = input.idempotencyKey
      const payloadHash = input.payloadHash
      const operationKey = `${actorUserId}\u0000${idempotencyKey}`
      const existing = quotaOperations.get(operationKey)
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new AdminIdempotencyConflictError()
        return { ...existing.result, replayed: true }
      }

      const usageBefore = quotaAdjustments
        .filter(
          (adjustment) =>
            adjustment.userId === input.userId &&
            adjustment.kind === input.kind &&
            adjustment.periodKey === input.periodKey,
        )
        .reduce((total, adjustment) => total + adjustment.amount, 0)
      const operationId = randomUUID()
      const result: AdminQuotaAdjustmentResult = {
        operationId,
        userId: input.userId,
        kind: input.kind,
        amount: input.amount,
        periodKey: input.periodKey,
        usageBefore,
        usageAfter: usageBefore + input.amount,
        replayed: false,
        reason: input.reason,
      }
      quotaAdjustments.push(input)
      quotaControlAudits.push({
        action: 'admin.quota.adjust',
        operationId,
        actorUserId,
        targetUserId: input.userId,
        kind: input.kind,
        amount: input.amount,
        periodKey: input.periodKey,
        usageBefore: result.usageBefore,
        usageAfter: result.usageAfter,
        reason: result.reason,
      })
      quotaOperations.set(operationKey, { payloadHash, result })
      return result
    },
    async setUserQuotaLevel(input) {
      const control = { actorUserId: input.actorUserId, requestId: input.requestId }
      assertMemoryControlActor(control, ['owner', 'admin', 'operator'], rows)
      const quotaLevel = normalizeQuotaLevel(input.quotaLevel)
      const record = users.get(input.userId)
      if (record) {
        record.quotaLevel = quotaLevel
        record.quotaMultiplier = quotaMultiplierForLevel(quotaLevel)
      }
      const profile = {
        userId: input.userId,
        quotaLevel,
        quotaMultiplier: quotaMultiplierForLevel(quotaLevel),
      }
      recordMemoryControlAudit(controlAudits, control, 'admin.user_quota_level.set', {
        actorUserId: input.actorUserId,
        targetUserId: input.userId,
        quotaLevel: profile.quotaLevel,
        quotaMultiplier: profile.quotaMultiplier,
      })
      return profile
    },
    async listScenePacks() {
      return [...scenes.values()]
    },
    async upsertScenePack(input) {
      assertMemoryControlActor(input.control, ['owner', 'admin', 'operator'], rows)
      const id = input.id ?? `scene_${scenes.size + 1}`
      const record: AdminScenePackRecord = {
        id,
        slug: input.slug,
        name: input.name,
        description: input.description,
        category: input.category,
        promptTemplate: input.promptTemplate,
        dictionaryTerms: input.dictionaryTerms,
        isPro: input.isPro,
        enabled: input.enabled,
        createdAt: scenes.get(id)?.createdAt ?? null,
        updatedAt: null,
      }
      scenes.set(id, record)
      recordMemoryControlAudit(controlAudits, input.control, 'admin.scene.upsert', {
        actorUserId: input.control?.actorUserId ?? null,
        sceneId: record.id,
        slug: record.slug,
        enabled: record.enabled,
        isPro: record.isPro,
      })
      return record
    },
  }
}

function assertMemoryControlActor(
  control: AdminControlContext | undefined,
  allowedRoles: readonly AdminRole[],
  accounts: ReadonlyMap<string, AdminAccount>,
): AdminAccount | null {
  if (!control) return null
  const actor = accounts.get(control.actorUserId)
  if (!actor || actor.status !== 'active' || !allowedRoles.includes(actor.role)) {
    throw new AdminAuthorizationChangedError()
  }
  return actor
}

function recordMemoryControlAudit(
  entries: AdminControlAuditEntry[],
  control: AdminControlContext | undefined,
  action: string,
  metadata: Record<string, unknown>,
): void {
  if (!control) return
  entries.push({
    userId: control.actorUserId,
    requestId: control.requestId,
    action,
    metadata,
  })
}

export function adminQuotaAdjustmentPayloadHash(
  input: Pick<AdminQuotaAdjustmentInput, 'userId' | 'kind' | 'amount' | 'periodKey' | 'reason'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'admin-quota-adjustment-v2',
        input.userId,
        input.kind,
        input.amount,
        input.periodKey,
        input.reason,
      ]),
    )
    .digest('hex')
}

const ADMIN_USER_CURSOR_VERSION = 1
const ADMIN_USER_CURSOR_MAX_LENGTH = 2048
const ADMIN_USER_ID_MAX_LENGTH = 512
const ADMIN_USER_PAGE_MAX_LIMIT = 100
const ADMIN_USER_FALLBACK_CREATED_AT = '1970-01-01T00:00:00.000Z'

function assertAdminUserPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_USER_PAGE_MAX_LIMIT) {
    throw new RangeError(`Admin user page limit must be between 1 and ${ADMIN_USER_PAGE_MAX_LIMIT}`)
  }
}

function normalizeAdminUserQuery(query: string | null): string | null {
  const normalized = query?.trim() ?? ''
  return normalized || null
}

function decodeAdminUserCursor(cursor: string | null): AdminUserCursor | null {
  if (cursor === null) return null
  try {
    if (
      !cursor ||
      cursor.length > ADMIN_USER_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(cursor)
    ) {
      throw new InvalidAdminUserCursorError()
    }
    const decoded = Buffer.from(cursor, 'base64url')
    if (decoded.toString('base64url') !== cursor) throw new InvalidAdminUserCursorError()
    const value: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isAdminUserCursorPayload(value)) throw new InvalidAdminUserCursorError()
    return { createdAt: value.createdAt, id: value.id }
  } catch (error) {
    if (error instanceof InvalidAdminUserCursorError) throw error
    throw new InvalidAdminUserCursorError()
  }
}

function isAdminUserCursorPayload(
  value: unknown,
): value is AdminUserCursor & { version: typeof ADMIN_USER_CURSOR_VERSION } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (
    Object.keys(payload).length !== 3 ||
    payload.version !== ADMIN_USER_CURSOR_VERSION ||
    typeof payload.createdAt !== 'string' ||
    typeof payload.id !== 'string' ||
    !payload.id ||
    payload.id.length > ADMIN_USER_ID_MAX_LENGTH
  ) {
    return false
  }
  return isCanonicalAdminCursorTimestamp(payload.createdAt)
}

function encodeAdminUserCursor(cursor: AdminUserCursor): string {
  return Buffer.from(
    JSON.stringify({
      version: ADMIN_USER_CURSOR_VERSION,
      createdAt: cursor.createdAt,
      id: cursor.id,
    }),
    'utf8',
  ).toString('base64url')
}

function cursorForAdminUser(user: AdminUserRecord): AdminUserCursor {
  return {
    createdAt: normalizedAdminUserCreatedAt(user.createdAt),
    id: user.id,
  }
}

function normalizedAdminUserCreatedAt(createdAt: string | null): string {
  if (!createdAt) return ADMIN_USER_FALLBACK_CREATED_AT
  if (isCanonicalAdminCursorTimestamp(createdAt)) return createdAt
  const parsed = new Date(createdAt)
  return Number.isNaN(parsed.valueOf()) ? ADMIN_USER_FALLBACK_CREATED_AT : parsed.toISOString()
}

function isCanonicalAdminCursorTimestamp(value: string): boolean {
  if (!Number.isFinite(Date.parse(value))) return false
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return true
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function matchesAdminUserQuery(user: AdminUserRecord, query: string | null): boolean {
  if (!query) return true
  const normalized = query.toLowerCase()
  return (
    user.id.toLowerCase().includes(normalized) ||
    user.email.toLowerCase().includes(normalized) ||
    (user.name?.toLowerCase().includes(normalized) ?? false)
  )
}

function compareAdminUsersDescending(left: AdminUserRecord, right: AdminUserRecord): number {
  const leftCreatedAt = normalizedAdminUserCreatedAt(left.createdAt)
  const rightCreatedAt = normalizedAdminUserCreatedAt(right.createdAt)
  if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt < rightCreatedAt ? 1 : -1
  if (left.id === right.id) return 0
  return left.id < right.id ? 1 : -1
}

function isAdminUserAfterCursor(user: AdminUserRecord, cursor: AdminUserCursor): boolean {
  const createdAt = normalizedAdminUserCreatedAt(user.createdAt)
  return createdAt < cursor.createdAt || (createdAt === cursor.createdAt && user.id < cursor.id)
}
