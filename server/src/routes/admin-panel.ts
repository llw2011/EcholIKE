import { randomBytes } from 'node:crypto'
import type { Handler } from '../http.js'
import { ADMIN_ACTOR_HEADER } from '../middleware/admin-origin.js'
import { providerPresetGroupsForPanel } from '../services/proxy/provider-presets.js'
import { adminPanelDashboardPage } from './admin-panel/dashboard-page.js'
import { adminPanelLoginPage } from './admin-panel/login-page.js'
import { style } from './admin-panel/styles.js'

export const adminPanelLogin: Handler = (ctx) => {
  const nonce = responseNonce()
  return html(
    adminPanelLoginPage({
      nonce,
      favicon: faviconLink(),
      stylesheet: style(nonce),
      config: configScript(ctx.env.apiBasePath, nonce, ctx.user ?? null),
    }),
    nonce,
  )
}

export const adminPanelDashboard: Handler = (ctx) => {
  const nonce = responseNonce()
  return html(
    adminPanelDashboardPage({
      favicon: faviconLink(),
      stylesheet: style(nonce),
      config: configScript(ctx.env.apiBasePath, nonce, ctx.user ?? null),
      nonce,
      providerPresets: safeJson(providerPresetGroupsForPanel()),
    }),
    nonce,
  )
}
function configScript(
  apiBasePath: string,
  nonce: string,
  user: { id: string; email: string } | null,
): string {
  return `<script nonce="${nonce}">window.__ECHO_PANEL__ = ${safeJson({
    apiBasePath,
    userEmail: user?.email ?? null,
    actorUserId: user?.id ?? null,
    adminActorHeader: ADMIN_ACTOR_HEADER,
  })};</script>`
}

function faviconLink(): string {
  return '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%233ecf8e%22/%3E%3Cpath d=%22M18.8 4 9 17.1h6.2L13.2 28 23 14.9h-6.3L18.8 4Z%22 fill=%22%23171717%22/%3E%3C/svg%3E" />'
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\u003c')
}

function responseNonce(): string {
  return randomBytes(18).toString('base64')
}

function html(body: string, nonce: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  })
}
