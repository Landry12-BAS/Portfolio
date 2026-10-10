// drizzle-kit's settings, for writing LB-04's migrations from its schema:
// `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb04.config.ts`. Applying
// them is src/core/database.ts's job (`just node-migrate`), which keeps every system inside its own
// schema, so drizzle-kit never needs a database connection here. LB-08's are in drizzle.config.ts.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/lb04/db/schema.ts',
  out: './src/modules/lb04/db/migrations',
})
