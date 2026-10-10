// The screenshots the mock back end's LB-07 hands out as evidence: small synthetic PNGs drawn by code, a
// grey page with a header bar and a few blocks of "content" placed by a seed, so two screenshots of one
// run differ and every one is a valid PNG of a few hundred bytes. They stand in for what the real
// sandbox's Chromium captures; nobody should read them as a picture of the shop.
import { crc32, deflateSync } from 'node:zlib'

/** The size of every synthetic screenshot, in pixels: the proportions of a laptop's viewport, made small. */
export const SCREENSHOT_WIDTH = 160
export const SCREENSHOT_HEIGHT = 100

// The eight bytes every PNG file starts with.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/** One colour, as red, green and blue from 0 to 255. */
type Rgb = readonly [number, number, number]

const PAGE: Rgb = [246, 244, 240]
const HEADER: Rgb = [58, 64, 74]
const BLOCK: Rgb = [214, 210, 202]
const ACCENT: Rgb = [42, 111, 214]

/** Writes one chunk of a PNG: its length, its type, its data and the checksum of type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, checksum])
}

/** The header chunk's data: the size, eight bits a channel, truecolour, no interlacing. */
function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width, 0)
  data.writeUInt32BE(height, 4)
  data.writeUInt8(8, 8)
  data.writeUInt8(2, 9)
  return data
}

/** Picks the colour of one pixel of the page a seed draws: a header bar, then rows of blocks, one of them in the accent. */
function pixelOf(x: number, y: number, seed: number): Rgb {
  if (y < 12) return HEADER
  const row = Math.floor((y - 18) / 16)
  const inRow = y >= 18 && (y - 18) % 16 < 10
  if (!inRow || row > 4) return PAGE
  const width = 40 + ((seed * 37 + row * 23) % 90)
  if (x < 10 || x >= 10 + width) return PAGE
  return row === seed % 5 ? ACCENT : BLOCK
}

/** Draws the raw rows of the image, each led by the filter byte 0 (none). */
function rows(seed: number): Buffer {
  const stride = 1 + SCREENSHOT_WIDTH * 3
  const raw = Buffer.alloc(stride * SCREENSHOT_HEIGHT)
  for (let y = 0; y < SCREENSHOT_HEIGHT; y += 1) {
    for (let x = 0; x < SCREENSHOT_WIDTH; x += 1) {
      const [red, green, blue] = pixelOf(x, y, seed)
      const at = y * stride + 1 + x * 3
      raw[at] = red
      raw[at + 1] = green
      raw[at + 2] = blue
    }
  }
  return raw
}

/** Draws a synthetic screenshot as a PNG file; the same seed always makes the same bytes. */
export function syntheticScreenshot(seed: number): Buffer {
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header(SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT)),
    chunk('IDAT', deflateSync(rows(seed))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
