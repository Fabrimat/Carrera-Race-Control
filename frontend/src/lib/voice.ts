// Browser audio recording for the "say the name" shortcut.

export const MAX_RECORD_S = 10

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']

/** First recording format this browser supports, or null when it cannot record. */
export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const supported = (m: string) =>
    typeof MediaRecorder.isTypeSupported === 'function' ? MediaRecorder.isTypeSupported(m) : false
  return CANDIDATES.find(supported) ?? null
}

/** `audio/webm;codecs=opus` -> `audio/webm` (the API takes the bare media type). */
export function bareMime(mime: string): string {
  return mime.split(';')[0].trim()
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
