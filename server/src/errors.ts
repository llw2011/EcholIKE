export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'not_implemented'
  | 'validation_failed'
  | 'user_already_exists'
  | 'payload_too_large'
  | 'rate_limited'
  | 'idempotency_key_invalid'
  | 'idempotency_conflict'
  | 'admin_actor_precondition_required'
  | 'admin_actor_changed'
  | 'operation_in_progress'
  | 'operation_stale'
  | 'operation_result_expired'
  | 'internal_error'
  | 'provider_busy'
  | 'provider_failed'
  | 'provider_timeout'
  | 'stt_quota_exceeded'
  | 'llm_quota_exceeded'
  | 'ocr_quota_exceeded'
  | 'tts_quota_exceeded'
  | 'stt_invalid_key'
  | 'stt_timeout'
  | 'stt_failed'
  | 'stt_no_speech_detected'
  | 'llm_invalid_key'
  | 'llm_timeout'
  | 'llm_failed'
  | 'ocr_invalid_key'
  | 'ocr_timeout'
  | 'ocr_failed'
  | 'ocr_document_invalid'
  | 'ocr_document_page_limit'
  | 'ocr_document_no_text'
  | 'ocr_pipeline_unavailable'
  | 'ocr_cancelled'
  | 'tts_invalid_key'
  | 'tts_timeout'
  | 'tts_failed'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public expose = true,
    public headers: HeadersInit = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  })
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return json(
      {
        error: error.expose ? error.message : 'Internal server error',
        code: error.code,
        requestId,
      },
      { status: error.status, headers: error.headers },
    )
  }

  return json(
    {
      error: 'Internal server error',
      code: 'internal_error',
      requestId,
    },
    { status: 500 },
  )
}

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message)

export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message)

export const notImplemented = (message = 'Not implemented') =>
  new ApiError(501, 'not_implemented', message)
