import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { TrackMap, raceClockNow, stepDot } from './TrackMap'
import { api } from '../lib/api'
import { estimateS, pointAt, type Pt } from '../lib/geometry'
import { useStore } from '../lib/store'
import type { TrackLayout, TrackPosition } from '../lib/types'
import { car, raceState } from '../test/fixtures'

const square: Pt[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
]
const layout: TrackLayout = {
  name: 'Default',
  points: square,
  aspect: 1,
  sensors: [
    { sensor: 2, s: 0.33 },
    { sensor: 3, s: 0.66 },
  ],
  pit_s: 0.9,
  source: 'drawn',
  updated_at: '2026-01-01T00:00:00Z',
}
const pos = (over: Partial<TrackPosition> = {}): TrackPosition => ({
  from_sensor: 1,
  to_sensor: 2,
  s_from: 0,
  s_to: 0.25,
  anchor_race_ms: 0,
  expected_ms: 1000,
  in_pit: false,
  confidence: 'estimated',
  ...over,
})

let rafCb: FrameRequestCallback | null = null
let nowMs = 0

function frame(at: number) {
  nowMs = at
  const cb = rafCb
  rafCb = null
  act(() => cb?.(at))
}

describe('TrackMap', () => {
  beforeEach(() => {
    useStore.setState({ language: 'en', camera: {} })
    nowMs = 0
    rafCb = null
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn(() => (rafCb = null)))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the path, sensors, start line and pit marker', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({ race: raceState({ layout: 'Default' }) })
    render(<TrackMap />)
    expect(await screen.findByTestId('track-path')).toBeInTheDocument()
    expect(api.findLayout).toHaveBeenCalledWith('Default')
    expect(screen.getByTestId('start-line')).toBeInTheDocument()
    expect(screen.getByTestId('sensor-2')).toHaveTextContent('S2')
    expect(screen.getByTestId('sensor-3')).toHaveTextContent('S3')
    expect(screen.getByTestId('pit-marker')).toBeInTheDocument()
    expect(screen.getByTestId('direction-arrow')).toBeInTheDocument()
  })

  it('shows a friendly empty state with a link to the editor on 404', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(null)
    useStore.setState({ race: raceState({ layout: 'Nope' }) })
    render(<TrackMap />)
    expect(await screen.findByTestId('map-empty')).toHaveTextContent('Nope')
    expect(screen.getByRole('link', { name: 'Draw your track' })).toHaveAttribute('href', '#/track')
  })

  it('refetches when the layout name changes', async () => {
    const spy = vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({ race: raceState({ layout: 'A' }) })
    render(<TrackMap />)
    await screen.findByTestId('track-path')
    act(() => useStore.setState({ race: raceState({ layout: 'B' }) }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('B'))
  })

  it('places car dots at estimateS positions on the extrapolated race clock', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    const p = pos()
    useStore.setState({
      race: raceState({
        layout: 'Default',
        phase: 'running',
        race_time_ms: 0,
        cars: [car({ address: 0, name: 'Rosso', position: 1, track_pos: p })],
      }),
    })
    render(<TrackMap />)
    await screen.findByTestId('track-map')
    frame(0) // first frame: dot created at its target
    frame(500) // clock advanced 500 ms in the browser; dot eases toward the new target
    for (let t = 520; t < 3000; t += 20) frame(t) // converge (race clock keeps running)
    const target = estimateS(p, 3000 - 20 + 0, 0.9)
    const dot = screen.getByTestId('car-dot')
    expect(dot).toHaveAttribute('visibility', 'visible')
    const [x, y] = pointAt(square, target)
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(dot.getAttribute('transform') ?? '')
    expect(Number(m?.[1])).toBeCloseTo(x, 1)
    expect(Number(m?.[2])).toBeCloseTo(y, 1)
  })

  it('uses display space (x * aspect) for dots and markers when aspect is not 1', async () => {
    const wide: TrackLayout = { ...layout, aspect: 2, sensors: [{ sensor: 2, s: 0.25 }], pit_s: 0.5 }
    vi.spyOn(api, 'findLayout').mockResolvedValue(wide)
    useStore.setState({
      race: raceState({
        layout: 'Wide',
        cars: [car({ address: 0, position: 1, track_pos: pos({ in_pit: true }) })],
      }),
    })
    render(<TrackMap />)
    await screen.findByTestId('track-map')
    frame(0)
    // Display rectangle 2x1 has perimeter 6: s = 0.5 is the corner (2, 1), s = 0.25 is (1.5, 0).
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(screen.getByTestId('car-dot').getAttribute('transform') ?? '')
    expect(Number(m?.[1])).toBeCloseTo(2, 5)
    expect(Number(m?.[2])).toBeCloseTo(1, 5)
    const line = screen.getByTestId('sensor-2').querySelector('line')
    expect(Number(line?.getAttribute('x1'))).toBeCloseTo(1.5, 5)
    expect(Number(line?.getAttribute('x2'))).toBeCloseTo(1.5, 5)
    const svg = screen.getByTestId('track-map')
    expect(svg.getAttribute('viewBox')).toBe('-0.08 -0.08 2.16 1.16')
  })

  it('hides cars without a position and dims stale ones with a ?', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({
      race: raceState({
        layout: 'Default',
        cars: [
          car({ address: 0, position: 1 }),
          car({ address: 1, position: 2, track_pos: pos({ confidence: 'stale' }) }),
        ],
      }),
    })
    render(<TrackMap />)
    await screen.findByTestId('track-map')
    frame(0)
    const dots = screen.getAllByTestId('car-dot')
    expect(dots[0]).toHaveAttribute('visibility', 'hidden')
    expect(dots[1]).toHaveAttribute('data-stale', 'true')
    expect(dots[1]).toHaveTextContent('?')
  })

  it('uses a fresh webcam position instead of the estimate and draws it as measured', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({
      race: raceState({ layout: 'Default', cars: [car({ address: 0, position: 1, track_pos: pos() })] }),
      camera: { 0: { s: 0.5, seen_at: 0, off_path: false } },
    })
    render(<TrackMap />)
    await screen.findByTestId('track-map')
    frame(0)
    const dot = screen.getByTestId('car-dot')
    expect(dot).toHaveAttribute('data-measured', 'true')
    expect(screen.getByTestId('camera-ring')).toHaveAttribute('visibility', 'visible')
    // s = 0.5 on the unit square is the corner (1, 1); the estimate would be s = 0.
    const at = () => /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(dot.getAttribute('transform') ?? '')
    expect(Number(at()?.[1])).toBeCloseTo(1, 5)
    expect(Number(at()?.[2])).toBeCloseTo(1, 5)
    // 500 ms later the measurement is stale: back to the estimate, normal dot.
    for (let t = 500; t < 4000; t += 20) frame(t)
    expect(dot).toHaveAttribute('data-measured', 'false')
    expect(screen.getByTestId('camera-ring')).toHaveAttribute('visibility', 'hidden')
    expect(Number(at()?.[2])).toBeCloseTo(0, 1) // the paused estimate stays at s = 0 (top edge)
  })

  it('shows a car the webcam sees even without an estimated position', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({
      race: raceState({ layout: 'Default', cars: [car({ address: 2, position: 1 })] }),
      camera: { 2: { s: 0.25, seen_at: 100, off_path: false } },
    })
    render(<TrackMap />)
    await screen.findByTestId('track-map')
    frame(200)
    const dot = screen.getByTestId('car-dot')
    expect(dot).toHaveAttribute('visibility', 'visible')
    expect(dot).toHaveAttribute('data-measured', 'true')
    frame(700)
    expect(dot).toHaveAttribute('visibility', 'hidden')
  })

  it('cancels the animation frame on unmount', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({ race: raceState({ layout: 'Default' }) })
    const { unmount } = render(<TrackMap />)
    await screen.findByTestId('track-map')
    unmount()
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })
})

describe('stepDot', () => {
  it('snaps forward on a new crossing', () => {
    expect(stepDot(0.2, 0.3, 16, true)).toBe(0.3)
  })
  it('eases forward without overshooting', () => {
    const n = stepDot(0.2, 0.3, 16, false)
    expect(n).toBeGreaterThan(0.2)
    expect(n).toBeLessThan(0.3)
  })
  it('never snaps backwards: moves only a little toward a target behind', () => {
    const n = stepDot(0.5, 0.4, 16, true)
    expect(n).toBeLessThan(0.5)
    expect(n).toBeGreaterThan(0.49)
  })
  it('crosses the line smoothly from 0.99 to 0.01', () => {
    const n = stepDot(0.99, 0.01, 1000, false)
    expect(n === 0 || n > 0.99 || n < 0.02).toBe(true)
    expect(stepDot(0.99, 0.01, 16, true)).toBe(0.01)
  })
})

describe('raceClockNow', () => {
  it('advances only while running', () => {
    expect(raceClockNow({ phase: 'running', race_time_ms: 1000 }, 100, 350)).toBe(1250)
    expect(raceClockNow({ phase: 'paused', race_time_ms: 1000 }, 100, 350)).toBe(1000)
    expect(raceClockNow({ phase: 'finished', race_time_ms: 1000 }, 100, 350)).toBe(1000)
  })
})
