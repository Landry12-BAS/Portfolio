// Gives LB-09's two board pages the additions to the security headers they need (see
// server/lib/lb09-policy.ts): the API's WebSocket host in the Content Security Policy, and the
// microphone in the Permissions-Policy. It runs before nuxt-security's own plugins, which
// nuxt-security arranges, and uses the hook that module calls when it has collected the route rules.
import { defineNitroPlugin } from 'nitropack/runtime'
import { addLb09Policy } from '../lib/lb09-policy.ts'
import { nitroServices } from '../lib/nitro-services.ts'

/** Registers the additions to run when the security rules are collected. */
export default defineNitroPlugin((nitroApp) => {
  const { state } = nitroServices()
  const api = state.status === 'ready' ? state.config.apiUrl : undefined
  nitroApp.hooks.hook('nuxt-security:routeRules', (rules) => {
    addLb09Policy(rules, api)
  })
})
