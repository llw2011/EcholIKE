export interface RateLimitRule {
  name: string
  limit: number
  windowSeconds: number
}

export interface RateLimitInput {
  identity: string
  rule: RateLimitRule
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
  remaining: number
}

export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitDecision>
}

interface WindowCounter {
  count: number
  resetAtMs: number
}

export function createMemoryRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const windows = new Map<string, WindowCounter>()

  return {
    async check(input) {
      const current = now()
      const key = `${input.rule.name}:${input.identity}`
      const existing = windows.get(key)
      const resetAtMs =
        existing && existing.resetAtMs > current
          ? existing.resetAtMs
          : current + input.rule.windowSeconds * 1000
      const count = existing && existing.resetAtMs > current ? existing.count : 0
      const nextCount = count + 1
      windows.set(key, { count: nextCount, resetAtMs })

      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - current) / 1000))
      return {
        allowed: nextCount <= input.rule.limit,
        retryAfterSeconds,
        remaining: Math.max(0, input.rule.limit - nextCount),
      }
    },
  }
}
