// Checks the site's settings when the server starts, so a mistake in a deploy is a server that
// refuses to start, not a demo that fails for the first visitor. With none of the NUXT_* variables
// set (a preview deployment) the site starts with its demos off. With some set, they must all be
// right, or this throws and the server doesn't come up: it fails closed. The error names the
// variables and the rules they break, never their values.
import { defineNitroPlugin } from 'nitropack/runtime'

import { nitroServices } from '../lib/nitro-services.ts'

/** Builds the services at startup, which checks the settings, and logs whether the demos are on. */
export default defineNitroPlugin(() => {
  const { state } = nitroServices()
  console.info(JSON.stringify({ event: 'site_config', demos: state.status === 'ready' ? 'on' : 'off' }))
})
