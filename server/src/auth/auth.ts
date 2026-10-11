import { drizzle } from 'drizzle-orm/postgres-js'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal'
import { bearer } from 'better-auth/plugins'
import postgres from 'postgres'
import * as dbSchema from '../db/schema.js'
import type { ServerEnv } from '../env.js'
import { authBasePath } from '../paths.js'

type AuthDatabase = NonNullable<BetterAuthOptions['database']>

export const AUTH_SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60
export const AUTH_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60

export const betterAuthDrizzleSchema = {
  user: dbSchema.users,
  session: dbSchema.sessions,
  account: dbSchema.accounts,
  verification: dbSchema.verifications,
}

export function createAuthDatabase(databaseUrl: string): AuthDatabase {
  const client = postgres(databaseUrl, { max: 5, prepare: false })
  const db = drizzle(client, { schema: dbSchema })
  return drizzleAdapter(db, {
    provider: 'pg',
    schema: betterAuthDrizzleSchema,
    transaction: true,
  })
}

export function createAuthOptions(
  env: ServerEnv,
  database: AuthDatabase = createAuthDatabase(env.databaseUrl),
) {
  return {
    database,
    user: {
      fields: {
        emailVerified: 'emailVerified',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    session: {
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: AUTH_SESSION_UPDATE_AGE_SECONDS,
      fields: {
        userId: 'userId',
        expiresAt: 'expiresAt',
        token: 'tokenHash',
        ipAddress: 'ipHash',
        userAgent: 'userAgentHash',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    account: {
      fields: {
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
      },
    },
    verification: {
      fields: {
        expiresAt: 'expiresAt',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
      },
    },
    baseURL: env.betterAuthUrl,
    basePath: authBasePath(env.apiBasePath),
    trustedOrigins: createTrustedOrigins(env),
    secret: env.betterAuthSecret,
    socialProviders: createSocialProviders(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    plugins: [bearer()],
  } satisfies BetterAuthOptions
}

function createTrustedOrigins(env: ServerEnv): string[] {
  return [
    ...new Set([
      new URL(env.publicApiBaseUrl).origin,
      new URL(env.betterAuthUrl).origin,
      ...env.corsAllowedOrigins,
    ]),
  ]
}

function createSocialProviders(env: ServerEnv): BetterAuthOptions['socialProviders'] {
  const providers: NonNullable<BetterAuthOptions['socialProviders']> = {}

  if (env.googleClientId && env.googleClientSecret) {
    providers.google = {
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
    }
  }
  if (env.githubClientId && env.githubClientSecret) {
    providers.github = {
      clientId: env.githubClientId,
      clientSecret: env.githubClientSecret,
    }
  }

  return Object.keys(providers).length ? providers : undefined
}

export function createAuth(env: ServerEnv) {
  return betterAuth(createAuthOptions(env))
}
