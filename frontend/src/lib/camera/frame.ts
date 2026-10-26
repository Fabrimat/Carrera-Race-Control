// A camera frame: the structural subset of ImageData the pipeline needs (RGBA, row-major),
// so the pure code runs on real `ImageData` in the browser and on plain buffers in tests.

export interface Frame {
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}

/** Processing width of the downscaled frames (height follows the source aspect). */
export const PROCESS_WIDTH = 320

export function createFrame(width: number, height: number): Frame {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}
