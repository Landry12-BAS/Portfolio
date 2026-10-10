// drizzle-kit's settings, for writing LB-08's migrations from its schema:
// `pnpm --filter @lb/node-systems exec drizzle-kit generate`. Applying them is
// src/core/database.ts's job (`just node-migrate`), which keeps every system inside its own
// schema, so drizzle-kit never needs a database connection here.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/lb08/db/schema.ts',
  out: './src/modules/lb08/db/migrations',
})
