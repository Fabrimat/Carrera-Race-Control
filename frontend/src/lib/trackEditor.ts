// Pure editing logic for the track editor: the document model, Catmull-Rom curve through the
// control points, freehand stroke conversion, annotations and undo/redo history.
// The document works in DISPLAY space (x scaled by `aspect`, y in 0..1) so that every
// arc-length fraction `s` matches the contract; layouts store points normalised 0..1 per axis.

import {
  cumulative,
  fromDisplay,
  nearestS,
  normalise,
  pointAt,
  resample,
  reverse,
  rotateStart,
  smooth,
  toDisplay,
  type Pt,
} from './geometry'
import type { LayoutSensor, TrackLayout } from './types'

export const PATH_POINTS = 150 // resolution of the saved centre line
export const HANDLE_COUNT = 24
export const MIN_HANDLES = 4
export const MIN_SENSOR_GAP = 0.01 // backend rule: distinct sensors and the line differ by >= 1%
export const MIN_LENGTH = 0.5 // backend rule: total path length in normalised units
export const MAX_NAME = 40

export interface EditorDoc {
  /** Editable control points in driving order; the curve passes through them. */
  handles: Pt[]
  /** Dense closed centre line; path[0] is the start/finish line. Empty = nothing drawn yet. */
  path: Pt[]
  aspect: number
  sensors: LayoutSensor[]
  pitS: number | null
}

export function emptyDoc(aspect = 4 / 3): EditorDoc {
  return { handles: [], path: [], aspect, sensors: [], pitS: null }
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1])
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const wrap = (s: number) => ((s % 1) + 1) % 1

/** Closed centripetal Catmull-Rom spline THROUGH `pts` (no overshoot, no cusps). */
export function catmullRom(pts: Pt[], samples = 12): Pt[] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const out: Pt[] = []
  const knot = (a: Pt, b: Pt) => Math.max(Math.sqrt(dist(a, b)), 1e-6)
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const t0 = 0
    const t1 = t0 + knot(p0, p1)
    const t2 = t1 + knot(p1, p2)
    const t3 = t2 + knot(p2, p3)
    for (let k = 0; k < samples; k++) {
      const t = t1 + ((t2 - t1) * k) / samples
      const mix = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const wa = (tb - t) / (tb - ta)
        const wb = (t - ta) / (tb - ta)
        return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb]
      }
      const a1 = mix(p0, p1, t0, t1)
      const a2 = mix(p1, p2, t1, t2)
      const a3 = mix(p2, p3, t2, t3)
      out.push(mix(mix(a1, a2, t0, t2), mix(a2, a3, t1, t3), t1, t3))
    }
  }
  return out
}

function buildPath(handles: Pt[]): Pt[] {
  return resample(catmullRom(handles), PATH_POINTS)
}

/** Positions of the annotations on the current path, so they can be re-attached to a new one. */
function anchors(doc: EditorDoc) {
  return {
    sensors: doc.sensors.map((x) => ({ sensor: x.sensor, p: pointAt(doc.path, x.s) })),
    pit: doc.pitS === null ? null : pointAt(doc.path, doc.pitS),
  }
}

function reattach(doc: EditorDoc, path: Pt[], a: ReturnType<typeof anchors>): EditorDoc {
  return {
    ...doc,
    path,
    sensors: a.sensors.map((x) => ({ sensor: x.sensor, s: nearestS(path, x.p) })).sort((x, y) => x.sensor - y.sensor),
    pitS: a.pit === null ? null : nearestS(path, a.pit),
  }
}

/** Build a document from a dense closed path (handles resampled from it, start = path[0]). */
export function docFromPath(
  path: Pt[],
  aspect: number,
  sensors: LayoutSensor[] = [],
  pitS: number | null = null,
): EditorDoc {
  if (path.length < 3) return emptyDoc(aspect)
  const handles = resample(path, HANDLE_COUNT)
  return { handles, path: buildPath(handles), aspect, sensors, pitS }
}

export { fromDisplay, toDisplay }

export function docFromLayout(l: TrackLayout): EditorDoc {
  return docFromPath(toDisplay(l.points, l.aspect), l.aspect, l.sensors, l.pit_s)
}

/** Resize the drawing area: the drawing keeps its layout fractions (stretches with the frame). */
export function setAspect(doc: EditorDoc, aspect: number): EditorDoc {
  if (doc.path.length === 0) return { ...doc, aspect }
  const k = aspect / doc.aspect
  const sc = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x * k, y])
  return reattach({ ...doc, handles: sc(doc.handles), aspect }, sc(doc.path), anchors(doc))
}

/**
 * Freehand stroke -> closed, smoothed, resampled document. Returns null when the stroke is
 * too short to be a track. The loop is closed automatically (last point joins the first).
 * Annotations of `prev` are kept by position on the new path.
 */
export function docFromStroke(raw: Pt[], aspect: number, prev?: EditorDoc): EditorDoc | null {
  const pts: Pt[] = []
  for (const p of raw) if (pts.length === 0 || dist(pts[pts.length - 1], p) > 0.002) pts.push(p)
  if (pts.length < 8 || cumulative(pts)[pts.length] < 0.4) return null
  const doc = docFromPath(smooth(resample(pts, 64), 2), aspect)
  if (prev && prev.path.length > 0) return reattach(doc, doc.path, anchors(prev))
  return doc
}

/** Replace the control points, keeping the start line and annotations where they were. */
export function withHandles(doc: EditorDoc, handles: Pt[]): EditorDoc {
  if (handles.length < MIN_HANDLES) return doc
  const a = anchors(doc)
  let path = buildPath(handles)
  path = rotateStart(path, nearestS(path, doc.path[0]))
  return reattach({ ...doc, handles }, path, a)
}

export function moveHandle(doc: EditorDoc, i: number, p: Pt): EditorDoc {
  if (i < 0 || i >= doc.handles.length) return doc
  const handles = doc.handles.slice()
  handles[i] = [Math.min(doc.aspect, Math.max(0, p[0])), clamp01(p[1])]
  return withHandles(doc, handles)
}

/** Insert a control point at the curve position closest to p; returns the doc and new index. */
export function insertHandle(doc: EditorDoc, p: Pt): { doc: EditorDoc; index: number } {
  if (doc.path.length === 0) return { doc, index: -1 }
  const q = pointAt(doc.path, nearestS(doc.path, p))
  const h = doc.handles
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < h.length; i++) {
    const a = h[i]
    const b = h[(i + 1) % h.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0
    const d = dist(q, [a[0] + dx * t, a[1] + dy * t])
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  const handles = [...h.slice(0, best + 1), q, ...h.slice(best + 1)]
  return { doc: withHandles(doc, handles), index: best + 1 }
}

/** Insert a point midway between handle i and the next one. */
export function insertAfter(doc: EditorDoc, i: number): { doc: EditorDoc; index: number } {
  const h = doc.handles
  if (i < 0 || i >= h.length) return { doc, index: -1 }
  const a = h[i]
  const b = h[(i + 1) % h.length]
  return insertHandle(doc, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
}

export function removeHandle(doc: EditorDoc, i: number): EditorDoc {
  if (doc.handles.length <= MIN_HANDLES || i < 0 || i >= doc.handles.length) return doc
  return withHandles(
    doc,
    doc.handles.filter((_, k) => k !== i),
  )
}

/** Move the start/finish line to the point of the path closest to p. */
export function moveStart(doc: EditorDoc, p: Pt): EditorDoc {
  if (doc.path.length === 0) return doc
  const a = anchors(doc)
  const path = rotateStart(doc.path, nearestS(doc.path, p))
  return reattach(doc, path, a)
}

/** Reverse the driving direction; the start/finish line stays put. */
export function reverseDoc(doc: EditorDoc): EditorDoc {
  if (doc.path.length === 0) return doc
  const a = anchors(doc)
  return reattach({ ...doc, handles: doc.handles.slice().reverse() }, reverse(doc.path), a)
}

const sensorOk = (sensors: LayoutSensor[], sensor: number, s: number) =>
  s >= MIN_SENSOR_GAP &&
  s <= 1 - MIN_SENSOR_GAP &&
  sensors.every((x) => x.sensor === sensor || Math.abs(x.s - s) >= MIN_SENSOR_GAP)

const sortSensors = (list: LayoutSensor[]) => list.slice().sort((a, b) => a.sensor - b.sensor)

/** Place Check Lane `sensor` (2 or 3) at the path point nearest to p (nearestS). */
export function moveSensor(doc: EditorDoc, sensor: number, p: Pt): EditorDoc {
  if (doc.path.length === 0) return doc
  const s = nearestS(doc.path, p)
  if (!sensorOk(doc.sensors, sensor, s)) return doc
  return { ...doc, sensors: sortSensors([...doc.sensors.filter((x) => x.sensor !== sensor), { sensor, s }]) }
}

/** Add Check Lane `sensor` at a sensible default position that respects the gap rule. */
export function addSensor(doc: EditorDoc, sensor: number): EditorDoc {
  if (doc.path.length === 0 || doc.sensors.some((x) => x.sensor === sensor)) return doc
  const base = sensor === 2 ? 1 / 3 : 2 / 3
  for (let k = 0; k < 40; k++) {
    const s = base + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.02
    if (sensorOk(doc.sensors, sensor, s)) return { ...doc, sensors: sortSensors([...doc.sensors, { sensor, s }]) }
  }
  return doc
}

export const removeSensor = (doc: EditorDoc, sensor: number): EditorDoc => ({
  ...doc,
  sensors: doc.sensors.filter((x) => x.sensor !== sensor),
})

export function movePit(doc: EditorDoc, p: Pt): EditorDoc {
  return doc.path.length === 0 ? doc : { ...doc, pitS: nearestS(doc.path, p) }
}
export const setPit = (doc: EditorDoc, on: boolean): EditorDoc =>
  doc.path.length === 0 ? doc : { ...doc, pitS: on ? (doc.pitS ?? 0.5) : null }

/** `s` moved by a signed fraction of the lap (keyboard nudging of annotations). */
export const shiftS = (s: number, delta: number) => wrap(s + delta)

/** Validation mirroring the backend (settings_invalid): non-null means "cannot save". */
export function validateDoc(doc: EditorDoc, name: string): 'name' | 'path' | null {
  const n = name.trim()
  if (n.length < 1 || n.length > MAX_NAME) return 'name'
  if (doc.path.length < 3 || cumulative(doc.path)[doc.path.length] <= MIN_LENGTH) return 'path'
  return null
}

/**
 * Document -> layout to save. With `fit` (photo drafts, image-fraction coordinates) the
 * drawing is fitted to its own bounding box, proportions kept through `aspect`.
 */
export function toLayout(doc: EditorDoc, name: string, source: TrackLayout['source'], fit: boolean): TrackLayout {
  let points: Pt[]
  let aspect = doc.aspect
  if (fit && doc.path.length > 0) {
    // Uniform scale in display space, so every arc-length fraction s is preserved.
    const fitted = normalise(doc.path)
    points = fitted.points
    aspect = fitted.aspect
  } else {
    points = fromDisplay(doc.path, doc.aspect)
  }
  return {
    name: name.trim(),
    points,
    aspect: Number(aspect.toFixed(4)),
    sensors: doc.sensors,
    pit_s: doc.pitS,
    source,
    updated_at: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ undo / redo

export interface History {
  past: EditorDoc[]
  present: EditorDoc
  future: EditorDoc[]
}
const LIMIT = 100

export const newHistory = (present: EditorDoc): History => ({ past: [], present, future: [] })
/** Push the current document to the undo stack (call once before a change or a drag). */
export const checkpoint = (h: History): History => ({
  past: [...h.past.slice(-LIMIT + 1), h.present],
  present: h.present,
  future: [],
})
export const replace = (h: History, present: EditorDoc): History => ({ ...h, present })
export const commit = (h: History, present: EditorDoc): History => replace(checkpoint(h), present)
export const undo = (h: History): History =>
  h.past.length === 0
    ? h
    : { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] }
export const redo = (h: History): History =>
  h.future.length === 0
    ? h
    : { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }
