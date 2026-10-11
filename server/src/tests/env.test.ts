import { describe, expect, it } from 'vitest'
import { parseEnv } from '../env.js'
import { testEnv } from './helpers.js'

describe('env validation', () => {
  it('parses test environment defaults', () => {
    const env = testEnv()
    expect(env.port).toBe(8787)
    expect(env.apiBasePath).toBe('/echo-api')
    expect(env.corsAllowedOrigins).toContain('http://localhost:5173')
    expect(env.corsAllowedOrigins).toContain('tauri://localhost')
  })

  it('fails fast when required env is missing', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'test',
        PORT: '8787',
      }),
    ).toThrow(/PUBLIC_API_BASE_URL/)
  })

  it('rejects placeholder production secrets', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: '8787',
        PUBLIC_API_BASE_URL: 'https://api.example.com/echo-api',
        DATABASE_URL: 'postgres://echo:echo@localhost:5432/echo',
        BETTER_AUTH_SECRET: 'replace-me',
        BETTER_AUTH_URL: 'https://api.example.com',
        PROVIDER_CONTROL_DEADLINE_MS: '10000',
        PROVIDER_CONTROL_MAX_IN_FLIGHT: '2',
        TAURI_UPDATER_PUBLIC_KEY: 'configured-public-key',
      }),
    ).toThrow(/placeholder/)
  })

  it('rejects placeholder production OAuth config', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: '8787',
        PUBLIC_API_BASE_URL: 'https://api.example.com/echo-api',
        DATABASE_URL: 'postgres://echo:echo@localhost:5432/echo',
        BETTER_AUTH_SECRET: 'test-secret-value',
        BETTER_AUTH_URL: 'https://api.example.com',
        PROVIDER_CONTROL_DEADLINE_MS: '10000',
        PROVIDER_CONTROL_MAX_IN_FLIGHT: '2',
        TAURI_UPDATER_PUBLIC_KEY: 'configured-public-key',
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'replace-me',
      }),
    ).toThrow(/GOOGLE_CLIENT_SECRET/)
  })

  it('requires the updater verification key in production but not in test', () => {
    expect(testEnv().tauriUpdaterPublicKey).toBeNull()
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PORT: '8787',
        PUBLIC_API_BASE_URL: 'https://api.example.com/echo-api',
        DATABASE_URL: 'postgres://echo:echo@localhost:5432/echo',
        BETTER_AUTH_SECRET: 'test-secret-value',
        BETTER_AUTH_URL: 'https://api.example.com',
        PROVIDER_CONTROL_DEADLINE_MS: '10000',
        PROVIDER_CONTROL_MAX_IN_FLIGHT: '2',
      }),
    ).toThrow(/TAURI_UPDATER_PUBLIC_KEY/)
  })

  it('normalizes explicit CORS origins and rejects non-origin values', () => {
    expect(
      testEnv({
        CORS_ALLOWED_ORIGINS: 'http://localhost:5173/,tauri://localhost',
      }).corsAllowedOrigins,
    ).toEqual(['http://localhost:5173', 'tauri://localhost'])

    expect(() =>
      testEnv({
        CORS_ALLOWED_ORIGINS: 'https://app.example.com/path',
      }),
    ).toThrow(/Invalid CORS origin/)
  })

  it('derives the public API base path from PUBLIC_API_BASE_URL', () => {
    expect(
      testEnv({
        PUBLIC_API_BASE_URL: 'https://api.example.com/echo-api/',
      }).apiBasePath,
    ).toBe('/echo-api')

    expect(
      testEnv({
        PUBLIC_API_BASE_URL: 'https://api.example.com',
      }).apiBasePath,
    ).toBe('')
  })
})
