// drizzle-kit's settings, for writing LB-07's migrations from its schema:
// `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb07.config.ts`. Applying
// them is src/core/database.ts's job (`just node-migrate`), which keeps every system inside its own
// schema, so drizzle-kit never needs a database connection here.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/lb07/db/schema.ts',
  out: './src/modules/lb07/db/migrations',
})
