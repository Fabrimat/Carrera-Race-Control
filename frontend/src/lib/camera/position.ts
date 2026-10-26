// Output of webcam tracking: the measured position of a car on the lap.

/** A measured position is used by the live map only while younger than this. */
export const CAMERA_FRESH_MS = 500

export interface CameraPosition {
  s: number
  /** `performance.now()` of the frame it was measured on. */
  seen_at: number
  off_path: boolean
}

export function freshCameraS(pos: CameraPosition | undefined, now: number): number | null {
  if (!pos) return null
  const age = now - pos.seen_at
  return age >= 0 && age < CAMERA_FRESH_MS ? pos.s : null
}
