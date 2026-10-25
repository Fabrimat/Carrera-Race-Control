import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { CONTROLS_HIDE_MS, TvMode } from './TvMode'
import { api, ApiError } from '../lib/api'
import { EXIT_MS } from '../lib/bannerQueue'
import { GAP_CYCLE_MS } from '../lib/tvTiming'
import { emptyRace, useStore } from '../lib/store'
import type { CommentaryLine, RaceEvent } from '../lib/types'
import { car, raceState, settingsResponse } from '../test/fixtures'

const at = '2026-01-01T00:00:00Z'
const cars = [
  car({ address: 0, name: 'Fulmine', color: '#e53935', position: 1, laps: 3, best_lap_ms: 6900, gap_to_leader_ms: null }),
  car({ address: 1, name: 'Verde', color: '#30d158', position: 2, laps: 3, best_lap_ms: 7000, gap_to_leader_ms: 2500, gap_to_ahead_ms: 2500, in_pit: true }),
  car({ address: 2, name: 'Blu', color: '#1e88e5', position: 3, laps: 3, best_lap_ms: 7300, gap_to_leader_ms: 4000, gap_to_ahead_ms: 1500 }),
]
const running = () =>
  raceState({
    phase: 'running',
    race_id: 1,
    cars,
    best_lap: { address: 0, lap_ms: 6900, lap_number: 2 },
    config: { ...emptyRace.config, mode: 'laps', target_laps: 5 },
  })

const ev = (e: Partial<RaceEvent> & { type: RaceEvent['type'] }, n = 0) =>
  ({ at: `${at}#${n}`, race_time_ms: 1000, ...e }) as RaceEvent
const push = (e: RaceEvent) => act(() => useStore.getState().applyMessage({ type: 'event', data: e }))
const line = (text: string): CommentaryLine => ({
  id: text,
  text,
  priority: 'normal',
  event_type: 'lap_completed',
  at,
  source: 'template',
  audio_url: null,
})

/** Advance fake time in small steps so chained effect-scheduled timers get to run between renders. */
function tick(ms: number) {
  for (let t = 0; t < ms; t += 50) act(() => void vi.advanceTimersByTime(50))
}

function mockMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: reduce,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

describe('TvMode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(api, 'layout').mockRejectedValue(new ApiError(404, null, 'layout_not_found'))
    mockMatchMedia(false)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    useStore.setState({
      language: 'en',
      race: running(),
      events: [],
      commentary: [],
      muted: false,
      settings: settingsResponse(),
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the timing tower with unique driver codes and markers', () => {
    render(<TvMode />)
    const rows = screen.getAllByTestId('tv-row')
    expect(rows).toHaveLength(3)
    expect(screen.getAllByTestId('tv-code').map((e) => e.textContent)).toEqual(['FUL', 'VER', 'BLU'])
    expect(within(rows[1]).getByTestId('tv-pit')).toBeInTheDocument()
    expect(within(rows[0]).getByTestId('tv-fastest')).toBeInTheDocument()
    expect(within(rows[0]).getByTestId('tv-gap')).toHaveTextContent('LEADER')
    expect(screen.getByTestId('tv-lap')).toHaveTextContent('LAP 4/5')
  })

  it('marks the track record holder gold instead of purple', () => {
    act(() =>
      useStore.setState({
        race: {
          ...running(),
          track_record: { layout: 'Default', lap_ms: 6900, address: 0, holder_name: 'Fulmine', race_id: 1, set_at: at },
        },
      }),
    )
    render(<TvMode />)
    const first = screen.getAllByTestId('tv-row')[0]
    expect(within(first).getByTestId('tv-record')).toBeInTheDocument()
    expect(within(first).queryByTestId('tv-fastest')).toBeNull()
  })

  it('cycles the gap column between gap to leader and interval every 10 s', () => {
    render(<TvMode />)
    const third = () => within(screen.getAllByTestId('tv-row')[2]).getByTestId('tv-gap')
    expect(third()).toHaveTextContent('+4.000')
    expect(screen.getByTestId('tv-gap-mode')).toHaveTextContent('GAP')
    tick(GAP_CYCLE_MS)
    expect(third()).toHaveTextContent('+1.500')
    expect(screen.getByTestId('tv-gap-mode')).toHaveTextContent('INT')
  })

  it('shows one banner at a time, queued by priority, and does not replay history', () => {
    push(ev({ type: 'best_lap', address: 1, lap_ms: 6500, previous_ms: null, overall: false }, 99)) // before mount
    render(<TvMode />)
    expect(screen.queryByTestId('tv-banner')).toBeNull()

    push(ev({ type: 'pit_entry', address: 1 }, 1))
    push(ev({ type: 'best_lap', address: 0, lap_ms: 6900, previous_ms: null, overall: true }, 2))
    push(ev({ type: 'position_change', address: 2, old_position: 3, new_position: 2, passed_address: 1, approximate: false }, 3))
    expect(screen.getAllByTestId('tv-banner')).toHaveLength(1)
    expect(screen.getByTestId('tv-banner')).toHaveTextContent('VER IN THE PITS')

    // the active banner finishes (visible time + exit), then the highest priority waiting one follows
    tick(3000 + EXIT_MS + 5)
    expect(screen.getAllByTestId('tv-banner')).toHaveLength(1)
    expect(screen.getByTestId('tv-banner')).toHaveAttribute('data-kind', 'fastest_lap')
    expect(screen.getByTestId('tv-banner')).toHaveTextContent('FUL')

    tick(5200 + EXIT_MS + 5)
    expect(screen.getByTestId('tv-banner')).toHaveTextContent('BLU ▲ P2')
  })

  it('announces a track record as a centre card and race-control changes', () => {
    render(<TvMode />)
    push(ev({ type: 'track_record', address: 0, lap_ms: 6800, layout: 'Default', previous_ms: 7000, previous_holder: null }, 1))
    expect(screen.getByTestId('tv-card')).toHaveAttribute('data-kind', 'track_record')
    expect(screen.getByTestId('tv-card')).toHaveTextContent('NEW TRACK RECORD')
  })

  it('shows the results card with the top 3 and their best laps when the race finishes', () => {
    render(<TvMode />)
    act(() =>
      useStore.setState({
        race: {
          ...running(),
          phase: 'finished',
          cars: cars.map((c) => ({ ...c, finished: true })),
        },
      }),
    )
    const card = screen.getByTestId('tv-card')
    expect(card).toHaveAttribute('data-kind', 'chequered')
    expect(card).toHaveTextContent('CHEQUERED FLAG')
    const results = within(screen.getByTestId('tv-results'))
    expect(results.getByText('FUL')).toBeInTheDocument()
    expect(results.getByText('BLU')).toBeInTheDocument()
    expect(results.getByText('6.900')).toBeInTheDocument()
    expect(screen.getByTestId('tv-wipe')).toBeInTheDocument()
    expect(screen.getByTestId('tv-confetti')).toBeInTheDocument()

    // it stays until the race state moves on, then leaves
    tick(120000)
    expect(screen.getByTestId('tv-card')).toBeInTheDocument()
    act(() => useStore.setState({ race: { ...raceState(), race_id: 1, phase: 'idle' } }))
    tick(EXIT_MS + 5)
    expect(screen.queryByTestId('tv-card')).toBeNull()
  })

  it('takes the reduced-motion path: flagged root, no wipe or particles', () => {
    mockMatchMedia(true)
    render(<TvMode />)
    expect(screen.getByTestId('tv-mode')).toHaveAttribute('data-motion', 'reduced')
    act(() => useStore.setState({ race: { ...running(), phase: 'finished' } }))
    expect(screen.getByTestId('tv-card')).toHaveAttribute('data-kind', 'chequered')
    expect(screen.queryByTestId('tv-wipe')).toBeNull()
    expect(screen.queryByTestId('tv-confetti')).toBeNull()
  })

  it('hides the controls after 3 s of calm and brings them back on mouse or key activity', () => {
    render(<TvMode />)
    const controls = screen.getByTestId('tv-controls')
    expect(controls).toHaveAttribute('data-active', 'true')
    tick(CONTROLS_HIDE_MS + 100)
    expect(controls).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('tv-mode')).toHaveAttribute('data-active', 'false')
    // still in the DOM and focusable: no display/visibility hiding
    expect(within(controls).getByRole('link')).toBeInTheDocument()
    act(() => void fireEvent.mouseMove(window))
    expect(controls).toHaveAttribute('data-active', 'true')
    tick(CONTROLS_HIDE_MS + 100)
    expect(controls).toHaveAttribute('data-active', 'false')
    act(() => void fireEvent.keyDown(window, { key: 'Tab' }))
    expect(controls).toHaveAttribute('data-active', 'true')
  })

  it('keeps the controls while focus is inside them', () => {
    render(<TvMode />)
    const btn = screen.getByTestId('tv-effects')
    act(() => btn.focus())
    tick(CONTROLS_HIDE_MS * 2)
    expect(screen.getByTestId('tv-controls')).toHaveAttribute('data-active', 'true')
    act(() => btn.blur())
    tick(CONTROLS_HIDE_MS + 100)
    expect(screen.getByTestId('tv-controls')).toHaveAttribute('data-active', 'false')
  })

  it('uses full motion by default', () => {
    render(<TvMode />)
    expect(screen.getByTestId('tv-mode')).toHaveAttribute('data-motion', 'full')
  })

  it('shows the standby screen when idle and the start lights while starting', () => {
    act(() => useStore.setState({ race: raceState({ phase: 'idle' }) }))
    const { rerender } = render(<TvMode />)
    expect(screen.getByTestId('tv-standby')).toBeInTheDocument()
    act(() => useStore.setState({ race: { ...running(), phase: 'starting', start_light: 4 } }))
    rerender(<TvMode />)
    expect(screen.queryByTestId('tv-standby')).toBeNull()
    const lights = screen.getByTestId('tv-lights')
    expect(lights.querySelectorAll('[data-on="true"]')).toHaveLength(3)
    act(() => useStore.setState({ race: { ...running(), phase: 'starting', start_light: 8 } }))
    expect(screen.getByTestId('tv-lights')).toHaveAttribute('data-false', 'true')
  })

  it('holds a GO wipe after the lights go out', () => {
    act(() => useStore.setState({ race: { ...running(), phase: 'starting', start_light: 6 } }))
    render(<TvMode />)
    act(() => useStore.setState({ race: { ...running(), phase: 'running', start_light: 7 } }))
    expect(screen.getByTestId('tv-lights-label')).toHaveTextContent('GO')
    tick(1900)
    expect(screen.getByTestId('tv-lights')).toBeInTheDocument()
  })

  it('shows the latest commentary line as a caption, hidden when muted', () => {
    render(<TvMode />)
    expect(screen.queryByTestId('tv-commentary')).toBeNull()
    act(() => useStore.setState({ commentary: [line('Fulmine takes the lead')] }))
    tick(2000) // typewriter
    expect(screen.getByTestId('tv-commentary')).toHaveTextContent('Fulmine takes the lead')
    act(() => useStore.setState({ muted: true }))
    expect(screen.queryByTestId('tv-commentary')).toBeNull()
  })
})
