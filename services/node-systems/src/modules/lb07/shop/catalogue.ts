// The staging shop's catalogue: six synthetic Basalt & Bean coffees, one coupon, and the prices in
// cents. It is data the shop renders and the planner is told about, so a goal such as "buy two bags
// of Ethiopia Guji with WELCOME10" names things that exist. Nothing here is real: the products, the
// prices and the coupon are made up for the demo.

/** One coffee on sale. */
export interface Product {
  // The slug in the product's path, such as /products/ethiopia-guji.
  slug: string
  name: string
  // The price of one bag, in euro cents.
  priceCents: number
  // One sentence for the product page.
  description: string
}

/** The six products, in the order the shop lists them. */
export const PRODUCTS: readonly Product[] = [
  { slug: 'ethiopia-guji', name: 'Ethiopia Guji', priceCents: 1_450, description: 'Washed, floral and bright, with a long peach finish.' },
  { slug: 'colombia-huila', name: 'Colombia Huila', priceCents: 1_290, description: 'Caramel and red apple, a steady everyday filter coffee.' },
  { slug: 'brazil-cerrado', name: 'Brazil Cerrado', priceCents: 1_090, description: 'Natural process, cocoa and hazelnut, made for milk drinks.' },
  { slug: 'house-espresso', name: 'House Espresso', priceCents: 1_190, description: 'Our blend for the bar: dark chocolate, low acidity, thick body.' },
  { slug: 'decaf-mexico', name: 'Decaf Mexico', priceCents: 1_350, description: 'Sugar-cane decaf, sweet and nutty, nothing missing but the caffeine.' },
  { slug: 'basalt-blend', name: 'Basalt Blend', priceCents: 1_250, description: 'The roastery\'s signature blend, balanced for any brewer.' },
]

/** The one coupon the shop knows, and what it takes off. */
export const COUPON = { code: 'WELCOME10', percentOff: 10 } as const

/** Finds a product by its slug, or undefined. */
export function productBySlug(slug: string): Product | undefined {
  return PRODUCTS.find(product => product.slug === slug)
}

/** Writes a price in cents as the shop shows it, such as `€14.50`. */
export function formatPrice(cents: number): string {
  const euros = Math.floor(cents / 100)
  const rest = Math.abs(cents % 100).toString().padStart(2, '0')
  return `€${euros}.${rest}`
}
