import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Leaderboard } from './Leaderboard'
import { describeEvent } from './EventLog'
import { translate } from '../i18n'
import { useStore } from '../lib/store'
import { car } from '../test/fixtures'

const cars = [
  car({
    address: 0,
    name: 'Rosso',
    position: 1,
    current_sectors: [2000, null, null],
    last_sectors: [2100, 2500, 2400],
    best_sectors: [2000, 2500, 2400],
  }),
  car({
    address: 1,
    name: 'Blu',
    position: 2,
    current_sectors: [2300, 2600, null],
    last_sectors: [2300, 2600, 2700],
    best_sectors: [2200, 2600, 2700],
  }),
]
const best = [1900, 2500, 2400]

describe('Leaderboard sector columns', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))

  it('adds no sector columns without Check Lanes', () => {
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} />)
    expect(screen.queryByTestId('sector-1')).toBeNull()
  })

  it('shows S1..Sn headers and one cell per sector per car', () => {
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} numSectors={3} bestSectors={best} />)
    for (const n of [1, 2, 3]) expect(screen.getByRole('columnheader', { name: `S${n}` })).toBeInTheDocument()
    const rows = screen.getAllByTestId('leaderboard-row')
    expect(within(rows[0]).getAllByTestId(/^sector-/)).toHaveLength(3)
  })

  it('colours purple (overall best) and green (personal best), live over last lap', () => {
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} numSectors={3} bestSectors={best} />)
    const [rosso, blu] = screen.getAllByTestId('leaderboard-row')
    // Rosso S1: live 2000 equals own best but not the overall 1900 -> green, live
    expect(within(rosso).getByTestId('sector-1')).toHaveAttribute('data-personal', 'true')
    expect(within(rosso).getByTestId('sector-1')).toHaveAttribute('data-live', 'true')
    // Rosso S2: no live value, last lap 2500 equals the overall best -> purple, dimmed source
    const s2 = within(rosso).getByTestId('sector-2')
    expect(s2).toHaveAttribute('data-overall', 'true')
    expect(s2).toHaveClass('text-purple')
    expect(s2).toHaveAttribute('data-live', 'false')
    // Blu S1 is neither
    const b1 = within(blu).getByTestId('sector-1')
    expect(b1).toHaveAttribute('data-overall', 'false')
    expect(b1).toHaveAttribute('data-personal', 'false')
  })

  it('shows a dash for a missed sector', () => {
    const c = [car({ address: 0, position: 1, current_sectors: [null, null], last_sectors: [2000, null] })]
    render(<Leaderboard cars={c} bestLap={null} fuelMode numSectors={2} bestSectors={[]} />)
    expect(screen.getByTestId('sector-2')).toHaveTextContent('–')
  })
})

describe('EventLog sector line', () => {
  it('describes sector_completed in en and it', () => {
    const e = {
      type: 'sector_completed',
      at: 't',
      address: 0,
      lap_number: 2,
      sector: 2,
      split_ms: 2500,
      personal_best: true,
      overall_best: false,
    } as never
    const lap = (ms: number) => `${ms}`
    const en = describeEvent(e, cars, (k, p) => translate('en', k, p), lap)
    const it = describeEvent(e, cars, (k, p) => translate('it', k, p), lap)
    expect(en).toContain('sector 2')
    expect(it).toContain('settore 2')
  })
})
