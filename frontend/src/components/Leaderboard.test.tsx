import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Leaderboard } from './Leaderboard'
import { useStore } from '../lib/store'
import { car } from '../test/fixtures'

const cars = [
  car({ address: 2, name: 'Verde', position: 3, laps: 4, best_lap_ms: 7100, last_lap_ms: 7400, gap_to_leader_laps: 1, in_pit: true, fuel: 2 }),
  car({ address: 0, name: 'Rosso', position: 1, laps: 5, best_lap_ms: 6900, last_lap_ms: 7000 }),
  car({ address: 1, name: 'Blu', position: 2, laps: 5, best_lap_ms: 7000, last_lap_ms: 72340, gap_to_leader_ms: 1234 }),
  car({ address: 3, name: 'Giallo' }),
]

describe('Leaderboard', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))

  it('renders rows sorted by position, unplaced last', () => {
    render(<Leaderboard cars={cars} bestLap={{ address: 0, lap_ms: 6900, lap_number: 3 }} fuelMode />)
    const rows = screen.getAllByTestId('leaderboard-row')
    expect(rows.map((r) => within(r).getByText(/Rosso|Blu|Verde|Giallo/).textContent)).toEqual([
      'Rosso',
      'Blu',
      'Verde',
      'Giallo',
    ])
  })

  it('marks the overall best lap purple only on its owner', () => {
    render(<Leaderboard cars={cars} bestLap={{ address: 0, lap_ms: 6900, lap_number: 3 }} fuelMode={false} />)
    const best = screen.getAllByTestId('best-lap')
    expect(best[0]).toHaveAttribute('data-best', 'true')
    expect(best[0]).toHaveClass('text-purple')
    expect(best[1]).toHaveAttribute('data-best', 'false')
  })

  it('shows gaps: ms for same lap, laps when lapped', () => {
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} />)
    const gaps = screen.getAllByTestId('gap').map((g) => g.textContent)
    expect(gaps.slice(0, 3)).toEqual(['Leader', '+1.234', '+1 lap'])
  })

  it('shows the PIT badge and fuel bar only when applicable', () => {
    const { rerender } = render(<Leaderboard cars={cars} bestLap={null} fuelMode />)
    expect(screen.getAllByTestId('pit-badge')).toHaveLength(1)
    expect(screen.getAllByTestId('fuel-bar')).toHaveLength(1)
    rerender(<Leaderboard cars={cars} bestLap={null} fuelMode={false} />)
    expect(screen.queryByTestId('fuel-bar')).toBeNull()
  })

  it('formats lap times and pluralises lapped gaps in Italian', () => {
    useStore.setState({ language: 'it' })
    const lapped = [car({ address: 0, position: 1 }), car({ address: 1, position: 2, gap_to_leader_laps: 2, last_lap_ms: 72340 })]
    render(<Leaderboard cars={lapped} bestLap={null} fuelMode={false} />)
    expect(screen.getByText('+2 giri')).toBeInTheDocument()
    expect(screen.getByText('1:12,340')).toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Classifica' })).toBeInTheDocument()
  })
})
