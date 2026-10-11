# EcholIKE Backend Rebuild Plan

Date: 2026-06-25

## Purpose

EcholIKE currently has a working desktop-local backend in `src-tauri/`. The optional HTTP backend lives in `server/` and must keep every business endpoint behind API authentication; the desktop client remains local-first/BYOK and does not depend on cloud STT/LLM routes.

Primary goals:

- Preserve the fast local-first desktop path.
- Add an optional authenticated backend for account, quota, backup, and remote data features.
- Require API authentication for every business endpoint.
- Make quota and billing checks server-side, never trusting client claims.
- Keep the backend deployable and testable without coupling it to the Tauri build.

Non-goals:

- Do not expose the Tauri command layer over HTTP.
- Do not make cloud STT/LLM mandatory for BYOK/local use.
- Do not store user provider API keys on the server for MVP.

## Existing Backend Inventory

Already present in this repo:

- `src-tauri/src/lib.rs`: Tauri command registration and application state.
- `src-tauri/src/pipeline.rs`: recording, STT, LLM, output, history flow.
- `src-tauri/src/commands/*`: local command boundary for config, STT/LLM test, history, dictionary, misc.
- `src-tauri/src/stt/*`: Deepgram, AssemblyAI, OpenAI-compatible, and custom Whisper provider clients.
- `src-tauri/src/llm/*`: OpenAI-compatible provider client.
- `src-tauri/src/storage/mod.rs`: local config store plus SQLite history and dictionary.
- Desktop frontend uses Tauri commands for local-first BYOK operation; no cloud API client or auth token store is currently wired.

Missing from this repo:

- Cloud API server routes.
- Auth server configuration.
- Cloud database schema and migrations.
- Billing provider integration.
- Quota enforcement implementation.
- Backup storage implementation.
- Scene pack API and admin import path.

## Chosen Stack

Use TypeScript for the cloud backend because the existing frontend, auth client, tests, and dependency graph are already TypeScript-oriented.

Recommended stack:

- Runtime: Node.js 22 LTS.
- API framework: Hono.
- Auth: Better Auth server.
- Database: PostgreSQL.
- ORM/migrations: Drizzle ORM.
- Validation: Zod.
- Payments: Stripe.
- Object storage: S3-compatible storage, preferably Cloudflare R2 or AWS S3.
- Cache/rate limit: Redis-compatible store, preferably Upstash Redis for managed deployment.
- Test runner: Vitest.
- Deployment: start with a single containerized Node service; keep the app portable to Fly.io, Render, Railway, or a VPS.

Why this stack:

- TypeScript matches the existing project and reduces context switching.
- Hono is small, explicit, and easy to secure with route groups and middleware.
- Better Auth matches the existing desktop client.
- PostgreSQL is a stable fit for auth, quota ledgers, subscriptions, and backup metadata.
- Drizzle gives typed schema without a heavy framework.

Avoid for MVP:

- A Next.js full-stack app. The desktop app needs an API service, not a website framework.
- Serverless-only architecture for STT uploads. Audio proxy requests can be large and timeout-sensitive.
- Storing user BYOK API keys server-side. Keep BYOK in local desktop config.

## Proposed Project Layout

Add this under the current repo when implementation begins:

```text
server/
  package.json
  tsconfig.json
  vitest.config.ts
  drizzle.config.ts
  .env.example
  README.md
  src/
    index.ts
    app.ts
    env.ts
    errors.ts
    auth/
      better-auth.ts
      middleware.ts
      desktop-oauth.ts
      session.ts
    db/
      client.ts
      schema.ts
      migrations/
    middleware/
      require-auth.ts
      require-pro.ts
      rate-limit.ts
      request-id.ts
      body-limit.ts
      audit-log.ts
    routes/
      health.ts
      auth.ts
      subscription.ts
      checkout.ts
      proxy-stt.ts
      proxy-llm.ts
      backup.ts
      scenes.ts
    services/
      billing/
        stripe.ts
        entitlements.ts
      quota/
        quota-service.ts
        usage-ledger.ts
      proxy/
        stt-proxy.ts
        llm-proxy.ts
        provider-config.ts
      backup/
        backup-service.ts
        object-storage.ts
      scenes/
        scene-service.ts
      security/
        token-redaction.ts
        input-sanitizer.ts
    jobs/
      reset-monthly-quota.ts
      prune-audit-logs.ts
    tests/
      auth.test.ts
      subscription.test.ts
      proxy-auth.test.ts
      quota.test.ts
      backup.test.ts
```

Keep desktop code in the current root. The server is intentionally isolated so Tauri packaging cannot accidentally bundle server secrets or test fixtures.

## Authentication Rule

Every business API must require an authenticated session token.

Public endpoints allowed:

- `GET /healthz`: liveness only.
- `GET /readyz`: dependency readiness only, no secrets.
- Better Auth public routes required for login/sign-up/OAuth.
- `GET /api/auth/desktop-oauth`: starts OAuth handoff and must validate provider plus callback origin.
- OAuth callback bridge routes needed by Better Auth.

Protected endpoints:

- `GET /api/subscription/status`
- `POST /api/checkout/create`
- `POST /api/subscription/portal`
- `POST /api/proxy/stt`
- `POST /api/proxy/llm`
- `POST /api/backup/upload`
- `GET /api/backup/download`
- `GET /api/scenes`

Pro-only endpoints:

- `POST /api/proxy/stt`
- `POST /api/proxy/llm`
- `POST /api/backup/upload`
- `GET /api/backup/download`
- Pro scene packs from `GET /api/scenes`

Free-account endpoints:

- `GET /api/subscription/status`
- `POST /api/checkout/create`
- Public/free scene packs from `GET /api/scenes`

Implementation requirement:

- Route groups must be explicit: public, auth-required, pro-required.
- No route may read `userId` from request body.
- All user identity must come from verified Better Auth session.
- Server rejects missing, malformed, expired, or revoked tokens before route logic.
- Proxy routes must never accept provider API keys from client request body.

## API Contract

### `GET /api/subscription/status`

Auth: required.

Response:

```json
{
  "plan": "free",
  "subscriptionEnd": null,
  "sttSecondsUsed": 0,
  "sttSecondsLimit": 900,
  "llmTokensUsed": 0,
  "llmTokensLimit": 100000
}
```

Rules:

- Values come from database entitlement and usage ledger.
- Limits are server-side constants or plan records.
- Do not trust any client-side plan state.

### `POST /api/checkout/create`

Auth: required.

Request:

```json
{ "origin": "desktop" }
```

Response:

```json
{ "url": "https://checkout.stripe.com/..." }
```

Rules:

- Validate `origin` as `desktop | web`.
- Stripe customer must be mapped to authenticated user.
- Success/cancel URLs must be allowlisted.

### `POST /api/subscription/portal`

Auth: required, existing Stripe customer required.

Response:

```json
{ "url": "https://billing.stripe.com/..." }
```

### `POST /api/proxy/stt`

Auth: required. Pro or quota entitlement required.

Request:

- `multipart/form-data`
- `audio`: required WAV/audio file.
- `language`: optional BCP-47-like code or `multi`.

Response:

```json
{ "text": "transcribed text" }
```

Rules:

- Enforce max upload size before buffering.
- Enforce max duration after probing if possible.
- Deduct quota by actual audio seconds.
- Reject when quota is exhausted before proxying.
- Use server-owned STT credentials only.
- Return localized error codes where possible:
  - `stt_quota_exceeded`
  - `stt_invalid_key`
  - `stt_timeout`
  - `stt_no_speech_detected`

### `POST /api/proxy/llm`

Auth: required. Pro or quota entitlement required.

Request:

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "stream": false
}
```

Response:

```json
{ "text": "model output" }
```

Rules:

- Validate message count and content length.
- Drop or reject unexpected roles.
- Add server-side system safety wrapper if needed.
- Deduct quota by provider usage when available; otherwise estimate conservatively.
- Server chooses allowed model for the plan.
- Do not allow arbitrary `baseUrl`, `model`, or API key in cloud proxy mode.

### `POST /api/backup/upload`

Auth: required. Pro required.

Request:

```json
{
  "history": [],
  "dictionary": [],
  "settings": {}
}
```

Rules:

- Reject API key fields if present.
- Validate payload size and shape.
- Store encrypted object blob.
- Keep latest version plus a bounded version history.

### `GET /api/backup/download`

Auth: required. Pro required.

Response:

```json
{
  "history": [],
  "dictionary": [],
  "settings": {}
}
```

### `GET /api/scenes`

Auth: required.

Rules:

- Free users receive free scene packs.
- Pro users receive free plus Pro packs.
- Each scene pack must include safe prompt templates and dictionary terms only.

## Database Model

Minimum tables:

```text
user
  id
  email
  name
  emailVerified
  createdAt
  updatedAt

session
  id
  userId
  tokenHash
  expiresAt
  ipHash
  userAgentHash
  createdAt

account
  id
  userId
  providerId
  providerAccountId

subscription
  id
  userId
  stripeCustomerId
  stripeSubscriptionId
  plan
  status
  currentPeriodStart
  currentPeriodEnd
  cancelAtPeriodEnd
  updatedAt

usage_ledger
  id
  userId
  kind              # stt_seconds | llm_tokens
  amount
  source            # proxy_stt | proxy_llm | adjustment
  requestId
  periodKey         # YYYY-MM
  createdAt

backup_object
  id
  userId
  objectKey
  version
  sha256
  sizeBytes
  createdAt

scene_pack
  id
  slug
  name
  description
  category
  promptTemplate
  isPro
  enabled
  createdAt
  updatedAt

scene_dictionary_term
  id
  scenePackId
  word
  pronunciation

audit_log
  id
  userId
  requestId
  action
  metadataJson
  createdAt
```

Do not store plaintext session tokens. Do not store client BYOK provider keys.

## Security Requirements

Authentication:

- Use Better Auth server sessions.
- Accept Bearer tokens from desktop.
- Store only token hashes server-side.
- Tokens must expire and be revocable.

Authorization:

- Use `requireAuth` for every business route.
- Use `requirePro` for cloud proxy, backup, and Pro-only data.
- Do not accept `userId` in request bodies.

Input limits:

- JSON body max: 1 MB by default.
- STT upload max: start at 25 MB.
- LLM prompt max: bounded by character and estimated token count.
- Backup upload max: start at 10 MB compressed JSON.

Rate limits:

- Auth endpoints: strict IP plus account based limit.
- Proxy STT: per user and per IP.
- Proxy LLM: per user and per IP.
- Backup: low-frequency per user.
- Checkout: low-frequency per user.

Secrets:

- All provider API keys live in server env vars.
- Redact `Authorization`, `Cookie`, provider keys, and token-like strings from logs.
- Never return upstream provider raw errors if they may include secrets.

Transport:

- Production requires HTTPS.
- CORS allowlist must include only the desktop auth bridge/web origins that are needed.
- Desktop API clients should prefer Bearer token over cookies.

Audit:

- Log authenticated user id, request id, route, result code, quota amount.
- Do not log raw audio, transcript, prompts, backup contents, or tokens.

## Quota Rules

Suggested plan constants:

```text
free:
  sttSecondsLimit: 900
  llmTokensLimit: 100000
  backupEnabled: false
  proScenesEnabled: false

pro:
  sttSecondsLimit: 36000
  llmTokensLimit: 5000000
  backupEnabled: true
  proScenesEnabled: true
```

Usage ledger rules:

- Quota checks must be atomic.
- For STT, reserve by uploaded duration estimate before upstream call, then adjust after completion if better duration is known.
- For LLM, reserve by estimated tokens before upstream call, then adjust with provider usage if returned.
- Failed provider requests should not consume quota unless upstream cost is confirmed.
- Quota period key is based on UTC month unless product requires local billing period.

## Desktop Integration Changes

Already aligned:

- Desktop STT/LLM uses user-configured providers and API keys.
- Rust no longer exposes desktop session-token plumbing or cloud STT/LLM providers.
- Any future server-backed desktop feature must add an explicit authenticated client path instead of reusing removed cloud provider branches.

Needed when server is implemented:

- Set `VITE_API_BASE_URL` for frontend.
- Set `VITE_API_BASE_URL` only for frontend code that intentionally calls the backend.
- Expand Tauri CSP `connect-src` if any authenticated frontend backend call is added in production.
- Keep BYOK/local provider mode working when cloud API is unavailable.

## Error Contract

Use JSON errors:

```json
{
  "error": "Human readable message",
  "code": "stt_quota_exceeded",
  "requestId": "req_..."
}
```

Standard status mapping:

- `401`: missing/invalid/expired token.
- `403`: authenticated but plan/quota/permission denied.
- `413`: body/upload too large.
- `422`: validation error.
- `429`: rate limited.
- `502`: upstream provider error.
- `504`: upstream timeout.

Codes the desktop already understands or should understand:

- `stt_timeout`
- `stt_invalid_key`
- `stt_failed`
- `stt_quota_exceeded`
- `stt_no_speech_detected`
- `llm_failed`
- `llm_quota_exceeded`

## Implementation Phases

### Phase 0: Server Skeleton

Deliverables:

- `server/` directory with Hono app.
- `GET /healthz`, `GET /readyz`.
- Env validation.
- Request id middleware.
- Central error handler.
- Test setup.
- Dockerfile or documented Node start command.

Acceptance:

- `npm test` passes inside `server/`.
- Missing env fails fast with clear errors.
- No business routes exist without auth middleware.

### Phase 1: Auth

Deliverables:

- Better Auth server setup.
- Email/password auth.
- OAuth desktop bridge route.
- Bearer session extraction.
- `requireAuth` middleware.
- Session revocation on sign-out if server supports it.

Acceptance:

- Missing token returns `401`.
- Invalid token returns `401`.
- Valid token exposes `ctx.user`.
- OAuth state and callback origin are validated.

### Phase 2: Subscription and Billing

Deliverables:

- Stripe customer mapping.
- Checkout session creation.
- Billing portal route.
- Stripe webhook handler.
- Subscription status endpoint.
- Plan entitlement service.

Acceptance:

- Free/pro status comes from database.
- Webhook idempotency is tested.
- Client cannot forge plan.

### Phase 3: Quota

Deliverables:

- Usage ledger.
- Atomic quota check/reserve/commit service.
- Monthly period handling.
- Subscription status includes usage.

Acceptance:

- Concurrent proxy requests cannot exceed quota due to race.
- Quota reset or period rollover is tested.

### Phase 4: Cloud Proxy

Deliverables:

- STT proxy route.
- LLM proxy route.
- Server-owned provider credentials.
- Body limits and timeout controls.
- Provider error normalization.

Acceptance:

- Missing auth never reaches provider.
- Exhausted quota never reaches provider.
- Provider keys never appear in logs or responses.
- Upload and prompt limits are tested.

### Phase 5: Backup and Scenes

Deliverables:

- Encrypted backup object storage.
- Backup upload/download routes.
- Scene pack tables and API.
- Admin seed/import script for scene packs.

Acceptance:

- Backup rejects secret settings fields.
- Free users cannot download Pro-only backup/scene features.
- Scene API never returns disabled packs.

### Phase 6: Hardening

Deliverables:

- Rate limits.
- Audit logs.
- CORS allowlist.
- Security headers.
- Load test scripts for STT/LLM proxy.
- Operational dashboard or log queries.

Acceptance:

- Auth, proxy, backup routes are rate limited.
- Logs are token-redacted.
- Production env fails if secrets are placeholder values.

## Test Matrix

Required tests:

- Route auth tests for every protected endpoint.
- Pro authorization tests.
- Free quota allowed and quota exhausted tests.
- Missing/malformed token tests.
- Stripe webhook idempotency tests.
- STT upload size validation tests.
- LLM prompt validation tests.
- Backup secret stripping tests.
- Scene visibility tests by plan.
- Error shape snapshot tests.

## Environment Variables

Server:

```text
NODE_ENV=production
PORT=8787
PUBLIC_API_BASE_URL=https://api.example.com
DATABASE_URL=postgres://...
REDIS_URL=redis://...
CORS_ALLOWED_ORIGINS=https://app.example.com,http://tauri.localhost,tauri://localhost
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://api.example.com
DESKTOP_DEEP_LINK_SCHEME=echo
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STT_PROVIDER=...
STT_API_KEY=...
LLM_PROVIDER=...
LLM_API_KEY=...
LLM_MODEL=...
BACKUP_BUCKET=...
BACKUP_STORAGE_ENDPOINT=...
BACKUP_STORAGE_REGION=...
BACKUP_STORAGE_ACCESS_KEY_ID=...
BACKUP_STORAGE_SECRET_ACCESS_KEY=...
BACKUP_ENCRYPTION_KEY=...
```

Desktop build/runtime:

```text
VITE_API_BASE_URL=https://api.example.com
API_BASE_URL=https://api.example.com
```

## Backend Definition of Done

Backend is considered ready when:

- Every business route is behind auth middleware.
- Pro-only routes are behind entitlement middleware.
- Quota is enforced atomically server-side.
- Provider API keys never leave the server.
- Desktop local-first/BYOK flow works without a server; authenticated backend features are explicit opt-in additions.
- BYOK/local mode still works without server availability.
- Tests cover auth failure paths, not only happy paths.
- Production env rejects placeholder secrets.
- Release notes include required desktop env changes.
