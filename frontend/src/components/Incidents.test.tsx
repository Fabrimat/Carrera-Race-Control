import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Leaderboard } from './Leaderboard'
import { MarshalPanel } from './MarshalPanel'
import { TrackMap } from './TrackMap'
import { TvTower } from './tv/TvTower'
import { Dashboard } from '../pages/Dashboard'
import { api, ApiError } from '../lib/api'
import { apiErrorMessage } from '../lib/errors'
import { translate } from '../i18n'
import { bannerForEvent, type BannerContext } from '../lib/tvBanners'
import { formatElapsed, incidentPlace } from '../lib/incidents'
import { useStore } from '../lib/store'
import type { Incident, RaceEvent, TrackLayout } from '../lib/types'
import { car, raceState } from '../test/fixtures'

const incident = (over: Partial<Incident> = {}): Incident => ({
  started_race_ms: 10_000,
  source: 'overdue',
  from_sensor: 2,
  to_sensor: 3,
  s: 0.5,
  ...over,
})

describe('incident helpers', () => {
  const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate('en', k, p)
  it('describes the place and formats the elapsed time', () => {
    // Check Lanes 2 and 3 installed: 3 sectors
    expect(incidentPlace({ from_sensor: 1, to_sensor: 2 }, 3, t)).toBe('sector 1')
    expect(incidentPlace({ from_sensor: 2, to_sensor: 3 }, 3, t)).toBe('sector 2')
    expect(incidentPlace({ from_sensor: 3, to_sensor: 1 }, 3, t)).toBe('sector 3')
    // only sensor 3 installed: 2 sectors
    expect(incidentPlace({ from_sensor: 1, to_sensor: 3 }, 2, t)).toBe('sector 1')
    expect(incidentPlace({ from_sensor: 3, to_sensor: 1 }, 2, t)).toBe('sector 2')
    // unknown stretch or no Check Lanes
    expect(incidentPlace({ from_sensor: null, to_sensor: null }, 3, t)).toBe('near the line')
    expect(incidentPlace({ from_sensor: 1, to_sensor: 1 }, 1, t)).toBe('near the line')
    expect(formatElapsed(65_400)).toBe('1:05')
    expect(formatElapsed(-5)).toBe('0:00')
  })

  it('translates the incident error codes', () => {
    const t2 = (k: Parameters<typeof translate>[1]) => translate('it', k)
    expect(apiErrorMessage(new ApiError(409, null, 'race_not_running'), t2)).toBe('Nessuna gara in corso.')
    expect(apiErrorMessage(new ApiError(404, null, 'incident_not_found'), t2)).toContain('incidente')
  })
})

describe('MarshalPanel', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('is absent without incidents', () => {
    useStore.setState({ race: raceState({ phase: 'running', cars: [car({ address: 0 })] }) })
    render(<MarshalPanel />)
    expect(screen.queryByTestId('marshal-panel')).toBeNull()
  })

  it('lists cars off the track and clears one through the API', async () => {
    const clear = vi.spyOn(api, 'clearIncident').mockResolvedValue(raceState())
    useStore.setState({
      race: raceState({
        phase: 'running',
        num_sectors: 3,
        race_time_ms: 75_000,
        cars: [
          car({ address: 0, name: 'Fulmine' }),
          car({ address: 1, name: 'Saetta', driver_name: 'Anna', incident: incident() }),
        ],
      }),
    })
    render(<MarshalPanel />)
    const rows = screen.getAllByTestId('marshal-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Anna')
    expect(rows[0]).toHaveTextContent('sector 2')
    expect(within(rows[0]).getByTestId('marshal-elapsed')).toHaveTextContent(/off for 1:\d\d/)
    fireEvent.click(screen.getByRole('button', { name: 'Anna is back on track' }))
    await waitFor(() => expect(clear).toHaveBeenCalledWith(1))
  })

  it('disappears when the incident closes', () => {
    useStore.setState({
      race: raceState({ phase: 'running', cars: [car({ address: 0, incident: incident() })] }),
    })
    render(<MarshalPanel />)
    expect(screen.getByTestId('marshal-panel')).toBeInTheDocument()
    act(() => useStore.setState({ race: raceState({ phase: 'running', cars: [car({ address: 0 })] }) }))
    expect(screen.queryByTestId('marshal-panel')).toBeNull()
  })
})

describe('Leaderboard incidents', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })
  const props = { bestLap: null, fuelMode: false }

  it('shows the OFF badge and the incident count', () => {
    render(<Leaderboard {...props} cars={[car({ address: 0, incident: incident(), incidents: 2 })]} />)
    expect(screen.getByTestId('incident-badge')).toHaveTextContent('OFF')
    expect(screen.getByTestId('incident-count')).toHaveTextContent('2')
  })

  it('offers "report off" only when reportable, and calls the API', async () => {
    const report = vi.spyOn(api, 'reportIncident').mockResolvedValue(raceState())
    const cars = [car({ address: 0, name: 'Fulmine' })]
    const { rerender } = render(<Leaderboard {...props} cars={cars} />)
    expect(screen.queryByTestId('report-off')).toBeNull()
    rerender(<Leaderboard {...props} cars={cars} reportable />)
    fireEvent.click(screen.getByRole('button', { name: 'Report Fulmine off the track' }))
    await waitFor(() => expect(report).toHaveBeenCalledWith(0))
  })

  it('hides the action for a car already off', () => {
    render(<Leaderboard {...props} cars={[car({ address: 0, incident: incident() })]} reportable />)
    expect(screen.queryByTestId('report-off')).toBeNull()
  })

  it('tolerates results of old races without the new fields', () => {
    const old = car({ address: 0 }) as unknown as Record<string, unknown>
    delete old.incident
    delete old.incidents
    render(<Leaderboard {...props} cars={[old as unknown as ReturnType<typeof car>]} />)
    expect(screen.queryByTestId('incident-count')).toBeNull()
  })
})

describe('TrackMap OFF marker', () => {
  const layout: TrackLayout = {
    name: 'Default',
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    aspect: 1,
    sensors: [],
    pit_s: null,
    source: 'drawn',
    updated_at: '2026-01-01T00:00:00Z',
  }
  beforeEach(() => {
    useStore.setState({ language: 'en' })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('draws a marker only for cars with an open incident that has a place', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    useStore.setState({
      race: raceState({
        layout: 'Default',
        cars: [
          car({ address: 0, name: 'Fulmine', incident: incident({ s: 0.25 }) }),
          car({ address: 1, name: 'Saetta' }),
          car({ address: 2, name: 'Lampo', incident: incident({ s: null }) }),
        ],
      }),
    })
    render(<TrackMap />)
    const markers = await screen.findAllByTestId('incident-marker')
    expect(markers).toHaveLength(1)
    expect(markers[0]).toHaveAttribute('data-addr', '0')
    expect(markers[0]).toHaveTextContent('OFF')
    expect(markers[0]).toHaveAttribute('aria-label', 'Fulmine is off the track')
  })
})

describe('TV banners and tower', () => {
  const ctx: BannerContext = {
    cars: [car({ address: 0, name: 'Fulmine', color: '#e53935' })],
    codes: new Map([[0, 'FUL']]),
    t: (k, p) => translate('en', k, p),
    lap: (ms) => String(ms),
    numSectors: 3,
  }
  const started = (over: Record<string, unknown> = {}) =>
    ({
      type: 'incident_started',
      at: 'a',
      race_time_ms: 1,
      address: 0,
      source: 'overdue',
      from_sensor: 2,
      to_sensor: 3,
      s: 0.5,
      count: 1,
      penalty_ms: 0,
      ...over,
    }) as RaceEvent

  it('shows a yellow-flag banner with driver and place', () => {
    const b = bannerForEvent(started(), ctx)
    expect(b).toMatchObject({ kind: 'incident', layout: 'lower', title: 'YELLOW FLAG' })
    expect(b?.subtitle).toBe('Fulmine  sector 2')
    // no place when the stretch is unknown
    expect(bannerForEvent(started({ from_sensor: null, to_sensor: null }), ctx)?.subtitle).toBe('Fulmine')
  })

  it('shows a short back-on-track banner', () => {
    const e = { type: 'incident_cleared', at: 'b', race_time_ms: 2, address: 0, by: 'crossing', lost_ms: 9000 } as RaceEvent
    const b = bannerForEvent(e, ctx)
    expect(b).toMatchObject({ kind: 'incident_cleared', title: 'BACK ON TRACK', subtitle: 'Fulmine' })
    expect(b!.durationMs).toBeLessThan(bannerForEvent(started(), ctx)!.durationMs)
  })

  it('marks cars with an open incident in the tower', () => {
    useStore.setState({ language: 'en' })
    const race = raceState({
      phase: 'running',
      cars: [car({ address: 0, position: 1, incident: incident() }), car({ address: 1, position: 2 })],
    })
    render(<TvTower race={race} codes={new Map()} mode="gap" reduced />)
    expect(screen.getAllByTestId('tv-off')).toHaveLength(1)
  })
})

describe('Dashboard marshal call and toast', () => {
  beforeEach(() => {
    vi.spyOn(api, 'layout').mockRejectedValue(new ApiError(404, null, 'layout_not_found'))
    vi.spyOn(api, 'findLayout').mockResolvedValue(null)
    useStore.setState({ language: 'en', toasts: [], events: [], race: raceState({ phase: 'running', num_sectors: 3, cars: [car({ address: 0, name: 'Fulmine' })] }) })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('toasts a new incident_started with the place', () => {
    render(<Dashboard />)
    act(() =>
      useStore.getState().applyMessage({
        type: 'event',
        data: {
          type: 'incident_started',
          at: 'a',
          race_time_ms: 1,
          address: 0,
          source: 'overdue',
          from_sensor: 2,
          to_sensor: 3,
          s: 0.5,
          count: 1,
          penalty_ms: 0,
        },
      }),
    )
    expect(useStore.getState().toasts.map((x) => x.message)).toContain(
      'Fulmine is off the track (sector 2)',
    )
  })

  it('shows the marshal panel as an overlay that does not touch the grid', () => {
    useStore.setState({
      race: raceState({ phase: 'running', cars: [car({ address: 0, incident: incident() })] }),
    })
    render(<Dashboard />)
    const panel = screen.getByTestId('marshal-panel')
    expect(panel.className).toContain('absolute')
    expect(screen.getByTestId('dashboard')).toContainElement(panel)
    expect(screen.getByTestId('dashboard').className).toContain('relative')
  })
})
