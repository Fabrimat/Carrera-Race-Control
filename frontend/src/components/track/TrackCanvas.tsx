import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useT } from '../../i18n/useT'
import { pointAt, tangentAt, type Pt } from '../../lib/geometry'
import { shiftS, type EditorDoc } from '../../lib/trackEditor'

export type CanvasMode = 'draw' | 'edit'

interface Props {
  doc: EditorDoc
  mode: CanvasMode
  /** Photo drawn behind the path (same aspect as the document). */
  bg: string | null
  selected: number | null
  onSelect: (i: number | null) => void
  onStroke: (pts: Pt[]) => void
  /** Called once before a drag / key nudge so the page can push an undo checkpoint. */
  onBeginDrag: () => void
  onMoveHandle: (i: number, p: Pt) => void
  onMoveStart: (p: Pt) => void
  onMoveSensor: (sensor: number, p: Pt) => void
  onMovePit: (p: Pt) => void
  onInsert: (p: Pt) => void
  onRemove: (i: number) => void
}

const H = 1000
const LONG_PRESS_MS = 550
const DRAG_SLOP = 0.006
const KEY_STEP = 0.004
const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

interface Drag {
  kind: string
  start: Pt
  began: boolean
  moved: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export function TrackCanvas(p: Props) {
  const t = useT()
  const { doc, mode } = p
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const strokeRef = useRef<Pt[]>([])
  const [stroke, setStroke] = useState<Pt[] | null>(null)
  const W = doc.aspect * H
  const v = (q: Pt) => `${(q[0] * H).toFixed(1)},${(q[1] * H).toFixed(1)}`
  const hasPath = doc.path.length > 2
  const editing = mode === 'edit'

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    const x = r.width > 0 ? (e.clientX - r.left) / r.width : 0
    const y = r.height > 0 ? (e.clientY - r.top) / r.height : 0
    // Document coordinates are display space: x spans 0..aspect, y spans 0..1.
    return [Math.min(1, Math.max(0, x)) * doc.aspect, Math.min(1, Math.max(0, y))]
  }
  const kindOf = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.('[data-drag]')?.getAttribute('data-drag') ?? null

  const clearTimer = () => {
    if (drag.current?.timer) clearTimeout(drag.current.timer)
  }
  const end = (commit: boolean) => {
    clearTimer()
    if (drag.current?.kind === 'stroke' && commit && strokeRef.current.length > 1) p.onStroke(strokeRef.current)
    drag.current = null
    strokeRef.current = []
    setStroke(null)
  }

  // Never fire a long-press after the canvas is gone.
  useEffect(() => () => clearTimer(), [])

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const pt = toPt(e)
    const kind = editing ? kindOf(e.target) : null
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* synthetic pointers have nothing to capture */
    }
    if (!editing) {
      drag.current = { kind: 'stroke', start: pt, began: true, moved: true, timer: null }
      strokeRef.current = [pt]
      setStroke([pt])
      return
    }
    if (!kind) {
      p.onSelect(null)
      return
    }
    const d: Drag = { kind, start: pt, began: false, moved: false, timer: null }
    if (kind.startsWith('handle:')) p.onSelect(Number(kind.slice(7)))
    if (kind === 'path' || kind.startsWith('handle:')) {
      d.timer = setTimeout(() => {
        if (drag.current !== d || d.moved) return
        // Long-press: insert on the line, remove on a point (undoable).
        drag.current = null
        p.onBeginDrag()
        if (kind === 'path') p.onInsert(pt)
        else p.onRemove(Number(kind.slice(7)))
      }, LONG_PRESS_MS)
    }
    drag.current = d
  }

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const pt = toPt(e)
    if (d.kind === 'stroke') {
      const last = strokeRef.current[strokeRef.current.length - 1]
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.003) return
      strokeRef.current.push(pt)
      setStroke(strokeRef.current.slice())
      return
    }
    if (!d.moved) {
      if (Math.hypot(pt[0] - d.start[0], pt[1] - d.start[1]) < DRAG_SLOP) return
      d.moved = true
      clearTimer()
    }
    if (d.kind === 'path') return
    if (!d.began) {
      d.began = true
      p.onBeginDrag()
    }
    if (d.kind.startsWith('handle:')) p.onMoveHandle(Number(d.kind.slice(7)), pt)
    else if (d.kind === 'start') p.onMoveStart(pt)
    else if (d.kind.startsWith('sensor:')) p.onMoveSensor(Number(d.kind.slice(7)), pt)
    else if (d.kind === 'pit') p.onMovePit(pt)
  }

  const onDoubleClick = (e: { clientX: number; clientY: number; target: EventTarget | null }) => {
    if (editing && kindOf(e.target) === 'path') {
      p.onBeginDrag()
      p.onInsert(toPt(e))
    }
  }

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const kind = kindOf(e.target)
    if (!editing || !kind) return
    const arrow = ARROWS[e.key]
    const step = (e.shiftKey ? 5 : 1) * KEY_STEP
    if (kind.startsWith('handle:')) {
      const i = Number(kind.slice(7))
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        p.onBeginDrag()
        p.onRemove(i)
      } else if (arrow) {
        e.preventDefault()
        const cur = doc.handles[i]
        p.onBeginDrag()
        p.onMoveHandle(i, [cur[0] + arrow[0] * step, cur[1] + arrow[1] * step])
      }
      return
    }
    if (!arrow) return
    // Annotations slide along the path: right/down = forward, left/up = backward.
    const delta = (arrow[0] + arrow[1] > 0 ? 1 : -1) * step
    e.preventDefault()
    if (kind === 'start') {
      p.onBeginDrag()
      p.onMoveStart(pointAt(doc.path, delta))
    } else if (kind.startsWith('sensor:')) {
      const sensor = Number(kind.slice(7))
      const cur = doc.sensors.find((x) => x.sensor === sensor)
      if (!cur) return
      p.onBeginDrag()
      p.onMoveSensor(sensor, pointAt(doc.path, shiftS(cur.s, delta)))
    } else if (kind === 'pit' && doc.pitS !== null) {
      p.onBeginDrag()
      p.onMovePit(pointAt(doc.path, shiftS(doc.pitS, delta)))
    }
  }

  // Perpendicular tick across the track at fraction s (start line, Check Lanes).
  const tick = (s: number, half: number) => {
    const c = pointAt(doc.path, s)
    const tg = tangentAt(doc.path, s)
    const nx = -tg[1]
    const ny = tg[0]
    const len = Math.hypot(nx, ny) || 1
    const cx = c[0] * H
    const cy = c[1] * H
    return {
      cx,
      cy,
      x1: cx - (nx / len) * half,
      y1: cy - (ny / len) * half,
      x2: cx + (nx / len) * half,
      y2: cy + (ny / len) * half,
    }
  }

  const arrows = hasPath ? [0.125, 0.375, 0.625, 0.875] : []
  const interactive = editing ? 'auto' : 'none'

  return (
    <div className="mx-auto w-full" style={{ maxWidth: `calc((100vh - 15rem) * ${doc.aspect})`, minWidth: '16rem' }}>
      <svg
        ref={svg}
        data-testid="track-canvas"
        role="application"
        aria-label={t('editor.canvas')}
        viewBox={`0 0 ${W.toFixed(1)} ${H}`}
        className="block w-full select-none rounded-lg border border-line bg-panel"
        style={{ touchAction: 'none', cursor: editing ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const k = kindOf(e.target)
          if (editing && k?.startsWith('handle:')) p.onSelect(Number(k.slice(7)))
        }}
      >
        {p.bg && <image href={p.bg} x={0} y={0} width={W} height={H} opacity={0.5} preserveAspectRatio="none" />}

        {hasPath && (
          <g opacity={editing ? 1 : 0.35}>
            <polygon points={doc.path.map(v).join(' ')} fill="none" stroke="#3a434d" strokeWidth={26} strokeLinejoin="round" />
            <polygon
              data-testid="track-path"
              points={doc.path.map(v).join(' ')}
              fill="none"
              stroke="#8a96a3"
              strokeWidth={3}
              strokeDasharray="14 10"
              strokeLinejoin="round"
            />
            {arrows.map((s) => {
              const c = pointAt(doc.path, s)
              const tg = tangentAt(doc.path, s)
              const dx = tg[0]
              const dy = tg[1]
              const l = Math.hypot(dx, dy) || 1
              const ux = dx / l
              const uy = dy / l
              const cx = c[0] * H
              const cy = c[1] * H
              const pts = [
                [cx + ux * 14, cy + uy * 14],
                [cx - ux * 10 - uy * 10, cy - uy * 10 + ux * 10],
                [cx - ux * 10 + uy * 10, cy - uy * 10 - ux * 10],
              ]
              return <polygon key={s} data-testid="track-arrow" points={pts.map((q) => q.join(',')).join(' ')} fill="#e8ecef" />
            })}
            {editing && (
              <polygon
                data-drag="path"
                points={doc.path.map(v).join(' ')}
                fill="none"
                stroke="transparent"
                strokeWidth={44}
                style={{ pointerEvents: 'stroke' }}
              />
            )}
          </g>
        )}

        {hasPath && (
          <g style={{ pointerEvents: interactive }}>
            {/* Start / finish line */}
            {(() => {
              const k = tick(0, 22)
              return (
                <g
                  data-drag="start"
                  data-testid="marker-start"
                  tabIndex={editing ? 0 : -1}
                  role="button"
                  aria-label={t('editor.start')}
                  className="cursor-grab outline-none focus-visible:[&_circle]:stroke-white"
                >
                  <circle cx={k.cx} cy={k.cy} r={28} fill="transparent" stroke="transparent" strokeWidth={3} />
                  <line x1={k.x1} y1={k.y1} x2={k.x2} y2={k.y2} stroke="#fff" strokeWidth={9} />
                  <line x1={k.x1} y1={k.y1} x2={k.x2} y2={k.y2} stroke="#0b0d10" strokeWidth={9} strokeDasharray="6 6" />
                  <text x={k.cx + 18} y={k.cy - 22} fill="#e8ecef" fontSize={22} fontWeight={700}>
                    S/F
                  </text>
                </g>
              )
            })()}

            {doc.sensors.map((sn) => {
              const k = tick(sn.s, 20)
              return (
                <g
                  key={sn.sensor}
                  data-drag={`sensor:${sn.sensor}`}
                  data-testid={`marker-sensor-${sn.sensor}`}
                  tabIndex={editing ? 0 : -1}
                  role="button"
                  aria-label={t('editor.sensor', { n: sn.sensor })}
                  className="cursor-grab outline-none focus-visible:[&_circle]:stroke-white"
                >
                  <circle cx={k.cx} cy={k.cy} r={26} fill="transparent" stroke="transparent" strokeWidth={3} />
                  <line x1={k.x1} y1={k.y1} x2={k.x2} y2={k.y2} stroke="#ffb000" strokeWidth={8} strokeLinecap="round" />
                  <text x={k.cx + 16} y={k.cy - 18} fill="#ffb000" fontSize={24} fontWeight={800}>
                    {`S${sn.sensor}`}
                  </text>
                </g>
              )
            })}

            {doc.pitS !== null &&
              (() => {
                const c = pointAt(doc.path, doc.pitS)
                const cx = c[0] * H
                const cy = c[1] * H
                return (
                  <g
                    data-drag="pit"
                    data-testid="marker-pit"
                    tabIndex={editing ? 0 : -1}
                    role="button"
                    aria-label={t('editor.pit')}
                    className="cursor-grab outline-none focus-visible:[&_rect]:stroke-white"
                  >
                    <circle cx={cx} cy={cy} r={28} fill="transparent" />
                    <rect x={cx - 15} y={cy - 15} width={30} height={30} rx={5} fill="#30d158" stroke="#0b0d10" strokeWidth={2} />
                    <text x={cx} y={cy + 8} textAnchor="middle" fill="#0b0d10" fontSize={22} fontWeight={800}>
                      P
                    </text>
                  </g>
                )
              })()}
          </g>
        )}

        {editing &&
          doc.handles.map((h, i) => {
            const sel = p.selected === i
            return (
              <g
                key={i}
                data-drag={`handle:${i}`}
                data-testid={`handle-${i}`}
                tabIndex={0}
                role="button"
                aria-label={t('editor.point', { n: i + 1 })}
                aria-pressed={sel}
                className="cursor-grab outline-none focus-visible:[&_circle:nth-child(2)]:stroke-white"
              >
                <circle cx={h[0] * H} cy={h[1] * H} r={26} fill="transparent" />
                <circle
                  cx={h[0] * H}
                  cy={h[1] * H}
                  r={sel ? 13 : 10}
                  fill={sel ? '#ff3b30' : '#e8ecef'}
                  stroke="#0b0d10"
                  strokeWidth={3}
                />
              </g>
            )
          })}

        {stroke && stroke.length > 1 && (
          <polyline
            data-testid="stroke-preview"
            points={stroke.map(v).join(' ')}
            fill="none"
            stroke="#ff3b30"
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </div>
  )
}
