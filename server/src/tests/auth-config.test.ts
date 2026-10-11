import { describe, expect, it } from 'vitest'
import type { BetterAuthOptions } from 'better-auth/minimal'
import {
  AUTH_SESSION_EXPIRES_IN_SECONDS,
  AUTH_SESSION_UPDATE_AGE_SECONDS,
  betterAuthDrizzleSchema,
  createAuthOptions,
} from '../auth/auth.js'
import { testEnv } from './helpers.js'

const fakeDatabase = {} as NonNullable<BetterAuthOptions['database']>

describe('better auth persistence config', () => {
  it('maps Better Auth models to the existing Drizzle auth tables', () => {
    const options = createAuthOptions(testEnv(), fakeDatabase)

    expect(options.database).toBe(fakeDatabase)
    expect(Object.keys(betterAuthDrizzleSchema).sort()).toEqual([
      'account',
      'session',
      'user',
      'verification',
    ])
    expect(options.user?.fields).toMatchObject({
      emailVerified: 'emailVerified',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    })
    expect(options.session?.fields).toMatchObject({
      userId: 'userId',
      expiresAt: 'expiresAt',
      token: 'tokenHash',
      ipAddress: 'ipHash',
      userAgent: 'userAgentHash',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    })
    expect(options.session).toMatchObject({
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
    })
    expect(AUTH_SESSION_EXPIRES_IN_SECONDS).toBe(30 * 24 * 60 * 60)
    expect(AUTH_SESSION_UPDATE_AGE_SECONDS).toBe(24 * 60 * 60)
    expect(options.account?.fields).toMatchObject({
      userId: 'userId',
      accountId: 'providerAccountId',
      providerId: 'providerId',
      accessToken: 'accessToken',
      refreshToken: 'refreshToken',
      idToken: 'idToken',
      accessTokenExpiresAt: 'accessTokenExpiresAt',
      refreshTokenExpiresAt: 'refreshTokenExpiresAt',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    })
    expect(options.verification?.fields).toMatchObject({
      expiresAt: 'expiresAt',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    })
  })

  it('keeps email/password and bearer sessions enabled', () => {
    const options = createAuthOptions(testEnv(), fakeDatabase)

    expect(options.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    })
    expect(options.basePath).toBe('/echo-api/auth')
    expect(options.plugins).toHaveLength(1)
  })

  it('adds configured social providers and trusted origins', () => {
    const options = createAuthOptions(
      testEnv({
        PUBLIC_API_BASE_URL: 'http://localhost:8787/echo-api',
        BETTER_AUTH_URL: 'http://localhost:8787',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        GITHUB_CLIENT_ID: 'github-client',
        GITHUB_CLIENT_SECRET: 'github-secret',
      }),
      fakeDatabase,
    )

    expect(options.socialProviders?.google).toMatchObject({
      clientId: 'google-client',
      clientSecret: 'google-secret',
    })
    expect(options.socialProviders?.github).toMatchObject({
      clientId: 'github-client',
      clientSecret: 'github-secret',
    })
    expect(options.trustedOrigins).toEqual([
      'http://localhost:8787',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://tauri.localhost',
      'tauri://localhost',
    ])
  })
})
