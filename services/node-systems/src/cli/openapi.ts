// `just node-openapi`: regenerates services/node-systems/openapi.json from the routes'
// schemas. Run it after any change to an API route or to a contract the routes use; `pnpm
// check` and a test fail while the committed file is stale.
import { writeFileSync } from 'node:fs'

import { OPENAPI_FILE, renderOpenApi } from '../documentation.ts'
import { MODULES } from '../modules/registry.ts'

writeFileSync(OPENAPI_FILE, await renderOpenApi(MODULES))
console.log(`Wrote ${OPENAPI_FILE}`)
