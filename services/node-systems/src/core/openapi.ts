// The OpenAPI document of the Node systems, generated from the Zod schemas the routes
// already use, so the site's typed client can never fall behind the API. The live service
// has no interactive documentation page: the schema is served at /api/openapi.json for
// generating the client, and committed as openapi.json, where a check fails when it is stale.
import fastifySwagger from '@fastify/swagger'
import { createJsonSchemaTransform, createJsonSchemaTransformObject } from 'fastify-type-provider-zod'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

/** Schemas to publish under a name of their own (`components.schemas`), so the document and the typed client stay readable. */
export type SchemaNames = Readonly<Record<string, z.ZodType>>

/** Registers the OpenAPI generator, and the route that serves its document. Call it before any route is added. */
export async function registerOpenApi(app: FastifyInstance, names: SchemaNames): Promise<void> {
  const registry = z.registry<{ id?: string }>()
  for (const [id, schema] of Object.entries(names)) registry.add(schema, { id })
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LB Node systems',
        version: '0.1.0',
        description: 'The API behind the LB systems built on Node. Every route needs a visitor token minted by the site for its system.',
      },
      components: {
        securitySchemes: {
          visitorToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'A short-lived Ed25519-signed token the site mints for one system and one anonymous visitor.',
          },
        },
      },
    },
    transform: createJsonSchemaTransform({ schemaRegistry: registry }),
    transformObject: createJsonSchemaTransformObject({ schemaRegistry: registry }),
  })
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger())
}

/** Copies a value with every object's keys in sorted order, so the same API always renders as the same text. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, sortedKeys(inner)]))
  }
  return value
}

/** Renders the app's OpenAPI document as the committed file stores it: sorted keys, two-space indents and a final newline. */
export function openApiDocument(app: FastifyInstance): string {
  return `${JSON.stringify(sortedKeys(app.swagger()), null, 2)}\n`
}
