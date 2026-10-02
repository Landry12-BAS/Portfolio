// Tells Zod not to build its parsers with `new Function`, which the site's Content Security Policy
// forbids (Trusted Types is required for scripts, docs/SECURITY.md section 3). Left alone, Zod
// probes for `eval` the first time it makes an object schema, the probe is caught and harmless, but
// the browser reports each one as a policy violation, which the end-to-end tests (and any report-uri)
// rightly treat as a problem. With `jitless` Zod uses its ordinary parser and never probes. It
// runs at the top of this file so it is set before the first schema is made: this plugin is
// imported before the pages and the stores that hold the boards' schemas.
import { z } from 'zod'

z.config({ jitless: true })

export default defineNuxtPlugin(() => {
  // Nothing to do per request: the setting is Zod's own, and global.
})
