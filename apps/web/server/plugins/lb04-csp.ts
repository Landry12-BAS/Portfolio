// Gives LB-04's two board pages the additions to the Content Security Policy they need (see
// server/lib/lb04-csp.ts): the PDF worker's Trusted Types policy and the worker source. It uses the hook
// nuxt-security calls when it has collected the route rules, as LB-02's plugin does for its own pages.
import { defineNitroPlugin } from 'nitropack/runtime'

import { addLb04Policy } from '../lib/lb04-csp.ts'

/** Registers the additions to run when the security rules are collected. */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('nuxt-security:routeRules', (rules) => {
    addLb04Policy(rules)
  })
})
