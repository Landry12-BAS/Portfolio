// drizzle-kit's settings, for writing LB-06's migrations from its schema:
// `pnpm --filter @lb/node-systems exec drizzle-kit generate --config drizzle.lb06.config.ts`. Applying
// them is src/core/database.ts's job (`just node-migrate`). LB-08's are in drizzle.config.ts and
// LB-04's in drizzle.lb04.config.ts.
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/lb06/db/schema.ts',
  out: './src/modules/lb06/db/migrations',
})
