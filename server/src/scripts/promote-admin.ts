import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'

loadLocalEnv()

const databaseUrl = process.env.DATABASE_URL?.trim()
const email = argValue('--email') ?? process.env.ADMIN_EMAIL?.trim()

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}
if (!email) {
  throw new Error('Usage: npm run admin:promote -- --email admin@example.com')
}

const client = postgres(databaseUrl, { max: 1, prepare: false })

try {
  const users = await client<{ id: string; email: string }[]>`
    select id, email
    from "user"
    where lower(email) = lower(${email})
    limit 1
  `
  const user = users[0]
  if (!user) {
    throw new Error(`No Better Auth user found for email: ${email}`)
  }

  const owners = await client<{ user_id: string; email: string }[]>`
    select admin_account.user_id, "user".email
    from admin_account
    inner join "user" on "user".id = admin_account.user_id
    where admin_account.role = 'owner'
      and admin_account.status = 'active'
    limit 1
  `
  const existingOwner = owners[0]
  if (existingOwner && existingOwner.user_id !== user.id) {
    throw new Error(`Active owner already exists: ${existingOwner.email}`)
  }

  await client`
    insert into admin_account (user_id, role, status, created_by, updated_at)
    values (${user.id}, 'owner', 'active', null, now())
    on conflict (user_id)
    do update set role = 'owner', status = 'active', updated_at = now()
  `

  console.log(`Promoted ${user.email} to owner`)
} finally {
  await client.end()
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined
  return value || undefined
}

function loadLocalEnv(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = unquote(trimmed.slice(separatorIndex + 1).trim())
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
