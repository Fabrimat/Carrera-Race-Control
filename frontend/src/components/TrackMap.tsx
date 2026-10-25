import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { cumulative, estimateS, pointAt, shortestDelta, tangentAt, toDisplay, type Pt } from '../lib/geometry'
import { useStore } from '../lib/store'
import type { RaceState, TrackLayout } from '../lib/types'

/** Time constants (ms) of the exponential easing toward the estimated position. */
export const EASE_FORWARD_MS = 120
export const EASE_BACKWARD_MS = 450
const FLASH_MS = 450

/**
 * One animation step of a car dot. `snap` (a new crossing just arrived) jumps forward at
 * once; otherwise the dot eases toward the target, and a target that lies behind the dot is
 * approached much more slowly so a resync never visibly throws the car backwards.
 * Distances use shortestDelta, so the 1 -> 0 wrap at the line is crossed smoothly.
 */
export function stepDot(current: number, target: number, dtMs: number, snap: boolean): number {
  const delta = shortestDelta(current, target)
  if (snap && delta >= 0) return target
  const tau = delta >= 0 ? EASE_FORWARD_MS : EASE_BACKWARD_MS
  const next = current + delta * (1 - Math.exp(-Math.max(0, dtMs) / tau))
  return ((next % 1) + 1) % 1
}

/** Race clock extrapolated since the last state message; frozen unless RUNNING. */
export function raceClockNow(race: Pick<RaceState, 'phase' | 'race_time_ms'>, receivedAt: number, now: number): number {
  return race.phase === 'running' ? race.race_time_ms + Math.max(0, now - receivedAt) : race.race_time_ms
}

type MapState = { kind: 'loading' } | { kind: 'ready'; layout: TrackLayout } | { kind: 'missing' } | { kind: 'error' }

interface DotRuntime {
  s: number
  anchor: number | null
  crossing: number | null
  flashAt: number
}

export function TrackMap({ className = '' }: { className?: string }) {
  const t = useT()
  const race = useStore((s) => s.race)
  const layoutName = race.layout
  const [result, setResult] = useState<{ name: string; state: MapState } | null>(null)
  // A result for another layout name counts as still loading.
  const state: MapState = result && result.name === layoutName ? result.state : { kind: 'loading' }

  useEffect(() => {
    let live = true
    const done = (s: MapState) => live && setResult({ name: layoutName, state: s })
    api
      .findLayout(layoutName)
      .then((layout) => done(layout ? { kind: 'ready', layout } : { kind: 'missing' }))
      .catch(() => done({ kind: 'error' }))
    return () => {
      live = false
    }
  }, [layoutName])

  const body = (() => {
    switch (state.kind) {
      case 'loading':
        return <p className="p-4 text-dim">{t('map.loading')}</p>
      case 'error':
        return <p className="p-4 text-signal">{t('map.error')}</p>
      case 'missing':
        return (
          <div className="flex flex-col items-start gap-3 p-4" data-testid="map-empty">
            <p className="text-dim">{t('map.empty', { name: layoutName })}</p>
            <a
              href="#/track"
              className="rounded-md border border-line bg-panel-2 px-4 py-2 text-sm font-bold uppercase hover:border-amber"
            >
              {t('map.draw')}
            </a>
          </div>
        )
      case 'ready':
        return <MapCanvas layout={state.layout} />
    }
  })()

  return (
    <section className={`rounded-lg border border-line bg-panel p-4 ${className}`} aria-label={t('map.title')}>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-dim">{t('map.title')}</h2>
      {body}
    </section>
  )
}

function MapCanvas({ layout }: { layout: TrackLayout }) {
  const t = useT()
  const race = useStore((s) => s.race)
  const raceRef = useRef({ race, receivedAt: 0 })
  const dotEls = useRef(new Map<number, SVGGElement>())
  const ringEls = useRef(new Map<number, SVGCircleElement>())

  // Re-anchor the local race clock whenever a new state message arrives.
  useEffect(() => {
    raceRef.current = { race, receivedAt: performance.now() }
  }, [race])

  // All s values are arc lengths in display space (x scaled by aspect).
  const scaled = useMemo(() => toDisplay(layout.points as Pt[], layout.aspect), [layout])
  const cum = useMemo(() => cumulative(scaled), [scaled])
  const pitS = layout.pit_s

  useEffect(() => {
    const dots = new Map<number, DotRuntime>()
    let last = performance.now()
    let raf = 0
    const frame = () => {
      const now = performance.now()
      const dt = now - last
      last = now
      const { race: r, receivedAt } = raceRef.current
      const raceNow = raceClockNow(r, receivedAt, now)
      for (const c of r.cars) {
        const el = dotEls.current.get(c.address)
        if (!el) continue
        const pos = c.track_pos
        if (!pos) {
          el.setAttribute('visibility', 'hidden')
          continue
        }
        const target = estimateS(pos, raceNow, pitS)
        const crossing = c.last_crossing?.race_time_ms ?? null
        let d = dots.get(c.address)
        const fresh = !d
        if (!d) {
          d = { s: target, anchor: pos.anchor_race_ms, crossing, flashAt: -Infinity }
          dots.set(c.address, d)
        }
        const snap = pos.anchor_race_ms !== d.anchor
        if (crossing !== d.crossing && !fresh) d.flashAt = now
        d.anchor = pos.anchor_race_ms
        d.crossing = crossing
        d.s = stepDot(d.s, target, dt, snap)
        const [x, y] = pointAt(scaled, d.s, cum)
        el.setAttribute('transform', `translate(${x} ${y})`)
        el.setAttribute('visibility', 'visible')
        const ring = ringEls.current.get(c.address)
        if (ring) {
          const k = (now - d.flashAt) / FLASH_MS
          if (k >= 0 && k < 1) {
            ring.setAttribute('opacity', String(1 - k))
            ring.setAttribute('r', String(0.032 + 0.05 * k))
          } else ring.setAttribute('opacity', '0')
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [scaled, cum, pitS])

  const pad = 0.08
  const w = layout.aspect
  const pathD = scaled.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ') + ' Z'
  const at = (s: number) => pointAt(scaled, s, cum)
  const [sx, sy] = at(0)
  const [tx, ty] = tangentAt(scaled, 0, cum)
  const arrow = at(0.04)
  const [ax, ay] = tangentAt(scaled, 0.04, cum)
  const angle = (Math.atan2(ay, ax) * 180) / Math.PI
  const ordered = [...race.cars].sort((a, b) => (a.position ?? 99) - (b.position ?? 99))

  return (
    <svg
      role="img"
      aria-label={t('map.aria')}
      data-testid="track-map"
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${1 + pad * 2}`}
      className="max-h-full w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <path d={pathD} fill="none" stroke="#0b0d10" strokeWidth={0.06} strokeLinejoin="round" />
      <path d={pathD} fill="none" stroke="#2a323b" strokeWidth={0.05} strokeLinejoin="round" data-testid="track-path" />
      <path d={pathD} fill="none" stroke="#3b4652" strokeWidth={0.004} strokeDasharray="0.02 0.02" />
      {/* direction arrow */}
      <polygon
        points="0.03,0 -0.02,0.022 -0.02,-0.022"
        fill="#8a96a3"
        transform={`translate(${arrow[0]} ${arrow[1]}) rotate(${angle})`}
        data-testid="direction-arrow"
      />
      {/* start/finish line, perpendicular to the driving direction */}
      <line
        x1={sx - ty * 0.04}
        y1={sy + tx * 0.04}
        x2={sx + ty * 0.04}
        y2={sy - tx * 0.04}
        stroke="#e8ecef"
        strokeWidth={0.012}
        strokeDasharray="0.012 0.012"
        data-testid="start-line"
      />
      {layout.sensors.map((sen) => {
        const [x, y] = at(sen.s)
        const [dx, dy] = tangentAt(scaled, sen.s, cum)
        return (
          <g key={sen.sensor} data-testid={`sensor-${sen.sensor}`}>
            <line
              x1={x - dy * 0.035}
              y1={y + dx * 0.035}
              x2={x + dy * 0.035}
              y2={y - dx * 0.035}
              stroke="#ffb000"
              strokeWidth={0.014}
            />
            <text x={x + dy * 0.07} y={y - dx * 0.07} fontSize={0.045} fill="#ffb000" textAnchor="middle" dominantBaseline="middle">
              {t('sectors.s', { n: sen.sensor })}
            </text>
          </g>
        )
      })}
      {pitS !== null && (
        <g data-testid="pit-marker">
          <circle cx={at(pitS)[0]} cy={at(pitS)[1]} r={0.02} fill="#ffb000" />
          <text x={at(pitS)[0]} y={at(pitS)[1]} fontSize={0.026} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill="#000">
            P
          </text>
        </g>
      )}
      {ordered.map((c) => {
        const stale = c.track_pos?.confidence === 'stale'
        return (
          <g
            key={c.address}
            ref={(el) => {
              if (el) dotEls.current.set(c.address, el)
              else dotEls.current.delete(c.address)
            }}
            visibility="hidden"
            opacity={stale ? 0.4 : 1}
            data-testid="car-dot"
            data-addr={c.address}
            data-stale={stale ? 'true' : 'false'}
            aria-label={t('map.car', { name: c.driver_name || c.name, pos: c.position ?? '–' })}
          >
            <circle
              ref={(el) => {
                if (el) ringEls.current.set(c.address, el)
                else ringEls.current.delete(c.address)
              }}
              r={0.032}
              fill="none"
              stroke={c.color}
              strokeWidth={0.01}
              opacity={0}
            />
            <circle r={0.032} fill={c.color} stroke="#0b0d10" strokeWidth={0.008} />
            <text fontSize={0.04} fontWeight={800} textAnchor="middle" dominantBaseline="central" fill="#fff" stroke="#000" strokeWidth={0.006} paintOrder="stroke">
              {stale ? '?' : (c.position ?? '')}
            </text>
            {stale && <title>{t('map.stale')}</title>}
          </g>
        )
      })}
    </svg>
  )
}
