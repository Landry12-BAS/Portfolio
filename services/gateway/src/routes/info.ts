import type { FastifyInstance } from 'fastify'

import { modelMeters, quotaMeters } from '../budget/meters.ts'
import type { Meter } from '../budget/meters.ts'
import type { GatewayContext } from '../call.ts'

const noCeilings = { minuteCeiling: 1, dayCeiling: 1 }

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function registerInfo(app: FastifyInstance, ctx: GatewayContext): void {
  // The aliases the calling service may use, in the OpenAI list format.
  app.get('/models', async (request) => {
    const names = new Set<string>()
    for (const system of ctx.routing.systems.values()) {
      if (system.service === request.service) system.aliases.forEach(name => names.add(name))
    }
    const data = [...names].sort().flatMap((name) => {
      const alias = ctx.routing.aliases.get(name)
      return alias ? [{ id: alias.name, object: 'model', created: 0, owned_by: 'lb-gateway', kind: alias.kind, description: alias.description }] : []
    })
    return { object: 'list', data }
  })

  // Usage against every provider limit and system quota, for the daily usage report and
  // its alert (docs/PLAYBOOK.md, Operating on free tiers).
  app.get('/usage', async () => {
    const now = ctx.now()
    const meters = new Map<string, Meter>()
    for (const model of ctx.routing.models.values()) {
      for (const meter of modelMeters(ctx.routing, model, { input: 0, output: 0 }, ctx.prefix, now, noCeilings)) meters.set(meter.key, meter)
    }
    for (const system of ctx.routing.systems.values()) {
      const [daily] = quotaMeters(system, undefined, 'report', ctx.prefix, now)
      if (daily) meters.set(daily.key, daily)
    }
    const list = [...meters.values()]
    const used = await ctx.meters.read(list)
    const { alertAt, dayCeiling, minuteCeiling } = ctx.routing.budgets
    return {
      at: new Date(now).toISOString(),
      meters: list.map((meter, i) => {
        const share = meter.limit > 0 ? (used[i] ?? 0) / meter.limit : 0
        const ceiling = meter.scope.startsWith('system:') ? 1 : meter.window === 'day' ? dayCeiling : minuteCeiling
        return {
          scope: meter.scope,
          unit: meter.unit,
          window: meter.window,
          used: round(used[i] ?? 0),
          limit: meter.limit,
          ceiling: round(meter.limit * ceiling),
          share: round(share),
          alert: meter.window === 'day' && share >= alertAt,
        }
      }),
    }
  })
}

export function registerHealth(app: FastifyInstance, ctx: GatewayContext, ping: () => Promise<unknown>): void {
  // Liveness: the process is up. No dependencies, so a Redis blip never restarts it.
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Readiness: the budget store answers and at least one provider can serve traffic.
  app.get('/readyz', async (_request, reply) => {
    const providers = [...ctx.routing.providers.values()]
      .filter(provider => provider.configured && (ctx.profile === 'dev' || provider.terms === 'production'))
      .map(provider => provider.key)
    let redis = true
    try {
      await ping()
    }
    catch {
      redis = false
    }
    const ready = redis && providers.length > 0
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'unavailable', redis, providers })
  })
}
