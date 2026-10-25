import { describe, expect, it } from 'vitest'
import { cumulative, nearestS, pointAt, type Pt } from './geometry'
import { base64Bytes, fitSize } from './photo'
import {
  addSensor,
  catmullRom,
  checkpoint,
  commit,
  docFromPath,
  docFromStroke,
  emptyDoc,
  fromDisplay,
  setAspect,
  HANDLE_COUNT,
  insertHandle,
  moveHandle,
  moveSensor,
  moveStart,
  newHistory,
  PATH_POINTS,
  redo,
  removeHandle,
  replace,
  reverseDoc,
  toLayout,
  undo,
  validateDoc,
} from './trackEditor'

const circle = (n: number, r = 0.4): Pt[] =>
  Array.from({ length: n }, (_, i): Pt => [
    0.5 + r * Math.cos((2 * Math.PI * i) / n),
    0.5 + r * Math.sin((2 * Math.PI * i) / n),
  ])

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
const oval = () => docFromPath(circle(120), 1.5)

describe('catmullRom', () => {
  it('passes through every control point', () => {
    const pts = circle(8)
    const curve = catmullRom(pts, 10)
    expect(curve).toHaveLength(80)
    pts.forEach((p, i) => expect(dist(curve[i * 10], p)).toBeLessThan(1e-9))
  })
})

describe('freehand stroke', () => {
  it('becomes a closed, resampled, smoothed path with handles', () => {
    // A rough three-quarter loop with jitter, deliberately not closed.
    const raw = circle(80).slice(0, 70).map(([x, y], i): Pt => [x + (i % 2) * 0.004, y])
    const doc = docFromStroke(raw, 1.5)!
    expect(doc.path).toHaveLength(PATH_POINTS)
    expect(doc.handles).toHaveLength(HANDLE_COUNT)
    expect(cumulative(doc.path)[PATH_POINTS]).toBeGreaterThan(0.5)
    expect(doc.path[0]).toEqual(doc.handles[0])
  })
  it('ignores scribbles that are too short', () => {
    expect(docFromStroke([[0.1, 0.1], [0.11, 0.1], [0.12, 0.1]], 1.5)).toBeNull()
  })
})

describe('handles', () => {
  it('dragging a handle updates the path and keeps the other handles', () => {
    const doc = oval()
    const moved = moveHandle(doc, 5, [0.5, 0.5])
    expect(moved.handles[5]).toEqual([0.5, 0.5])
    expect(moved.handles[6]).toEqual(doc.handles[6])
    expect(moved.path).not.toEqual(doc.path)
    expect(moved.path).toHaveLength(PATH_POINTS)
  })
  it('keeps the start/finish line where it was', () => {
    const doc = oval()
    const moved = moveHandle(doc, 12, [0.5, 0.5])
    expect(dist(moved.path[0], doc.path[0])).toBeLessThan(0.02)
  })
  it('inserts on the curve and removes down to the minimum', () => {
    const doc = oval()
    const { doc: ins, index } = insertHandle(doc, [0.5, 0.1])
    expect(ins.handles).toHaveLength(HANDLE_COUNT + 1)
    expect(index).toBeGreaterThan(0)
    let d = ins
    for (let i = 0; i < 40; i++) d = removeHandle(d, 1)
    expect(d.handles).toHaveLength(4)
  })
})

describe('annotations', () => {
  it('places sensors with nearestS and enforces the 1% gap', () => {
    const doc = oval()
    const target = pointAt(doc.path, 0.4)
    const placed = moveSensor(doc, 2, target)
    expect(placed.sensors).toEqual([{ sensor: 2, s: nearestS(doc.path, target) }])
    expect(placed.sensors[0].s).toBeCloseTo(0.4, 2)
    // Too close to sensor 2 and to the start line: rejected.
    expect(moveSensor(placed, 3, pointAt(doc.path, 0.401))).toBe(placed)
    expect(moveSensor(placed, 3, pointAt(doc.path, 0.004))).toBe(placed)
  })
  it('adds default sensors respecting the gap', () => {
    const doc = addSensor(addSensor(oval(), 2), 3)
    expect(doc.sensors.map((s) => s.sensor)).toEqual([2, 3])
    expect(Math.abs(doc.sensors[0].s - doc.sensors[1].s)).toBeGreaterThanOrEqual(0.01)
  })
  it('reverse keeps the start point and mirrors annotations', () => {
    const doc = moveSensor(oval(), 2, pointAt(oval().path, 0.25))
    const rev = reverseDoc(doc)
    expect(rev.path[0]).toEqual(doc.path[0])
    expect(rev.path[1]).toEqual(doc.path[PATH_POINTS - 1])
    expect(rev.sensors[0].s).toBeCloseTo(0.75, 2)
  })
  it('moving the start rotates the path and keeps sensors in place', () => {
    const doc = moveSensor(oval(), 2, pointAt(oval().path, 0.5))
    const before = pointAt(doc.path, doc.sensors[0].s)
    const moved = moveStart(doc, pointAt(doc.path, 0.25))
    expect(dist(moved.path[0], pointAt(doc.path, 0.25))).toBeLessThan(0.02)
    expect(dist(pointAt(moved.path, moved.sensors[0].s), before)).toBeLessThan(0.01)
  })
})

describe('display space', () => {
  it('stores s on the display-space arc length', () => {
    const doc = oval()
    const l = toLayout(moveSensor(doc, 2, pointAt(doc.path, 0.3)), 'A', 'drawn', false)
    // Re-derive s from the stored points scaled by aspect: it must match.
    const disp = l.points.map(([x, y]): Pt => [x * l.aspect, y])
    expect(nearestS(disp, pointAt(doc.path, 0.3))).toBeCloseTo(l.sensors[0].s, 3)
  })
  it('keeps annotation positions when the frame is resized', () => {
    const doc = moveSensor(oval(), 2, pointAt(oval().path, 0.5))
    const wide = setAspect(doc, 3)
    expect(wide.aspect).toBe(3)
    expect(Math.max(...wide.path.map((q) => q[0]))).toBeGreaterThan(Math.max(...doc.path.map((q) => q[0])))
    expect(wide.sensors[0].s).toBeCloseTo(0.5, 1)
  })
})

describe('toLayout', () => {
  it('fits a photo draft (image fractions) to its bounding box', () => {
    const photo = docFromPath(circle(100, 0.2).map(([x, y]): Pt => [x * 0.5 + 0.1, y]), 2)
    const l = toLayout(addSensor(photo, 2), 'Garage', 'photo', true)
    const xs = l.points.map((p) => p[0])
    const ys = l.points.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    expect(Math.max(...xs)).toBeCloseTo(1, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
    expect(Math.max(...ys)).toBeCloseTo(1, 6)
    expect(l.aspect).toBeGreaterThan(0)
    expect(l.sensors).toHaveLength(1)
    expect(l.source).toBe('photo')
  })
  it('keeps drawn layouts untouched', () => {
    const doc = oval()
    const l = toLayout(doc, ' Home ', 'drawn', false)
    expect(l.points).toEqual(fromDisplay(doc.path, 1.5))
    expect(Math.max(...l.points.map((q) => q[0]))).toBeLessThanOrEqual(1)
    expect(l.name).toBe('Home')
    expect(l.aspect).toBe(1.5)
  })
  it('validates name and path', () => {
    expect(validateDoc(oval(), 'x')).toBeNull()
    expect(validateDoc(oval(), '  ')).toBe('name')
    expect(validateDoc(emptyDoc(), 'x')).toBe('path')
  })
})

describe('history', () => {
  it('undoes and redoes', () => {
    const a = emptyDoc()
    const b = oval()
    let h = newHistory(a)
    h = commit(h, b)
    expect(h.present).toBe(b)
    h = undo(h)
    expect(h.present).toBe(a)
    h = redo(h)
    expect(h.present).toBe(b)
    expect(undo(newHistory(a))).toEqual(newHistory(a))
  })
  it('checkpoint + replace pushes one entry per drag', () => {
    let h = newHistory(oval())
    h = checkpoint(h)
    h = replace(h, moveHandle(h.present, 1, [0.2, 0.2]))
    h = replace(h, moveHandle(h.present, 1, [0.3, 0.3]))
    expect(h.past).toHaveLength(1)
  })
})

describe('photo helpers', () => {
  it('fits to 1600 px on the longest side and never upscales', () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 })
  })
  it('measures base64 payloads', () => {
    expect(base64Bytes('QUJD')).toBe(3)
    expect(base64Bytes('QUI=')).toBe(2)
  })
})
