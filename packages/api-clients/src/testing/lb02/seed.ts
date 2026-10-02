// What the mock's LB-02 draws on: the rooms and offerings of the synthetic calendar, read from the file
// the real service is seeded from (data/seed/lb02/offerings.yaml), so the mock's offerings are the
// real ones and nothing about them is written out a second time.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

import type { OfferingSeed } from './calendar.ts'

// The repository's root, from this file: packages/api-clients/src/testing/lb02/.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../../..')}/`

/** A parsed YAML document, before it is looked at. */
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads the offerings of the LB-02 seed, each with the name of its room and its start times. */
export function readOfferings(): OfferingSeed[] {
  const seed = parse(readFileSync(`${REPOSITORY_ROOT}data/seed/lb02/offerings.yaml`, 'utf8')) as Loose
  const rooms = new Map<string, { en: string, cs: string }>((seed.resources as Loose[]).map(room => [room.key as string, { en: String(room.name.en), cs: String(room.name.cs) }]))
  return (seed.offerings as Loose[]).map(offering => ({
    key: offering.key as string,
    room: offering.resource as string,
    title: { en: String(offering.title.en), cs: String(offering.title.cs) },
    summary: { en: String(offering.summary.en), cs: String(offering.summary.cs) },
    roomName: rooms.get(offering.resource as string) ?? { en: String(offering.resource), cs: String(offering.resource) },
    durationMinutes: offering.duration_minutes as number,
    capacity: offering.capacity as number,
    priceCzk: offering.price_czk as number,
    starts: offering.starts as string[],
  }))
}
