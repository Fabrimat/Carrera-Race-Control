import { describe, expect, it } from 'vitest'
import { deriveDriverCodes } from './driverCodes'

const codes = (cars: { address: number; name: string; nickname?: string | null }[]) =>
  deriveDriverCodes(cars.map((c) => ({ nickname: null, ...c })))

describe('deriveDriverCodes', () => {
  it('uses the first three letters, uppercase', () => {
    const m = codes([{ address: 0, name: 'Fulmine' }, { address: 1, name: 'Verde' }])
    expect(m.get(0)).toBe('FUL')
    expect(m.get(1)).toBe('VER')
  })

  it('prefers the nickname and strips accents and symbols', () => {
    const m = codes([{ address: 0, name: 'Car 1', nickname: 'Ècco!' }])
    expect(m.get(0)).toBe('ECC')
  })

  it('keeps default numbered names distinct and readable', () => {
    const m = codes([
      { address: 0, name: 'Car 1' },
      { address: 1, name: 'Car 2' },
      { address: 2, name: 'Car 3' },
    ])
    expect([...m.values()]).toEqual(['CA1', 'CA2', 'CA3'])
  })

  it('is unique for colliding names', () => {
    const m = codes([
      { address: 0, name: 'Rosso' },
      { address: 1, name: 'Rossa' },
      { address: 2, name: 'Rosa' },
      { address: 3, name: 'Ross' },
    ])
    expect(new Set(m.values()).size).toBe(4)
    for (const v of m.values()) expect(v).toMatch(/^[A-Z0-9]{3}$/)
  })

  it('pads very short or empty names and stays unique', () => {
    const m = codes([
      { address: 0, name: 'A' },
      { address: 1, name: '' },
      { address: 2, name: '??' },
    ])
    expect(new Set(m.values()).size).toBe(3)
    for (const v of m.values()) expect(v).toHaveLength(3)
  })

  it('is deterministic regardless of input order', () => {
    const a = codes([{ address: 0, name: 'Rosso' }, { address: 1, name: 'Rossa' }])
    const b = codes([{ address: 1, name: 'Rossa' }, { address: 0, name: 'Rosso' }])
    expect(a.get(0)).toBe(b.get(0))
    expect(a.get(1)).toBe(b.get(1))
  })
})
