// Generates build/icon.png and build/icon.ico without dependencies (zlib + hand-written PNG).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopDir } from './lib.mjs'

const N = 256
const px = Buffer.alloc(N * N * 4)

function set(x, y, r, g, b, a = 255) {
  const i = (y * N + x) * 4
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const dx = x - N / 2 + 0.5
    const dy = y - N / 2 + 0.5
    // rounded square background
    const half = N / 2 - 6
    const rad = 48
    const qx = Math.max(Math.abs(dx) - (half - rad), 0)
    const qy = Math.max(Math.abs(dy) - (half - rad), 0)
    if (Math.hypot(qx, qy) > rad) { set(x, y, 0, 0, 0, 0); continue }
    set(x, y, 17, 20, 25)
    // race track ring (oval) in red with a white centre line
    const e = Math.hypot(dx / 96, dy / 60)
    if (e > 0.8 && e < 1.2) set(x, y, 229, 50, 45)
    if (e > 0.97 && e < 1.03 && (Math.floor((x + y) / 12) % 2 === 0)) set(x, y, 255, 255, 255)
    // chequered flag block, bottom right
    if (x > 150 && x < 226 && y > 160 && y < 220) {
      const c = (Math.floor((x - 150) / 19) + Math.floor((y - 160) / 15)) % 2 === 0
      set(x, y, c ? 255 : 30, c ? 255 : 30, c ? 255 : 30)
    }
  }
}

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6
const raw = Buffer.alloc((N * 4 + 1) * N)
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

// ICO with one PNG-compressed 256x256 image
const header = Buffer.alloc(22)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
header[6] = 0; header[7] = 0 // 0 means 256
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)

const out = join(desktopDir, 'build')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png)
writeFileSync(join(out, 'icon.ico'), Buffer.concat([header, png]))
console.log('wrote build/icon.png and build/icon.ico')
