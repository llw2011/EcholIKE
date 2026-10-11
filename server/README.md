# EcholIKE Server

Cloud API backend for EcholIKE desktop clients.

This directory now uses Hono + Better Auth + PostgreSQL/Drizzle foundations, as documented in `../docs/2026-06-25-backend-rebuild-plan.md`.

## Current Phase

Auth persistence, scenes, billing webhooks, and API hardening are in place:

- `GET /echo-api/healthz`
- `GET /echo-api/readyz` with a real PostgreSQL readiness check
- Hono route registration through explicit public/auth/pro groups
- request id middleware
- business route audit logging with redacted metadata
- per-user and per-IP rate limiting for business routes
- CORS allowlist for desktop/web browser clients that send bearer auth headers
- central JSON error shape
- explicit public/auth/pro route grouping
- Better Auth minimal handler mounted under `/echo-api/auth/*`
- Better Auth persistence wired through the Drizzle PostgreSQL adapter
- bearer session verification for protected routes
- protected route stubs that fail closed
- auth middleware that rejects missing, malformed, or unknown Bearer tokens
- Drizzle PostgreSQL schema plus migrations under `src/db/migrations`
- database-backed entitlement service for subscription status and Pro checks
- Stripe webhook route verifies signatures, records event ids, and updates subscription entitlements idempotently
- quota reserve/commit/release service backed by append-only usage ledger entries
- Postgres quota reserve path uses a transaction-scoped advisory lock per user/period/kind
- proxy routes validate cloud-only inputs, reserve quota, call server-owned provider credentials, then commit or release quota
- original PDF OCR uses `/echo-api/proxy/ocr/document`, a negotiated multipart contract, and the server-owned official GLM OCR Pipeline
- LLM proxy supports OpenAI-compatible chat providers: `openai`, `deepseek`, `openrouter`, `groq`, `siliconflow`
- STT proxy supports Whisper-compatible providers: `glm-asr`, `openai-whisper`, `openai`, `groq-whisper`, `groq`, `siliconflow`
- scenes are served from the Drizzle/Postgres scene tables through desktop Bootstrap and the admin API
- protected admin API under `/echo-api/admin/*`
- protected control panel shell under `/echo-panel/`
- PostgreSQL-backed `admin_account` authorization for control panel access

Billing entitlement reads and Stripe customer/subscription mapping are wired through a Drizzle store.
Streaming LLM proxy returns SSE and commits quota asynchronously after the upstream stream completes.

No business API is exposed without authentication. The route manifest in `src/app.ts` is also used by tests so newly added business routes must declare their auth boundary.

## Commands

```powershell
npm install --prefix server
npm test --prefix server
npm run typecheck --prefix server
npm run build --prefix server
npm run admin:promote --prefix server -- --email admin@example.com
```

## Runtime

```powershell
Copy-Item server/.env.example server/.env
npm run dev --prefix server
```

`PUBLIC_API_BASE_URL` should include the public mount path, for example
`https://api.example.com/echo-api`. `BETTER_AUTH_URL` can stay at the
public origin; the server mounts Better Auth at `/echo-api/auth`.

For the current WSL nginx layout, proxy the public mount path without rewriting:

```nginx
location ^~ /echo-api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    # OCR keeps backward compatibility with the Base64 JSON desktop contract.
    # A 25 MiB decoded image needs about 33.34 MiB before the JSON envelope.
    client_max_body_size 40m;
    # Server PDF OCR has a 900-second end-to-end deadline. Both proxy
    # directions must remain open longer so a client disconnect reaches the
    # backend and cancels the owned Pipeline process group.
    proxy_read_timeout 960s;
    proxy_send_timeout 960s;
    proxy_buffering off;
    proxy_request_buffering off;
    add_header X-Accel-Buffering no always;
}
```

Server PDF OCR is enabled only when the managed OCR provider is the local
`ollama-ocr-local` GLM model and the official runtime probe succeeds. Configure
the WSL-native official executable, not a Windows `.cmd` wrapper or Paseo
daemon endpoint:

```bash
GLMOCR_PIPELINE_BIN=/absolute/path/to/glmocr-venv/bin/glmocr
# Optional. If omitted, the server uses `python` beside the glmocr executable.
GLMOCR_PIPELINE_PYTHON=/absolute/path/to/glmocr-venv/bin/python
```

The desktop negotiates this path with
`docContracts=ocr-document-v1`; successful bootstrap responses expose
`services.ocr.capabilities.documentContract = "ocr-document-v1"` and
`pdfMode = "server-pipeline"`. Legacy clients that do not negotiate the
contract retain the client-rasterized PDF path. The server passes its managed
provider endpoint and model to the official CLI through explicit `--set`
arguments and does not depend on `GLMOCR_OCR_*` variables.

Proxy the control panel to the same backend process:

```nginx
location = /echo-panel { return 302 /echo-panel/; }
location ^~ /echo-panel/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_request_buffering off;
    add_header X-Accel-Buffering no always;
}
```

The control panel login uses Better Auth email/password accounts stored in
PostgreSQL. To grant the first owner, register or create the Better Auth user
first, then run:

```powershell
npm run admin:promote --prefix server -- --email admin@example.com
```

The promotion script is not exposed over HTTP. It refuses to replace an existing
active owner with a different account.

Production must set real secrets. Placeholder secrets are rejected by `loadEnv()`.
Provider control requests also require positive `PROVIDER_CONTROL_DEADLINE_MS` and
`PROVIDER_CONTROL_MAX_IN_FLIGHT` values so outbound validation has an explicit
deadline and concurrency ceiling instead of an implicit runtime fallback.
Production must also set `TAURI_UPDATER_PUBLIC_KEY` to the same Base64-wrapped
Minisign public key configured for the Tauri updater. OTA draft validation fails
closed when that key is absent or the artifact signature does not verify.

Generate future migrations after schema changes:

```powershell
Push-Location server
try {
  npm exec -- drizzle-kit generate --config drizzle.config.ts
} finally {
  Pop-Location
}
```

Run Drizzle commands from `server/`: the schema and migration output paths in
`drizzle.config.ts` are relative to that directory.

The server does not run database migrations at process startup. A deployment
must apply every pending SQL file registered in
`src/db/migrations/meta/_journal.json`, in journal order, before switching the
new server bundle into service. The historical `0006` migration and the `0007`
quota-operation migration follow the repository's existing hand-authored SQL
convention and are journaled without retroactively regenerating old snapshots.
Because `0006` was already applied manually on deployments created before it
was journaled, its table and index creation are intentionally idempotent for
both an existing production schema and a fresh journal-driven database.
