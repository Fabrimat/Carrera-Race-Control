// Client-side photo preparation for "track from photo": downscale and re-encode to JPEG in
// the browser (this also strips EXIF/GPS metadata) before anything is sent to the backend.

export const MAX_SIDE = 1600
export const MAX_BYTES = 8 * 1024 * 1024
const QUALITIES = [0.85, 0.7, 0.5]

/** Size that fits within `max` on the longest side, never upscaling. */
export function fitSize(w: number, h: number, max = MAX_SIDE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** Decoded size of a base64 payload in bytes. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

export class PhotoError extends Error {
  code: 'invalid_image' | 'image_too_large'
  constructor(code: PhotoError['code']) {
    super(code)
    this.name = 'PhotoError'
    this.code = code
  }
}

export interface PreparedPhoto {
  base64: string
  dataUrl: string
  width: number
  height: number
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new PhotoError('invalid_image'))
    }
    img.src = url
  })
}

/** Downscale to <= 1600 px (longest side) and re-encode as JPEG under 8 MB. */
export async function prepareImage(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) throw new PhotoError('invalid_image')
  const img = await loadImage(file)
  const { width, height } = fitSize(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoError('invalid_image')
  ctx.drawImage(img, 0, 0, width, height)
  for (const q of QUALITIES) {
    const dataUrl = canvas.toDataURL('image/jpeg', q)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (base64Bytes(base64) < MAX_BYTES) return { base64, dataUrl, width, height }
  }
  throw new PhotoError('image_too_large')
}
