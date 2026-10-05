// The simulator's only source of randomness: a hash of the incident's seed and the name of the
// thing being drawn. There is no generator state to carry along, so the noise of minute 40 of
// the cart's latency is the same number whether it is computed first, last, or alone, and a
// replay from the seed and the event log gives exactly the series the live run showed.

/** FNV-1a over the text, as an unsigned 32-bit number. */
export function hash32(text: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Mixes a hashed value once more (a 32-bit finaliser), so nearby keys give unrelated numbers. */
function mix(value: number): number {
  let mixed = value >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7FEB352D) >>> 0
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, 0x846CA68B) >>> 0
  mixed ^= mixed >>> 16
  return mixed >>> 0
}

/** A number in [0, 1) that depends only on the seed and the keys. */
export function unit(seed: number, ...keys: readonly (string | number)[]): number {
  return mix(hash32(`${seed}|${keys.join('|')}`)) / 4_294_967_296
}

/** A roughly normal number with mean 0 and standard deviation 1, clamped to three deviations, from the seed and the keys. */
export function gaussian(seed: number, ...keys: readonly (string | number)[]): number {
  const first = Math.max(unit(seed, ...keys, 'a'), 1e-9)
  const second = unit(seed, ...keys, 'b')
  const value = Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
  return Math.max(-3, Math.min(3, value))
}

/** Picks one of the items by the seed and the keys. */
export function pick<Item>(items: readonly Item[], seed: number, ...keys: readonly (string | number)[]): Item {
  const index = Math.floor(unit(seed, ...keys) * items.length)
  return items[Math.min(index, items.length - 1)] as Item
}
