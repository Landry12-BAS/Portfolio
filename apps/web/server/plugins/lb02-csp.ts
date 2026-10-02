// Gives LB-02's two board pages the additions to the Content Security Policy they need (see
// server/lib/lb02-csp.ts): the API's WebSocket host, the service worker's Trusted Types policy and the
// worker source. It runs before nuxt-security's own plugins, which nuxt-security arranges, and uses the
// hook that module calls when it has collected the route rules.
import { defineNitroPlugin } from 'nitropack/runtime'

import { addLb02Policy } from '../lib/lb02-csp.ts'
import { nitroServices } from '../lib/nitro-services.ts'

/** Registers the additions to run when the security rules are collected. */
export default defineNitroPlugin((nitroApp) => {
  const { state } = nitroServices()
  const api = state.status === 'ready' ? state.config.apiUrl : undefined
  nitroApp.hooks.hook('nuxt-security:routeRules', (rules) => {
    addLb02Policy(rules, api)
  })
})
