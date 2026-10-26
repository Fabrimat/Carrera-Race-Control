import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ChartPanel } from './ChartPanel'
import { fuelRows } from './FuelChart'
import { useFuelToasts } from '../lib/useFuelToasts'
import { useStore } from '../lib/store'
import { car, raceState } from '../test/fixtures'
import type { RaceEvent, RaceState } from '../lib/types'

const strategy = (over = {}) => ({ per_lap: 1.5, laps_left: 4, laps_to_go: 6, must_pit: false, pit_by_lap: null, ...over })

function fuelRace(): RaceState {
  const base = raceState()
  return {
    ...base,
    fuel_mode: true,
    config: { ...base.config, pits: { min_stops: 1, missed_penalty_s: 30 } },
    cars: [
      car({ address: 0, name: 'Rosso', position: 1, laps: 4, fuel: 12, fuel_strategy: strategy({ laps_left: 8, laps_to_go: 6 }), fuel_laps: [15, 14, 13, 12] }),
      car({ address: 1, name: 'Blu', position: 2, laps: 4, fuel: 6, pit_stops: 1, fuel_strategy: strategy({ laps_left: 4, must_pit: true, pit_by_lap: 8 }), fuel_laps: [15, 12, 9, null] }),
      car({ address: 2, name: 'Verde', position: 3, laps: 1, fuel: 5, in_pit: true }),
    ],
  }
}

describe('ChartPanel', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))
  afterEach(cleanup)

  it('is just the lap chart without fuel mode (no tabs)', () => {
    render(<ChartPanel race={raceState()} />)
    expect(screen.getByRole('region', { name: 'Lap times' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('offers the strategy view in fuel mode with bars, laps left and the pit warning', () => {
    render(<ChartPanel race={fuelRace()} />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Lap times', 'Fuel strategy', 'Fuel chart'])
    fireEvent.click(screen.getByTestId('chart-tab-strategy'))
    const rows = screen.getAllByTestId('fuel-row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]).getByTestId('fuel-laps-left')).toHaveTextContent('8.0')
    expect(within(rows[0]).getByRole('meter')).toHaveAttribute('aria-valuenow', '12')
    expect(rows[0]).toHaveAttribute('data-must-pit', 'false')
    expect(rows[1]).toHaveAttribute('data-must-pit', 'true')
    expect(within(rows[1]).getByTestId('must-pit')).toHaveTextContent('Pit by lap 8')
    expect(within(rows[1]).getByText('Stops 1/1')).toBeInTheDocument()
    expect(within(rows[2]).getByText('In the pits')).toBeInTheDocument()
    expect(within(rows[2]).queryByTestId('must-pit')).toBeNull()
  })

  it('translates the strategy view', () => {
    useStore.setState({ language: 'it' })
    render(<ChartPanel race={fuelRace()} />)
    fireEvent.click(screen.getByTestId('chart-tab-strategy'))
    expect(screen.getByTestId('must-pit')).toHaveTextContent('Box entro il giro 8')
  })

  it('falls back to the lap chart when fuel mode turns off', () => {
    const { rerender } = render(<ChartPanel race={fuelRace()} />)
    fireEvent.click(screen.getByTestId('chart-tab-strategy'))
    rerender(<ChartPanel race={{ ...fuelRace(), fuel_mode: false }} />)
    expect(screen.queryByTestId('fuel-strategy')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('builds the fuel chart rows from fuel_laps, skipping unknown levels', () => {
    const rows = fuelRows(fuelRace().cars)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ lap: 1, c0: 15, c1: 15 })
    expect(rows[3]).toEqual({ lap: 4, c0: 12 })
  })
})

function Probe() {
  useFuelToasts()
  return null
}

describe('pit_missed toast', () => {
  beforeEach(() => useStore.setState({ language: 'en', race: fuelRace(), events: [], toasts: [] }))
  afterEach(cleanup)

  it('toasts each new pit_missed event once and ignores the history at mount', () => {
    const old = { type: 'pit_missed', at: 'o', race_time_ms: 0, address: 0, stops: 0, required: 1, penalty_ms: 30000 } as RaceEvent
    useStore.setState({ events: [old] })
    render(<Probe />)
    expect(useStore.getState().toasts).toHaveLength(0)
    const fresh = { type: 'pit_missed', at: 'n', race_time_ms: 1, address: 1, stops: 0, required: 2, penalty_ms: 60000 } as RaceEvent
    act(() => useStore.setState((s) => ({ events: [...s.events, fresh] })))
    act(() => useStore.setState((s) => ({ events: [...s.events] })))
    const toasts = useStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Blu: 0 of 2 mandatory pit stops, +60 s')
  })
})
