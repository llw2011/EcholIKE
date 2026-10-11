import { ApiError, type ErrorCode } from '../errors.js'
import type { Middleware } from '../http.js'

export interface RequiredContentType {
  mimeType: string
  status: number
  code: ErrorCode
  message: string
}

export function requireContentType(requirement: RequiredContentType): Middleware {
  const required = requirement.mimeType.trim().toLowerCase()
  return async (ctx, next) => {
    const contentType = ctx.request.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (contentType !== required) {
      throw new ApiError(requirement.status, requirement.code, requirement.message)
    }
    return next(ctx)
  }
}
