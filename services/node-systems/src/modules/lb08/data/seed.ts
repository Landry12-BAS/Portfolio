// Loading LB-08's synthetic data into its schema. Today that is the stock list the
// stock-check connector reads. Loading is a reseed: the table ends up exactly as the file
// says, so running it again (the nightly reseed does) puts the shelves back as they were
// whatever happened to them in between.
import { notInArray, sql } from 'drizzle-orm'

import type { Lb08Db } from '../db/connection.ts'
import { stockLevels } from '../db/schema.ts'
import type { StockProduct } from './stock.ts'

/** Makes the stock table match the products given: adds new ones, resets the others and removes any the file no longer lists. Returns how many products it holds. */
export async function seedStock(db: Lb08Db, products: readonly StockProduct[]): Promise<number> {
  await db.transaction(async (tx) => {
    await tx.insert(stockLevels)
      .values(products.map(product => ({ sku: product.sku, name: product.name, availableKg: product.availableKg, restockEtaDays: product.restockEtaDays })))
      .onConflictDoUpdate({
        target: stockLevels.sku,
        set: { name: sql`excluded.name`, availableKg: sql`excluded.available_kg`, restockEtaDays: sql`excluded.restock_eta_days` },
      })
    await tx.delete(stockLevels).where(notInArray(stockLevels.sku, products.map(product => product.sku)))
  })
  return products.length
}
