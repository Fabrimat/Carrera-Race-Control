// Brand logo library cache (docs/PROTOCOL.md "Roadmap wave 1" -> "Logos"). Cars point at a
// logo with `logo_id`; the leaderboard, TV tower and race history look the logo up here to get
// its name (the image alt text) and version (cache busting). Loaded lazily, refreshed on edits.
import { create } from 'zustand'
import { api } from './api'
import type { Logo } from './types'

/** Backend limit: decoded image size. */
export const MAX_LOGO_BYTES = 512 * 1024
export const MAX_LOGO_NAME = 40
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,.svg'
const RELOAD_AFTER_MS = 5000

interface LogosState {
  logos: Logo[]
  loaded: boolean
  set: (logos: Logo[]) => void
}

export const useLogos = create<LogosState>((set) => ({
  logos: [],
  loaded: false,
  set: (logos) => set({ logos, loaded: true }),
}))

let inflight: Promise<void> | null = null
let lastAttempt = 0

/** Fetch the library (a failure leaves the cache as it was: logos simply do not show). */
export function loadLogos(): Promise<void> {
  if (inflight) return inflight
  lastAttempt = Date.now()
  inflight = api
    .logos()
    .then((r) => useLogos.getState().set(r.logos))
    .catch(() => undefined)
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Load the library when it is unknown or lacks `id` (throttled, so a deleted id costs nothing). */
export function ensureLogo(id: string): void {
  const { logos, loaded } = useLogos.getState()
  if (loaded && logos.some((l) => l.id === id)) return
  if (inflight || Date.now() - lastAttempt < RELOAD_AFTER_MS) return
  void loadLogos()
}

export function setLogos(logos: Logo[]): void {
  useLogos.getState().set(logos)
}

export type LogoFileProblem = 'invalid_image' | 'image_too_large'

/** Client-side checks before upload; null = fine. The backend checks again. */
export function checkLogoFile(file: Pick<File, 'type' | 'size' | 'name'>): LogoFileProblem | null {
  const okType = /^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type) || (file.type === '' && /\.svg$/i.test(file.name))
  if (!okType) return 'invalid_image'
  if (file.size > MAX_LOGO_BYTES) return 'image_too_large'
  return null
}

/** Base64 payload (no data-URL prefix) of a file. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result)
      resolve(text.slice(text.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** A name for a new logo from a file name: "ferrari-logo.png" -> "ferrari-logo". */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, MAX_LOGO_NAME) || 'Logo'
}
