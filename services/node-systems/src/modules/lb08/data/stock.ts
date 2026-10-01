// The synthetic stock list the stock-check connector reads (data/seed/lb08/stock.yaml):
// Basalt & Bean's products, the kilograms in stock and how long a restock takes. The
// numbers are invented. `just node-seed` loads the file into the lb08 schema.
import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'

/** One product the roastery sells wholesale. */
const productSchema = z.strictObject({
  sku: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(40),
  name: z.string().min(1).max(60),
  availableKg: z.number().min(0).max(100_000),
  // Days until a restock arrives, which is how long an out-of-stock product waits.
  restockEtaDays: z.int().min(0).max(60),
})

/** The whole stock file. */
export const stockFileSchema = z.strictObject({
  products: z.array(productSchema).min(1).max(50),
}).refine(file => new Set(file.products.map(product => product.sku)).size === file.products.length, 'a product code appears twice')

/** One product in the stock list. */
export type StockProduct = z.infer<typeof productSchema>

/** Reads and checks the stock file in a seed directory. */
export function readStockFile(seedDirectory: string): StockProduct[] {
  return readDataFile(`${seedDirectory}/lb08/stock.yaml`, stockFileSchema).products
}
