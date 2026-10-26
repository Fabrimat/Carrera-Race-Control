// Synthetic images for the camera unit tests.

import type { Frame } from './frame'

export function solidFrame(width: number, height: number, rgb: [number, number, number]): Frame {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]
    data[i * 4 + 1] = rgb[1]
    data[i * 4 + 2] = rgb[2]
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

export function fillDisc(f: Frame, cx: number, cy: number, r: number, rgb: [number, number, number]) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
      const i = (y * f.width + x) * 4
      f.data[i] = rgb[0]
      f.data[i + 1] = rgb[1]
      f.data[i + 2] = rgb[2]
    }
  }
}

export function fillRect(f: Frame, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * f.width + x) * 4
      f.data[i] = rgb[0]
      f.data[i + 1] = rgb[1]
      f.data[i + 2] = rgb[2]
    }
}
