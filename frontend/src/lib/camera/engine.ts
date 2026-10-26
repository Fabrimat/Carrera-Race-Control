// The webcam tracking loop of the browser (one per app window). It owns the source (a
// webcam via getUserMedia, or the simulated camera), runs the Tracker at up to 15 fps on
// downscaled frames and publishes accepted positions to the store slice `camera`, which
// the live map uses. It lives outside React so it can keep running in the background when
// the camera page is closed (if the user asks for it). Video never leaves the browser.

import { raceClockNow } from '../../components/TrackMap'
import { estimateS } from '../geometry'
import { useStore } from '../store'
import type { TrackLayout } from '../types'
import { BACKGROUND_KEY, loadSignatures, saveSignatures, type Signatures } from './calibration'
import { createFrame, PROCESS_WIDTH, type Frame } from './frame'
import type { Mat3 } from './homography'
import type { CameraPosition } from './position'
import { pathModel, type PathModel } from './projection'
import { sampleSignature } from './signature'
import { createSimScene, renderSimFrame, SIM_FPS, type SimCar, type SimScene } from './simCamera'
import { Tracker, type CarDetection, type CarStats } from './tracker'

export type SourceKind = 'webcam' | 'sim'
export type EngineError = 'denied' | 'unavailable' | 'unsupported'

export interface EngineSnapshot {
  running: boolean
  starting: boolean
  source: SourceKind | null
  error: EngineError | null
  /** Processed frames per second (smoothed). */
  fps: number
  /** Keep tracking when the camera page is closed. */
  background: boolean
  layout: string | null
  calibrated: boolean
  signatures: Signatures
  stats: Record<number, CarStats>
  /** `performance.now()` when `stats` were taken (for "last seen … ago"). */
  statsAt: number
}

export type FrameListener = (frame: Frame, detections: CarDetection[]) => void

const FRAME_MS = 1000 / SIM_FPS
const STATS_EVERY_MS = 250

function loadBackground(): boolean {
  try {
    return globalThis.localStorage?.getItem(BACKGROUND_KEY) === '1'
  } catch {
    return false
  }
}

export class CameraEngine {
  private snap: EngineSnapshot = {
    running: false,
    starting: false,
    source: null,
    error: null,
    fps: 0,
    background: loadBackground(),
    layout: null,
    calibrated: false,
    signatures: loadSignatures(),
    stats: {},
    statsAt: 0,
  }
  private subs = new Set<() => void>()
  private frameSubs = new Set<FrameListener>()
  private tracker = new Tracker()
  private timer: ReturnType<typeof setTimeout> | null = null
  private session = 0
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private work: CanvasRenderingContext2D | null = null
  private scene: SimScene | null = null
  private simFrame: Frame | null = null
  private layout: TrackLayout | null = null
  private path: PathModel | null = null
  private h: Mat3 | null = null
  private frame: Frame | null = null
  private lastTick = 0
  private fps = 0
  private lastStats = 0
  private raceAt = 0
  private unsubStore: (() => void) | null = null

  constructor() {
    this.tracker.setCars(this.carList())
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  getSnapshot = () => this.snap

  /** Called on every processed frame (the frame buffer is reused: copy it right away). */
  onFrame(fn: FrameListener): () => void {
    this.frameSubs.add(fn)
    return () => {
      this.frameSubs.delete(fn)
    }
  }

  private emit(patch: Partial<EngineSnapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.subs.forEach((f) => f())
  }

  /** The latest processed (downscaled) frame. */
  latestFrame(): Frame | null {
    return this.frame
  }

  /** The live video element for a sharper preview (webcam only). */
  videoElement(): HTMLVideoElement | null {
    return this.video
  }

  async start(kind: SourceKind, deviceId: string | null = null): Promise<void> {
    this.stop()
    const session = this.session
    this.emit({ starting: true, error: null, source: kind })
    if (kind === 'webcam') {
      const md = globalThis.navigator?.mediaDevices
      if (!md?.getUserMedia) {
        this.emit({ starting: false, source: null, error: 'unsupported' })
        return
      }
      let stream: MediaStream
      try {
        stream = await md.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 } },
          audio: false,
        })
      } catch (e) {
        if (session !== this.session) return
        const denied = (e as { name?: string } | null)?.name === 'NotAllowedError'
        this.emit({ starting: false, source: null, error: denied ? 'denied' : 'unavailable' })
        return
      }
      if (session !== this.session) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      await video.play().catch(() => undefined)
      if (session !== this.session) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.stream = stream
      this.video = video
      this.work = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    }
    this.tracker.reset()
    this.raceAt = performance.now()
    this.unsubStore = useStore.subscribe((s, prev) => {
      if (s.race !== prev.race) this.raceAt = performance.now()
    })
    this.lastTick = 0
    this.fps = 0
    this.emit({ running: true, starting: false })
    this.schedule()
  }

  stop(): void {
    this.session++
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.video) this.video.srcObject = null
    this.video = null
    this.work = null
    this.frame = null
    this.unsubStore?.()
    this.unsubStore = null
    useStore.getState().clearCamera()
    if (this.snap.running || this.snap.starting || this.snap.source)
      this.emit({ running: false, starting: false, source: null, fps: 0 })
  }

  setBackground(on: boolean): void {
    try {
      globalThis.localStorage?.setItem(BACKGROUND_KEY, on ? '1' : '0')
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    this.emit({ background: on })
  }

  /** The layout the calibration belongs to (also what the simulated camera films). */
  setLayout(layout: TrackLayout | null): void {
    if (layout === this.layout) return
    this.layout = layout
    this.path = layout ? pathModel(layout) : null
    this.scene = layout ? createSimScene(layout) : null
    this.simFrame = this.scene ? createFrame(this.scene.width, this.scene.height) : null
    this.h = null
    this.tracker.setCalibration(null, this.path)
    this.tracker.reset()
    this.emit({ layout: layout?.name ?? null, calibrated: false })
  }

  /** Homography from frame fractions to the layout's display space (null = uncalibrated). */
  setCalibration(h: Mat3 | null): void {
    this.h = h
    this.tracker.setCalibration(h, this.path)
    this.emit({ calibrated: h !== null })
  }

  /** Samples the colour around a point of the latest frame (fractions) as a car's signature. */
  captureSignature(address: number, fx: number, fy: number): boolean {
    const f = this.frame
    if (!f) return false
    const sig = sampleSignature(f, fx * f.width, fy * f.height, Math.max(4, f.width * 0.025))
    if (!sig) return false
    this.setSignatures({ ...this.snap.signatures, [address]: sig })
    return true
  }

  removeSignature(address: number): void {
    const next = { ...this.snap.signatures }
    delete next[address]
    this.setSignatures(next)
  }

  private setSignatures(s: Signatures) {
    saveSignatures(s)
    this.snap = { ...this.snap, signatures: s }
    this.tracker.setCars(this.carList())
    this.emit({})
  }

  private carList() {
    return Object.entries(this.snap.signatures)
      .map(([a, signature]) => ({ address: Number(a), signature }))
      .sort((a, b) => a.address - b.address)
  }

  private schedule() {
    const session = this.session
    const begin = performance.now()
    this.timer = setTimeout(
      () => {
        if (session !== this.session) return
        this.tick(performance.now())
        this.schedule()
      },
      Math.max(0, FRAME_MS - (performance.now() - begin)),
    )
  }

  /** One processing step (exported for tests; the loop calls it at up to 15 fps). */
  tick(now: number): void {
    const frame = this.grab(now)
    if (!frame) return
    this.frame = frame
    const detections = this.tracker.process(frame, now)
    this.publish(detections, now)
    if (this.lastTick > 0 && now > this.lastTick) {
      const inst = 1000 / (now - this.lastTick)
      this.fps = this.fps ? this.fps * 0.85 + inst * 0.15 : inst
    }
    this.lastTick = now
    this.frameSubs.forEach((f) => f(frame, detections))
    if (now - this.lastStats >= STATS_EVERY_MS) {
      this.lastStats = now
      const stats: Record<number, CarStats> = {}
      for (const a of Object.keys(this.snap.signatures)) {
        const s = this.tracker.stats(Number(a))
        if (s) stats[Number(a)] = s
      }
      this.emit({ stats, statsAt: now, fps: this.fps })
    }
  }

  private publish(detections: CarDetection[], now: number) {
    if (!this.h || !this.layout || useStore.getState().race.layout !== this.layout.name) return
    const updates: Record<number, CameraPosition> = {}
    let any = false
    for (const d of detections) {
      if (!d.accepted || d.s === null) continue
      updates[d.address] = { s: d.s, seen_at: now, off_path: d.offPath }
      any = true
    }
    if (any) useStore.getState().setCameraPositions(updates)
  }

  private grab(now: number): Frame | null {
    if (this.snap.source === 'sim') {
      if (!this.scene || !this.simFrame) return null
      renderSimFrame(this.scene, this.simCars(now), this.simFrame)
      return this.simFrame
    }
    const v = this.video
    const ctx = this.work
    if (!v || !ctx || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null
    const w = PROCESS_WIDTH
    const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth))
    if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
      ctx.canvas.width = w
      ctx.canvas.height = h
    }
    ctx.drawImage(v, 0, 0, w, h)
    return ctx.getImageData(0, 0, w, h)
  }

  /** Cars for the simulated camera: the same estimated positions the live map shows. */
  private simCars(now: number): SimCar[] {
    const race = useStore.getState().race
    const raceNow = raceClockNow(race, this.raceAt, now)
    const pitS = this.layout?.pit_s ?? null
    return race.cars.map((c, i) => {
      if (c.incident && c.incident.s !== null) return { address: c.address, color: c.color, s: c.incident.s, offTrack: true }
      if (c.track_pos) return { address: c.address, color: c.color, s: estimateS(c.track_pos, raceNow, pitS) }
      // No position yet: parked on the grid just before the line.
      return { address: c.address, color: c.color, s: 1 - 0.03 * (i + 1) }
    })
  }
}

export const cameraEngine = new CameraEngine()
