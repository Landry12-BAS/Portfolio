// The synthetic data the mock back end draws on, read from the files the real LB-01 is seeded
// from: the customers, the policies a draft cites, the orders the order tool reads, and the
// curated sample tickets of the golden set. So the mock's customers, sources and tickets are the
// real ones, and nothing about them is written out a second time.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

/** The two languages of the site, the policies and the replies. */
export type Language = 'en' | 'cs'

/** A synthetic customer a visitor can file a ticket as. */
export interface CustomerSeed {
  key: string
  name: string
  language: Language
}

/** One citable passage of a policy, in both languages, with where it sits. */
export interface PassageSeed {
  key: string
  policyTitle: Record<Language, string>
  position: number
  title: Record<Language, string>
  text: Record<Language, string>
}

/** A synthetic order, with what the order tool tells a draft about it. */
export interface OrderSeed {
  number: string
  customer: string
  status: string
  carrier: string
  trackingNumber: string
  totalCzk: number
  items: { product: string, grams: number, quantity: number }[]
}

/** What the golden set expects of a ticket. */
export interface GoldenExpectation {
  route: 'awaiting_approval' | 'escalated'
  category?: string | string[]
  order?: string
  cites?: string[]
  reason?: string
}

/** One ticket of the golden set; the curated samples have `sample` set. */
export interface GoldenCase {
  id: string
  customer: string
  language: Language
  sample: boolean
  ticket: string
  expect: GoldenExpectation
}

/** Everything the mock reads from the seed and the golden set. */
export interface Seed {
  customers: CustomerSeed[]
  passages: Map<string, PassageSeed>
  orders: Map<string, OrderSeed>
  golden: GoldenCase[]
}

// The repository's root, from this file: packages/api-clients/src/testing/.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`

/** A parsed YAML document, before it is looked at. */
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads and parses one YAML file of the repository. */
function readYaml(path: string): Loose {
  return parse(readFileSync(`${REPOSITORY_ROOT}${path}`, 'utf8')) as Loose
}

/** Reads the policies into passages that carry their policy's title and their own place in it. */
function readPassages(): Map<string, PassageSeed> {
  const passages = new Map<string, PassageSeed>()
  for (const policy of readYaml('data/seed/lb01/policies.yaml').policies as Loose[]) {
    for (const [index, passage] of (policy.passages as Loose[]).entries()) {
      passages.set(passage.key, {
        key: passage.key,
        policyTitle: policy.title,
        position: index + 1,
        title: passage.title,
        text: { en: String(passage.text.en).trim(), cs: String(passage.text.cs).trim() },
      })
    }
  }
  return passages
}

/** Reads the orders. */
function readOrders(): Map<string, OrderSeed> {
  const orders = new Map<string, OrderSeed>()
  for (const order of readYaml('data/seed/lb01/orders.yaml').orders as Loose[]) {
    orders.set(order.number, {
      number: order.number,
      customer: order.customer,
      status: order.status,
      carrier: order.carrier,
      trackingNumber: order.tracking_number,
      totalCzk: order.total_czk,
      items: (order.items as Loose[]).map(item => ({ product: item.product, grams: item.grams, quantity: item.quantity })),
    })
  }
  return orders
}

/** Reads the golden set's tickets. */
function readGolden(): GoldenCase[] {
  return (readYaml('evals/lb01/golden.yaml').cases as Loose[]).map(item => ({
    id: item.id,
    customer: item.customer,
    language: item.language,
    sample: item.sample === true,
    ticket: String(item.ticket).trim(),
    expect: item.expect,
  }))
}

/** Reads the seed and the golden set from the repository. */
export function readSeed(): Seed {
  const customers = (readYaml('data/seed/lb01/customers.yaml').customers as CustomerSeed[]).map(({ key, name, language }) => ({ key, name, language }))
  return { customers, passages: readPassages(), orders: readOrders(), golden: readGolden() }
}
