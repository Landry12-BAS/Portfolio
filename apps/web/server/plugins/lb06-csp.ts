// Gives LB-06's two board pages the one addition to the Content Security Policy they need (see
// server/lib/lb06-csp.ts): the API's WebSocket host in `connect-src`. It uses the hook nuxt-security
// calls when it has collected the route rules, as LB-02's and LB-04's plugins do.
import { defineNitroPlugin } from 'nitropack/runtime'

import { addLb06Policy } from '../lib/lb06-csp.ts'
import { nitroServices } from '../lib/nitro-services.ts'

/** Registers the addition to run when the security rules are collected. */
export default defineNitroPlugin((nitroApp) => {
  const { state } = nitroServices()
  const api = state.status === 'ready' ? state.config.apiUrl : undefined
  nitroApp.hooks.hook('nuxt-security:routeRules', (rules) => {
    addLb06Policy(rules, api)
  })
})
