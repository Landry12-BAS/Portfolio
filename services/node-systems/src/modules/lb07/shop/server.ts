// The staging shop's HTTP server: a plain node:http server with a handful of routes, a cart in a
// cookie, and the bugs switched on by a signed token (token.ts). It is one small process of its own
// (src/shop.ts), in a container of its own on the sandbox network, so the browser the agent drives can
// reach it and nothing else; it holds no database, no queue and no model, and the one secret it has is
// the key that verifies bug tokens. The `checkout-engine` bug lives here: when it is on, the checkout
// fails for a browser that is not Chromium, told apart by its user agent, since the sandbox installs
// only Chromium and a second engine is simulated by its user agent (README, "What is simulated").
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { Lb07BugId } from '@lb/contracts'

import { productBySlug } from './catalogue.ts'
import { addToCart, applyCoupon, CART_COOKIE, readCart, setQuantity, totalsOf, writeCart } from './cart.ts'
import type { Cart } from './cart.ts'
import { aboutPage, cartPage, checkoutFailedPage, checkoutPage, frontPage, imageSvg, notFoundPage, orderPage, productPage } from './pages.ts'
import type { CheckoutForm, Order } from './pages.ts'
import { BUG_COOKIE, checkTokenKey, verifyBugToken } from './token.ts'

/** What the shop is built with. */
export interface ShopOptions {
  // The key bug tokens are verified with; the service signs with the same one.
  tokenKey: Uint8Array
  now?: () => Date
}

// The most bytes a form may send.
const MAX_FORM_BYTES = 4_096
// How many placed orders the shop remembers (the oldest are forgotten first).
const MAX_ORDERS = 200

/** Tells whether a user agent is a browser other than Chromium: Firefox, or Safari that is not Chrome. */
export function isSecondEngine(userAgent: string | undefined): boolean {
  if (!userAgent) return false
  if (userAgent.includes('Firefox/')) return true
  return userAgent.includes('Safari/') && !/Chrom(?:e|ium)\//.test(userAgent)
}

/** Reads the cookies of a request into a map. */
function cookiesOf(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>()
  const header = request.headers.cookie
  if (!header || header.length > 8_192) return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  return cookies
}

/** Reads a small urlencoded form body, or undefined when it is too large or not a form. */
function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  return new Promise((resolve) => {
    const type = request.headers['content-type'] ?? ''
    if (!type.startsWith('application/x-www-form-urlencoded')) {
      request.resume()
      resolve(undefined)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        request.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    request.on('error', () => resolve(undefined))
  })
}

/** Writes an HTML page with the shop's headers. */
function sendPage(response: ServerResponse, status: number, body: string, cart?: Cart): void {
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  if (cart) headers['set-cookie'] = `${CART_COOKIE}=${writeCart(cart)}; Path=/; HttpOnly; SameSite=Lax`
  response.writeHead(status, headers)
  response.end(body)
}

/** Redirects after a form, saving the cart. */
function redirect(response: ServerResponse, location: string, cart: Cart): void {
  response.writeHead(303, { 'location': location, 'cache-control': 'no-store', 'set-cookie': `${CART_COOKIE}=${writeCart(cart)}; Path=/; HttpOnly; SameSite=Lax` })
  response.end()
}

/** Makes an order number from what was ordered, so the same cart at the same moment gives the same number. */
function orderNumber(cart: Cart, moment: Date): string {
  const digest = createHash('sha256').update(JSON.stringify(cart)).update(String(moment.getTime())).digest('hex')
  return `bb-${Number.parseInt(digest.slice(0, 6), 16).toString().padStart(7, '0').slice(0, 7)}`
}

/** Reads one field of a form as plain, bounded text. */
function field(form: URLSearchParams, name: string, max: number): string {
  return (form.get(name) ?? '').trim().slice(0, max)
}

/** The shop: builds the server. */
export function createShopServer(options: ShopOptions): Server {
  const key = checkTokenKey(options.tokenKey)
  const now = options.now ?? (() => new Date())
  const orders = new Map<string, Order>()

  /** Remembers an order, forgetting the oldest past the limit. */
  const remember = (order: Order): void => {
    orders.set(order.number, order)
    if (orders.size > MAX_ORDERS) {
      const oldest = orders.keys().next().value
      if (oldest !== undefined) orders.delete(oldest)
    }
  }

  /** Answers one request. */
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://shop.invalid')
    const path = url.pathname
    const cookies = cookiesOf(request)
    const claims = verifyBugToken(key, cookies.get(BUG_COOKIE), now())
    const bugs: readonly Lb07BugId[] = claims?.bugs ?? []
    let cart = readCart(cookies.get(CART_COOKIE))
    const totals = () => totalsOf(cart, bugs)
    const method = request.method ?? 'GET'

    if (method === 'GET' || method === 'HEAD') {
      if (path === '/') return sendPage(response, 200, frontPage(totals(), bugs))
      if (path === '/cart') return sendPage(response, 200, cartPage(cart, totals()))
      if (path === '/checkout') return sendPage(response, 200, checkoutPage(cart, totals(), bugs))
      if (path === '/about') return sendPage(response, 200, aboutPage(totals()))
      const product = /^\/products\/([a-z0-9-]{1,40})$/.exec(path)
      if (product) {
        const found = productBySlug(product[1] ?? '')
        return found ? sendPage(response, 200, productPage(found, totals(), bugs)) : sendPage(response, 404, notFoundPage(totals()))
      }
      const image = /^\/images\/([a-z0-9-]{1,40})\.svg$/.exec(path)
      if (image) {
        const svg = imageSvg(image[1] ?? '')
        if (svg === undefined) return sendPage(response, 404, notFoundPage(totals()))
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        response.end(svg)
        return
      }
      const order = /^\/orders\/(bb-\d{1,7})$/.exec(path)
      if (order) {
        const found = orders.get(order[1] ?? '')
        return found ? sendPage(response, 200, orderPage(found, totals())) : sendPage(response, 404, notFoundPage(totals()))
      }
      return sendPage(response, 404, notFoundPage(totals()))
    }

    if (method === 'POST') {
      const form = await readForm(request)
      if (!form) return sendPage(response, 400, notFoundPage(totals()))
      if (path === '/cart/add') {
        cart = addToCart(cart, field(form, 'slug', 40), 1)
        return redirect(response, '/cart', cart)
      }
      if (path === '/cart/update') {
        for (const [name, value] of form) {
          if (!name.startsWith('qty-')) continue
          const quantity = Number(value)
          if (Number.isFinite(quantity)) cart = setQuantity(cart, name.slice(4), quantity)
        }
        return redirect(response, '/cart', cart)
      }
      if (path === '/cart/remove') {
        cart = setQuantity(cart, field(form, 'slug', 40), 0)
        return redirect(response, '/cart', cart)
      }
      if (path === '/cart/coupon') {
        cart = applyCoupon(cart, field(form, 'code', 40))
        return redirect(response, '/cart', cart)
      }
      if (path === '/checkout') {
        const filled: CheckoutForm = { name: field(form, 'name', 80), email: field(form, 'email', 120), street: field(form, 'street', 120), city: field(form, 'city', 80) }
        const current = totals()
        if (current.lines.length === 0) return redirect(response, '/cart', cart)
        if (Object.values(filled).some(value => value === '')) return sendPage(response, 400, checkoutPage(cart, current, bugs, 'Please fill in every field.'))
        // The bug: in a browser that is not Chromium, the checkout fails.
        if (bugs.includes('checkout-engine') && isSecondEngine(request.headers['user-agent'])) return sendPage(response, 500, checkoutFailedPage(current))
        const order: Order = { number: orderNumber(cart, now()), totalCents: current.totalCents, items: current.shownItems }
        remember(order)
        return redirect(response, `/orders/${order.number}`, { v: 1, items: {}, coupon: null })
      }
      return sendPage(response, 404, notFoundPage(totals()))
    }

    response.writeHead(405, { 'allow': 'GET, HEAD, POST', 'cache-control': 'no-store' })
    response.end()
  }

  return createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
      response.end()
    })
  })
}
