import { ApiError, forbidden } from '../errors.js'
import type { Middleware } from '../http.js'

export const ADMIN_ACTOR_HEADER = 'x-echolike-admin-actor'

export const requireAdminActorPrecondition: Middleware = async (ctx, next) => {
  const expectedActorUserId = ctx.request.headers.get(ADMIN_ACTOR_HEADER)?.trim() ?? null

  // Bearer-authenticated automation is not vulnerable to ambient-cookie CSRF. If an
  // automation client opts into the actor precondition, it must still match exactly.
  if (ctx.request.headers.has('authorization')) {
    if (expectedActorUserId !== null && expectedActorUserId !== ctx.user?.id) {
      throw adminActorChanged()
    }
    return next(ctx)
  }

  if (!expectedActorUserId) {
    throw new ApiError(
      428,
      'admin_actor_precondition_required',
      '管理台页面缺少账号前置条件；当前请求未执行，请重新加载页面后再操作',
    )
  }

  if (expectedActorUserId !== ctx.user?.id) throw adminActorChanged()

  return next(ctx)
}

export const verifyAdminActorPreconditionIfPresent: Middleware = async (ctx, next) => {
  const expectedActorUserId = ctx.request.headers.get(ADMIN_ACTOR_HEADER)?.trim() ?? null
  if (expectedActorUserId !== null && expectedActorUserId !== ctx.user?.id) {
    throw adminActorChanged()
  }
  return next(ctx)
}

export const requireAdminWriteOrigin: Middleware = async (ctx, next) => {
  if (ctx.request.method === 'GET' || ctx.request.method === 'HEAD') return next(ctx)

  // Bearer-authenticated automation is not vulnerable to ambient-cookie CSRF.
  if (ctx.request.headers.has('authorization')) return next(ctx)

  const origin = ctx.request.headers.get('origin')
  const expectedOrigin = new URL(ctx.env.publicApiBaseUrl).origin
  const fetchSite = ctx.request.headers.get('sec-fetch-site')
  if (
    origin !== expectedOrigin ||
    (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'same-site')
  ) {
    throw forbidden('管理操作来源校验失败')
  }

  return next(ctx)
}

function adminActorChanged(): ApiError {
  return new ApiError(
    409,
    'admin_actor_changed',
    '管理台登录账号已在其他窗口切换；当前页面未执行写入，请重新加载后再操作',
  )
}
