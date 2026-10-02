// Unit tests for the schemas LB-01's board checks the API's answers with: the answers the real Django
// service gave, word for word, must pass, and an answer that does not fit must not.
import { describe, expect, it } from 'vitest'

import { ticketSchema } from '~/boards/lb-01/schemas'

// The answer to filing a ticket as the real Django API gave it (services/django-systems, run without a
// worker, on 2026-10-02): the pipeline had not started, so the ticket has no category and no run.
const FILED_ON_REAL_DJANGO = {
  id: 'qZeJdxFIisF3qdBJ',
  customer: { key: 'cus-0001', name: 'Sam Carter', language: 'en' },
  language: 'en',
  status: 'received',
  category: '',
  created_at: '2026-10-02T02:41:10.806Z',
  body: 'My order arrived with a torn bag and I would like a refund.',
  order_number: '',
  escalation_reason: '',
  run_id: '',
  expires_at: '2026-10-03T02:41:10.805Z',
  draft: null,
  decision: null,
}

describe('LB-01\'s ticket schema', () => {
  it('accepts a ticket the real API has just filed, which has no run yet', () => {
    expect(ticketSchema.safeParse(FILED_ON_REAL_DJANGO).success).toBe(true)
  })

  it('accepts a ticket with the ID of its run', () => {
    expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, run_id: 'run-3f9a1c7e2b' }).success).toBe(true)
  })

  it('refuses a run ID that is not one: too short, too long, or with characters a path should not carry', () => {
    for (const runId of ['short', 'r'.repeat(65), '../../etc/passwd', 'run 3f9a1c7e2b', 'run/3f9a1c7e2b']) {
      expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, run_id: runId }).success, runId).toBe(false)
    }
  })

  it('refuses a status the board would not know how to show', () => {
    expect(ticketSchema.safeParse({ ...FILED_ON_REAL_DJANGO, status: 'archived' }).success).toBe(false)
  })
})
