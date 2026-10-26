import { useEffect, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useT } from '../../i18n/useT'
import type { TFunction } from '../../i18n'
import type { CalibrationPair } from '../../lib/camera/calibration'
import { cameraEngine } from '../../lib/camera/engine'
import type { Frame } from '../../lib/camera/frame'
import { applyHomography, invertHomography, type Mat3 } from '../../lib/camera/homography'
import type { PathModel } from '../../lib/camera/projection'
import type { CarDetection } from '../../lib/camera/tracker'
import type { Pt } from '../../lib/geometry'

export interface ViewCar {
  address: number
  name: string
  color: string
}

interface Props {
  /** Layout path in display space, for the warped overlay. */
  path: PathModel | null
  /** Image fractions → display space; null while uncalibrated. */
  h: Mat3 | null
  pairs: CalibrationPair[]
  pendingImage: Pt | null
  frozen: boolean
  cars: ViewCar[]
  /** Click on the image, in frame fractions (0..1). */
  onPick: ((p: Pt) => void) | null
  label: string
}

interface Overlay {
  outline: Pt[] | null
  pairs: CalibrationPair[]
  pendingImage: Pt | null
  cars: ViewCar[]
  t: TFunction
}

const VIEW_W = 640

/** Picture (if any) + overlays: the warped layout, calibration points, car boxes. */
function paint(c: HTMLCanvasElement, picture: HTMLCanvasElement | null, dets: CarDetection[], p: Overlay) {
  const ctx = c.getContext('2d')
  if (!ctx) return
  const W = c.width
  const H = c.height
  ctx.fillStyle = '#0b0d10'
  ctx.fillRect(0, 0, W, H)
  if (picture) ctx.drawImage(picture, 0, 0, W, H)
  if (p.outline && p.outline.length > 1) {
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(255, 176, 0, 0.75)'
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    p.outline.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)))
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#e8ecef'
    ctx.beginPath()
    ctx.arc(p.outline[0][0] * W, p.outline[0][1] * H, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.font = 'bold 12px Bahnschrift, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  const marker = ([x, y]: Pt, text: string, color: string) => {
    ctx.fillStyle = color
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x * W, y * H, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#000'
    ctx.textAlign = 'center'
    ctx.fillText(text, x * W, y * H + 0.5)
  }
  p.pairs.forEach((pair, i) => marker(pair.image, String(i + 1), i === 0 ? '#e8ecef' : '#ffb000'))
  if (p.pendingImage) marker(p.pendingImage, String(p.pairs.length + 1), '#30d158')
  for (const d of dets) {
    const car = p.cars.find((x) => x.address === d.address)
    const [x0, y0, x1, y1] = d.box
    const pad = 3
    ctx.lineWidth = 2
    ctx.strokeStyle = d.accepted ? (car?.color ?? '#e8ecef') : '#8a96a3'
    ctx.setLineDash(d.accepted ? [] : [4, 3])
    ctx.strokeRect(x0 * W - pad, y0 * H - pad, (x1 - x0) * W + pad * 2, (y1 - y0) * H + pad * 2)
    ctx.setLineDash([])
    const text = `${car?.name ?? d.address + 1}${d.offPath ? ` · ${p.t('camera.off_path')}` : ''}`
    ctx.textAlign = 'left'
    const tw = ctx.measureText(text).width + 8
    ctx.fillStyle = 'rgba(11, 13, 16, 0.85)'
    ctx.fillRect(x0 * W - pad, y0 * H - pad - 17, tw, 16)
    ctx.fillStyle = d.accepted ? '#e8ecef' : '#8a96a3'
    ctx.fillText(text, x0 * W - pad + 4, y0 * H - pad - 9)
  }
}

/**
 * The live (or frozen) camera picture with overlays, redrawn on every processed frame and
 * whenever the overlay inputs change.
 */
export function CameraView({ path, h, pairs, pendingImage, frozen, cars, onPick, label }: Props) {
  const t = useT()
  const canvas = useRef<HTMLCanvasElement>(null)
  const picture = useRef<HTMLCanvasElement | null>(null)
  const hasPicture = useRef(false)
  const detections = useRef<CarDetection[]>([])

  // Display space → image fractions, for the outline of the layout.
  const outline = useMemo(() => {
    if (!h || !path) return null
    try {
      const inv = invertHomography(h)
      const pts = path.points.map((p) => applyHomography(inv, p))
      return pts.every((p) => p !== null) ? (pts as Pt[]) : null
    } catch {
      return null
    }
  }, [h, path])

  const overlay = useRef<Overlay>({ outline, pairs, pendingImage, cars, t })

  // Overlay changes (also while frozen).
  useLayoutEffect(() => {
    overlay.current = { outline, pairs, pendingImage, cars, t }
    if (canvas.current) paint(canvas.current, hasPicture.current ? picture.current : null, detections.current, overlay.current)
  }, [outline, pairs, pendingImage, cars, t])

  // New frames: copy the picture (unless frozen) and redraw.
  useEffect(() => {
    const onFrame = (frame: Frame, dets: CarDetection[]) => {
      const c = canvas.current
      if (frozen || !c) return
      const H = Math.round((VIEW_W * frame.height) / frame.width)
      if (c.height !== H) c.height = H
      picture.current ??= document.createElement('canvas')
      const s = picture.current
      const sctx = s.getContext('2d')
      if (!sctx) return
      const video = cameraEngine.videoElement()
      if (video && video.videoWidth) {
        // Webcam: a sharper preview straight from the video.
        if (s.width !== VIEW_W || s.height !== H) {
          s.width = VIEW_W
          s.height = H
        }
        sctx.drawImage(video, 0, 0, VIEW_W, H)
      } else if (typeof ImageData !== 'undefined') {
        if (s.width !== frame.width || s.height !== frame.height) {
          s.width = frame.width
          s.height = frame.height
        }
        sctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0)
      }
      hasPicture.current = true
      detections.current = dets
      paint(c, s, dets, overlay.current)
    }
    return cameraEngine.onFrame(onFrame)
  }, [frozen])

  const click = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!onPick) return
    const r = e.currentTarget.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    onPick([x, y])
  }

  return (
    <canvas
      ref={canvas}
      width={VIEW_W}
      height={480}
      onClick={click}
      aria-label={label}
      data-testid="camera-view"
      className={`block h-auto w-full rounded-md border border-line bg-track ${onPick ? 'cursor-crosshair' : ''}`}
    />
  )
}
