import { ApiError } from '../../errors.js'
import type {
  AcquiredQuotaReservation,
  QuotaCachedResponse,
  QuotaReservation,
  QuotaService,
} from './quota-service.js'

const FINALIZE_RETRY_DELAY_MS = 50

export class QuotaReplaySignal extends Error {
  constructor(public readonly response: Response) {
    super('quota operation resolved from a cached response')
    this.name = 'QuotaReplaySignal'
  }
}

export function acquiredReservation(
  reservation: QuotaReservation,
): AcquiredQuotaReservation | Response {
  switch (reservation.outcome) {
    case 'acquired':
      return reservation
    case 'replay':
      return responseFromCache(reservation.cachedResponse)
    case 'in_progress':
      throw new ApiError(
        409,
        'operation_in_progress',
        'This operation is still in progress',
        true,
        {
          'retry-after': '1',
        },
      )
    case 'result_expired':
      throw new ApiError(
        410,
        'operation_result_expired',
        'This operation already completed, but its recoverable result has expired',
      )
  }
}

export async function cacheResponse(response: Response): Promise<QuotaCachedResponse> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: new Uint8Array(await response.clone().arrayBuffer()),
  }
}

export async function commitQuotaResponse(
  quota: Pick<QuotaService, 'commit'>,
  reservation: AcquiredQuotaReservation,
  actualAmount: number,
  response: Response,
): Promise<void> {
  const cached = await cacheResponse(response)
  try {
    await quota.commit(reservation, actualAmount, cached)
    return
  } catch (firstError) {
    await delay(FINALIZE_RETRY_DELAY_MS)
    try {
      await quota.commit(reservation, actualAmount, cached)
      return
    } catch (secondError) {
      if (secondError instanceof ApiError && secondError.code === 'operation_stale') {
        throw secondError
      }
      void firstError
      throw new ApiError(
        503,
        'operation_in_progress',
        'The operation result is still being finalized',
        true,
        { 'retry-after': '1' },
      )
    }
  }
}

export async function releaseQuotaReservation(
  quota: Pick<QuotaService, 'release'>,
  reservation: AcquiredQuotaReservation,
): Promise<void> {
  try {
    await quota.release(reservation)
  } catch {
    await delay(FINALIZE_RETRY_DELAY_MS)
    try {
      await quota.release(reservation)
    } catch {
      throw new ApiError(
        503,
        'operation_in_progress',
        'The failed operation is still being reconciled',
        true,
        { 'retry-after': '1' },
      )
    }
  }
}

export function responseFromCache(cached: QuotaCachedResponse): Response {
  return new Response(Uint8Array.from(cached.body), {
    status: cached.status,
    headers: cached.headers,
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
