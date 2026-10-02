// What the mock back end knows about the real ones: the committed OpenAPI documents. It lists
// their operations, checks a request's body against the document's schema, checks an answer
// against the schema of the status it carries, and makes a schema-valid example answer for a
// route nobody wrote a handler for. So the mock cannot drift from the documents: a route a
// document drops stops being served, and a handler whose answer stops fitting its schema
// fails a test.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import type { ServiceName } from '../route-types.ts'

/** A JSON value as a document writes it: schemas are plain objects. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** A JSON Schema, as far as the examples and the checks need to read one. */
type Schema = { [key: string]: Json }

/** One response an operation documents. */
interface ResponseObject {
  content?: Record<string, { schema?: Schema } | undefined>
}

/** One operation of a document: what it takes and what it can answer. */
interface OperationObject {
  requestBody?: { content?: Record<string, { schema?: Schema } | undefined> }
  responses?: Record<string, ResponseObject | undefined>
}

/** An OpenAPI document, as far as the mock reads it. */
interface Document {
  paths: Record<string, Record<string, OperationObject | undefined>>
  components?: { schemas?: Record<string, Schema> }
}

/** One operation the mock serves: its place in a document, and the template its path is matched with. */
export interface MockOperation {
  service: ServiceName
  method: string
  // The path as the document writes it, such as `/api/lb01/tickets/{ticket_id}`.
  template: string
  // The template split into segments, each literal or a `{parameter}`.
  segments: readonly string[]
  operation: OperationObject
}

const SERVICES: readonly { service: ServiceName, file: string }[] = [
  { service: 'django', file: 'services/django-systems/openapi.json' },
  { service: 'flask', file: 'services/flask-systems/openapi.json' },
  { service: 'node', file: 'services/node-systems/openapi.json' },
]
// The repository's root, from this file: packages/api-clients/src/testing/.
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// The HTTP methods an operation may be under in a document.
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options']
// How deep an example goes into nested objects before it stops, so a recursive schema ends.
const MAX_EXAMPLE_DEPTH = 6

/** The three documents, read and indexed, with a validator for any schema in them. */
export class OpenApiDocuments {
  readonly operations: MockOperation[] = []
  readonly #documents = new Map<ServiceName, Document>()
  readonly #ajv: Ajv2020
  readonly #validators = new Map<string, ValidateFunction>()

  /** Reads the committed documents, from the repository's services folders. */
  constructor() {
    // Unknown keywords in a document (`openapi`, `paths`) are not errors, and formats are checked.
    this.#ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats.default(this.#ajv)
    for (const { service, file } of SERVICES) {
      const document = JSON.parse(readFileSync(`${REPOSITORY_ROOT}${file}`, 'utf8')) as Document
      this.#documents.set(service, document)
      this.#ajv.addSchema(document as unknown as Schema, service)
      for (const [template, methods] of Object.entries(document.paths)) {
        for (const method of METHODS) {
          const operation = methods[method]
          if (operation) this.operations.push({ service, method: method.toUpperCase(), template, segments: template.split('/'), operation })
        }
      }
    }
  }

  /** Finds the operation a request is: the method, and a path whose segments fit the template. */
  find(method: string, pathname: string): { operation: MockOperation, params: Record<string, string> } | undefined {
    const parts = pathname.split('/')
    for (const operation of this.operations) {
      if (operation.method !== method || operation.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      const fits = operation.segments.every((segment, index) => {
        const part = parts[index] ?? ''
        const name = /^\{(\w+)\}$/.exec(segment)?.[1]
        if (name === undefined) return segment === part
        params[name] = part
        return part !== ''
      })
      if (fits) return { operation, params }
    }
    return undefined
  }

  /** Writes the references of a schema as references into the document `service`, so a schema lifted out of it still resolves. */
  #anchored(service: ServiceName, schema: Json): Json {
    if (Array.isArray(schema)) return schema.map(item => this.#anchored(service, item))
    if (schema === null || typeof schema !== 'object') return schema
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
      key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#') ? `${service}${value}` : this.#anchored(service, value),
    ]))
  }

  /** Builds (once) a validator for a schema of a document. */
  #validator(service: ServiceName, key: string, schema: Schema): ValidateFunction {
    const cacheKey = `${service}:${key}`
    const cached = this.#validators.get(cacheKey)
    if (cached) return cached
    const validate = this.#ajv.compile(this.#anchored(service, schema) as Schema)
    this.#validators.set(cacheKey, validate)
    return validate
  }

  /** Returns the JSON schema of the request body of an operation, when it takes one. */
  requestSchema(operation: MockOperation): Schema | undefined {
    return operation.operation.requestBody?.content?.['application/json']?.schema
  }

  /** Returns the JSON schema of what an operation answers with for a status, when it documents one. */
  responseSchema(operation: MockOperation, status: number): Schema | undefined {
    return operation.operation.responses?.[String(status)]?.content?.['application/json']?.schema
  }

  /** Returns the first success status an operation documents, such as 200 or 202. */
  successStatus(operation: MockOperation): number {
    const statuses = Object.keys(operation.operation.responses ?? {}).map(Number).filter(status => status >= 200 && status < 300)
    return statuses[0] ?? 200
  }

  /** Checks a request body against the operation's schema, and returns the problems found (none when it fits). */
  checkRequest(operation: MockOperation, body: unknown): string[] {
    const schema = this.requestSchema(operation)
    if (!schema) return body === undefined ? [] : ['This route takes no body.']
    return this.#problems(operation, `request:${operation.method}:${operation.template}`, schema, body)
  }

  /** Checks an answer against what the operation documents for that status, and returns the problems found. */
  checkResponse(operation: MockOperation, status: number, body: unknown): string[] {
    const schema = this.responseSchema(operation, status)
    if (!schema) return body === undefined ? [] : [`${operation.method} ${operation.template} documents no JSON body for ${status}.`]
    return this.#problems(operation, `response:${status}:${operation.method}:${operation.template}`, schema, body)
  }

  /** Runs a validator and turns its errors into short sentences. */
  #problems(operation: MockOperation, key: string, schema: Schema, body: unknown): string[] {
    const validate = this.#validator(operation.service, key, schema)
    if (validate(body)) return []
    return (validate.errors ?? []).map(error => `${error.instancePath || '(body)'} ${error.message ?? 'is wrong'}`)
  }

  /** Makes an answer that fits the operation's documented schema for a status. */
  exampleResponse(operation: MockOperation, status: number): Json | undefined {
    const schema = this.responseSchema(operation, status)
    return schema ? this.#example(operation.service, schema, 0) : undefined
  }

  /** Makes a request body that fits the operation's schema, or returns undefined when the operation takes none. */
  exampleRequest(operation: MockOperation): Json | undefined {
    const schema = this.requestSchema(operation)
    return schema ? this.#example(operation.service, schema, 0) : undefined
  }

  /** Looks a `#/components/...` reference up in its document. */
  #resolve(service: ServiceName, reference: string): Schema {
    const name = reference.replace('#/components/schemas/', '')
    const found = this.#documents.get(service)?.components?.schemas?.[name]
    if (!found) throw new Error(`The ${service} document has no schema ${reference}.`)
    return found
  }

  /** Makes a value that fits a schema: the simplest one that does, with one item in each list. */
  #example(service: ServiceName, schema: Schema, depth: number): Json {
    if (typeof schema.$ref === 'string') return this.#example(service, this.#resolve(service, schema.$ref), depth)
    if ('const' in schema) return schema.const ?? null
    if (Array.isArray(schema.enum)) return schema.enum[0] ?? null
    if ('default' in schema && schema.default !== null) return schema.default ?? null
    for (const key of ['anyOf', 'oneOf']) {
      const options = schema[key]
      if (Array.isArray(options)) {
        const option = options.find(candidate => !(typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) && candidate.type === 'null'))
        return this.#example(service, (option ?? options[0] ?? {}) as Schema, depth)
      }
    }
    if (Array.isArray(schema.allOf)) {
      return Object.assign({}, ...schema.allOf.map(part => this.#example(service, part as Schema, depth)))
    }
    const type = Array.isArray(schema.type) ? schema.type.find(candidate => candidate !== 'null') : schema.type
    return this.#typed(service, schema, type, depth)
  }

  /** Makes the example of a schema of a known type. */
  #typed(service: ServiceName, schema: Schema, type: Json | undefined, depth: number): Json {
    switch (type) {
      case 'string': return exampleString(schema)
      case 'integer': return typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : 0
      case 'number': return typeof schema.minimum === 'number' ? schema.minimum : 0
      case 'boolean': return false
      case 'array': {
        if (depth >= MAX_EXAMPLE_DEPTH || typeof schema.items !== 'object' || Array.isArray(schema.items)) return []
        const count = typeof schema.minItems === 'number' ? Math.max(schema.minItems, 1) : 1
        return Array.from({ length: count }, () => this.#example(service, schema.items as Schema, depth + 1))
      }
      case 'object': return this.#object(service, schema, depth)
      default: return depth < MAX_EXAMPLE_DEPTH && typeof schema.properties === 'object' ? this.#object(service, schema, depth) : null
    }
  }

  /** Makes an object with every property its schema lists. */
  #object(service: ServiceName, schema: Schema, depth: number): Json {
    const properties = (typeof schema.properties === 'object' && schema.properties !== null && !Array.isArray(schema.properties) ? schema.properties : {}) as Record<string, Schema>
    const entries = depth >= MAX_EXAMPLE_DEPTH ? [] : Object.entries(properties)
    return Object.fromEntries(entries.map(([name, property]) => [name, this.#example(service, property, depth + 1)]))
  }
}

/** Makes a string that fits a schema's format and minimum length. */
function exampleString(schema: Schema): string {
  switch (schema.format) {
    case 'date-time': return '2026-10-05T09:00:00Z'
    case 'date': return '2026-10-05'
    case 'uuid': return '3b241101-e2bb-4255-8caf-4136c566a962'
    case 'email': return 'sam.carter@example.test'
    default: break
  }
  const minimum = typeof schema.minLength === 'number' ? schema.minLength : 0
  return 'example'.padEnd(Math.max(minimum, 7), 'x')
}
