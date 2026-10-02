// The limits the site's server puts on what it forwards to each system: how big a request body
// may be, how long the system has to answer, and how big its answer may be. They are set a
// little above what the system itself allows (its own request limits and deadlines are in
// services/*/README.md and in infra/caddy/Caddyfile), so the site never cuts off a request the
// system would have taken, and never waits on one longer than the system or the edge would.
import type { SystemName } from '@lb/api-clients/routes'

import { LB03_SITE_UPLOAD_BYTES } from '../../shared/lb03-limits.ts'

/** The limits for one system. */
export interface SystemPolicy {
  // The most bytes of request body forwarded.
  maxBodyBytes: number
  // The most bytes of a file upload forwarded, for a system whose routes take one; absent for a system that takes none.
  maxUploadBytes?: number
  // How long to wait for the system's answer, in milliseconds.
  timeoutMs: number
  // The most bytes of answer read back.
  maxResponseBytes: number
}

const KIB = 1_024
const MIB = 1_024 * KIB

/**
 * The limits of each system.
 * - LB-01 takes a ticket of 2,000 characters; the edge gives Django 60 seconds, and its calls are polls.
 * - LB-02's routes here only read: its conversation runs over the WebSocket.
 * - LB-05 answers a question synchronously within 90 seconds (the edge gives it 95), and a result may hold rows.
 * - LB-08 takes a workflow graph of at most 16 steps; its describe call may make two model calls (95 seconds at the edge).
 * - LB-03 takes a file of 4 MiB here (the service takes 10 MB, a Vercel function 4.5 MB: shared/lb03-limits.ts), and a
 *   correction of a few hundred bytes of JSON. Reading a document is a queue the visitor polls, so every call is short: the
 *   upload stores the file and answers 202. It answers with a page's picture or an export, which a page of 1,800 pixels
 *   and a table of a few dozen lines keep far under 2 MiB.
 */
export const SYSTEM_POLICIES: Readonly<Record<SystemName, SystemPolicy>> = {
  'lb-01': { maxBodyBytes: 8 * KIB, timeoutMs: 25_000, maxResponseBytes: 256 * KIB },
  'lb-02': { maxBodyBytes: 4 * KIB, timeoutMs: 25_000, maxResponseBytes: 256 * KIB },
  'lb-05': { maxBodyBytes: 4 * KIB, timeoutMs: 95_000, maxResponseBytes: MIB },
  'lb-08': { maxBodyBytes: 64 * KIB, timeoutMs: 95_000, maxResponseBytes: MIB },
  'lb-03': { maxBodyBytes: 4 * KIB, maxUploadBytes: LB03_SITE_UPLOAD_BYTES, timeoutMs: 25_000, maxResponseBytes: 2 * MIB },
}

/** The most a trace page from the gateway may weigh: the gateway cuts its pages at 256 KB, and this leaves room for the envelope. */
export const MAX_TRACE_PAGE_BYTES = 320 * KIB
/** How long the gateway has to answer a trace read. */
export const TRACE_TIMEOUT_MS = 10_000
