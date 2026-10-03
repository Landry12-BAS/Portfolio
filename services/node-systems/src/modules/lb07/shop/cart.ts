// The cart: what the visitor's browser holds between pages (a cookie the shop writes and reads), and
// the arithmetic of the totals, bugs included. The cart is a plain, bounded, Zod-checked JSON value;
// it is not signed, since the only thing a tampered cart can change is the agent's own cart in the
// agent's own throwaway browser. Two of the switchable bugs live here, as the arithmetic they bend:
// `coupon-twice` takes the discount off twice, and `cart-off-by-one` counts one item too many.
import type { Lb07BugId } from '@lb/contracts'
import { z } from 'zod'

import { COUPON, productBySlug } from './catalogue.ts'
import type { Product } from './catalogue.ts'

/** The cookie the cart travels in. */
export const CART_COOKIE = 'lb07_cart'
/** The most bags of one coffee a cart may hold. */
export const MAX_QUANTITY = 20

const cartSchema = z.strictObject({
  v: z.literal(1),
  items: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.int().min(1).max(MAX_QUANTITY)),
  coupon: z.string().regex(/^[A-Z0-9]{1,20}$/).nullable(),
})

/** A cart: how many bags of each slug, and the coupon code entered, valid or not. */
export type Cart = z.infer<typeof cartSchema>

/** An empty cart. */
export function emptyCart(): Cart {
  return { v: 1, items: {}, coupon: null }
}

/** Reads a cart cookie, or an empty cart for anything that is not a cart (unknown products are dropped). */
export function readCart(cookie: string | undefined): Cart {
  if (cookie === undefined || cookie.length > 2_048) return emptyCart()
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'))
  }
  catch {
    return emptyCart()
  }
  const parsed = cartSchema.safeParse(decoded)
  if (!parsed.success) return emptyCart()
  const items = Object.fromEntries(Object.entries(parsed.data.items).filter(([slug]) => productBySlug(slug) !== undefined))
  return { v: 1, items, coupon: parsed.data.coupon }
}

/** Writes a cart as its cookie value. */
export function writeCart(cart: Cart): string {
  return Buffer.from(JSON.stringify(cart)).toString('base64url')
}

/** Returns the cart with `quantity` more bags of a product (capped), or unchanged for an unknown product. */
export function addToCart(cart: Cart, slug: string, quantity: number): Cart {
  if (productBySlug(slug) === undefined) return cart
  const current = cart.items[slug] ?? 0
  return { ...cart, items: { ...cart.items, [slug]: Math.min(MAX_QUANTITY, current + Math.max(1, quantity)) } }
}

/** Returns the cart with a product at exactly `quantity` bags; zero removes it. */
export function setQuantity(cart: Cart, slug: string, quantity: number): Cart {
  if (productBySlug(slug) === undefined) return cart
  const items = Object.fromEntries(Object.entries(cart.items).filter(([key]) => key !== slug))
  if (quantity > 0) items[slug] = Math.min(MAX_QUANTITY, Math.floor(quantity))
  return { ...cart, items }
}

/** Returns the cart with a coupon code entered, as typed (uppercased); whether it is valid is the totals' business. */
export function applyCoupon(cart: Cart, code: string): Cart {
  // Only letters and digits are kept, so what the page echoes back is never markup and never a control character.
  const cleaned = code.toUpperCase().replaceAll(/[^A-Z0-9]/g, '').slice(0, 20)
  return { ...cart, coupon: cleaned === '' ? null : cleaned }
}

/** Tells whether the cart's coupon is the one the shop honours. */
export function couponValid(cart: Cart): boolean {
  return cart.coupon === COUPON.code
}

/** One line of the cart with its product and its line total. */
export interface CartLine {
  product: Product
  quantity: number
  lineCents: number
}

/** What the cart comes to. `shownItems` is the count the page prints, which the off-by-one bug bends; `items` is the truth. */
export interface Totals {
  lines: CartLine[]
  items: number
  shownItems: number
  subtotalCents: number
  discountCents: number
  totalCents: number
}

/** Works out the cart's lines and totals, with the switched-on bugs bending the arithmetic as each does. */
export function totalsOf(cart: Cart, bugs: readonly Lb07BugId[]): Totals {
  const lines: CartLine[] = []
  for (const [slug, quantity] of Object.entries(cart.items)) {
    const product = productBySlug(slug)
    if (product) lines.push({ product, quantity, lineCents: product.priceCents * quantity })
  }
  const items = lines.reduce((sum, line) => sum + line.quantity, 0)
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineCents, 0)
  const onceCents = couponValid(cart) ? Math.round(subtotalCents * COUPON.percentOff / 100) : 0
  // The bug: the discount is taken off twice.
  const discountCents = bugs.includes('coupon-twice') ? onceCents * 2 : onceCents
  // The bug: the count the page shows is one too many, whenever there is anything in the cart.
  const shownItems = bugs.includes('cart-off-by-one') && items > 0 ? items + 1 : items
  return { lines, items, shownItems, subtotalCents, discountCents, totalCents: Math.max(0, subtotalCents - discountCents) }
}
