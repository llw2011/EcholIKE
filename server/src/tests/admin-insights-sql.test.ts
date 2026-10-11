import { describe, expect, it } from 'vitest'
import { createPostgresAdminInsightsStore } from '../db/admin-insights.js'

describe('admin insight PostgreSQL query contract', () => {
  it('filters every overview fact by one account and joins current account identity', async () => {
    const queries: { text: string; values: unknown[] }[] = []
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      queries.push({ text, values })
      if (text.startsWith('with operation_rollup')) {
        return [
          {
            subject_id: 'account-a',
            subject_email: 'account-a@example.com',
            subject_name: 'Account A',
            stt_seconds: 1,
            llm_tokens: 2,
            ocr_images: 3,
            tts_chars: 4,
            reserved_count: 0,
            completed_count: 1,
            released_count: 0,
            expired_reservations: 0,
            unreconciled_operations: 0,
            adjustment_count: 1,
            audited_requests: 2,
            failed_requests: 1,
            latest_audit_at: null,
          },
        ]
      }
      return [
        {
          id: '33333333-3333-4333-8333-333333333333',
          user_id: 'account-a',
          user_email: 'renamed@example.com',
          user_name: 'Renamed Account',
          kind: 'llm_tokens',
          source: 'proxy_llm',
          period_key: '2026-07',
          request_id: 'request-a',
          reserved_amount: 3,
          actual_amount: 3,
          status: 'completed',
          lease_expires_at: null,
          response_status: 200,
          response_cached: true,
          ledger_net_amount: 3,
          ledger_event_count: 2,
          created_at: '2026-07-31T12:00:00.000001Z',
          updated_at: '2026-07-31T12:00:01.000Z',
        },
      ]
    }
    const store = createPostgresAdminInsightsStore(sql as never, 'fingerprint-secret')

    const overview = await store.getOverview({
      periodKey: '2026-07',
      userId: 'account-a',
      now: new Date('2026-07-31T12:00:00.000Z'),
    })
    const operations = await store.listQuotaOperations({
      cursor: null,
      limit: 25,
      userId: 'account-a',
      periodKey: '2026-07',
      kind: null,
      status: null,
    })

    expect(overview.subject).toEqual({
      id: 'account-a',
      email: 'account-a@example.com',
      name: 'Account A',
    })
    expect(queries[0]?.text).toContain('operation.user_id = ?')
    expect(queries[0]?.text).toContain('or user_id = ?')
    expect(queries[0]?.text).toContain("source = 'adjustment'")
    expect(queries[0]?.values.filter((value) => value === 'account-a').length).toBeGreaterThan(8)

    expect(queries[1]?.text).toContain(
      'join "user" account_user on account_user.id = operation.user_id',
    )
    expect(operations[0]).toMatchObject({
      userId: 'account-a',
      userEmail: 'renamed@example.com',
      userName: 'Renamed Account',
      reconciled: true,
    })
  })
})
