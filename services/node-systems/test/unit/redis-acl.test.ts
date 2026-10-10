// Tests that Redis lets the Node systems run every command BullMQ's own scripts can send. BullMQ moves
// jobs with Lua scripts, and Redis checks each command inside a script against the caller's rule
// (infra/redis/users.acl.tmpl). A command the rule leaves out stops the script halfway, on the box and
// nowhere else: the first release did that every minute, on ZREMRANGEBYSCORE, when a finished job's
// script went on to remove the jobs older than it keeps. That path only runs once such jobs exist, so
// no suite reached it. This test reads the scripts of the BullMQ that is installed, so a new version
// that sends a new command fails here and not in production. It needs no Redis and no network.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ACL_FILE = join(import.meta.dirname, '../../../../infra/redis/users.acl.tmpl')
const BULLMQ_SCRIPTS = join(dirname(createRequire(import.meta.url).resolve('bullmq/package.json')), 'dist/cjs/scripts')

/** A script's call to Redis: rcall("ZADD", ...), redis.call('zadd', ...) or redis.pcall(...). */
const SCRIPT_CALL = /(?:rcall|redis\.p?call)\(\s*\\?["']([A-Za-z]+)\\?["']/g

/** Returns the rule of one Redis user as a single line, its continuation lines joined. */
function ruleOf(user: string): string {
  const lines = readFileSync(ACL_FILE, 'utf8').split('\n')
  const first = lines.findIndex(line => line.startsWith(`user ${user} `))
  if (first === -1) throw new Error(`users.acl.tmpl has no rule for ${user}`)
  let last = first
  while (lines[last]?.endsWith('\\')) last += 1
  return lines.slice(first, last + 1).map(line => line.replace(/\\$/, '')).join(' ')
}

/** Returns the commands a rule allows on the keys of BullMQ's queues: the +command words of the selector that names `lb:bull:`. */
function commandsOnQueueKeys(rule: string): Set<string> {
  const selector = [...rule.matchAll(/\(([^)]*)\)/g)].map(found => found[1] ?? '').find(text => text.includes('~lb:bull:'))
  if (selector === undefined) throw new Error('the rule has no selector for the keys of BullMQ\'s queues')
  return new Set([...selector.matchAll(/\+([a-z]+)/g)].map(found => found[1] ?? ''))
}

/** Returns every Redis command the installed BullMQ's scripts can send, in lower case. */
function commandsOfScripts(): Set<string> {
  const commands = new Set<string>()
  for (const file of readdirSync(BULLMQ_SCRIPTS).filter(name => name.endsWith('.js'))) {
    for (const call of readFileSync(join(BULLMQ_SCRIPTS, file), 'utf8').matchAll(SCRIPT_CALL)) {
      commands.add((call[1] ?? '').toLowerCase())
    }
  }
  return commands
}

describe('the Redis rule of the Node systems', () => {
  it('finds BullMQ\'s scripts and the commands they send, the one the box was refused among them', () => {
    const commands = commandsOfScripts()

    expect(commands.size).toBeGreaterThan(30)
    expect(commands).toContain('zremrangebyscore')
  })

  it('allows every command BullMQ\'s scripts can send on the keys of its queues', () => {
    const allowed = commandsOnQueueKeys(ruleOf('node-systems'))
    const refused = [...commandsOfScripts()].filter(command => !allowed.has(command)).sort()

    expect(refused).toEqual([])
  })

  it('still runs those scripts at all, and reaches no key outside its own queues with them', () => {
    const rule = ruleOf('node-systems')
    const allowed = commandsOnQueueKeys(rule)

    expect(allowed).toContain('evalsha')
    expect(allowed).toContain('eval')
    expect(rule).toContain('-@all')
    expect(rule).not.toMatch(/~\*|allkeys/)
  })
})
