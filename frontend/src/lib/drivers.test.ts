import { describe, expect, it } from 'vitest'
import {
  carSlots,
  crossingState,
  displayName,
  filterDrivers,
  initials,
  pushRecent,
  resolveTranscript,
} from './drivers'
import type { Driver } from './types'

const d = (id: string, name: string, nickname: string | null = null): Driver => ({
  id,
  name,
  nickname,
  bio: '',
  has_photo: false,
  created_at: '2026-01-01T00:00:00Z',
})

const roster = [d('zoe', 'Zoë Rossi'), d('anna', 'Anna Bianchi', 'Nanni'), d('luca', 'Luca Verdi')]

describe('filterDrivers', () => {
  it('returns everyone alphabetically for an empty query', () => {
    expect(filterDrivers(roster, '').map((x) => x.id)).toEqual(['anna', 'luca', 'zoe'])
  })
  it('matches name or nickname, ignoring case and accents', () => {
    expect(filterDrivers(roster, 'zoe').map((x) => x.id)).toEqual(['zoe'])
    expect(filterDrivers(roster, 'NANN').map((x) => x.id)).toEqual(['anna'])
    expect(filterDrivers(roster, 'xyz')).toEqual([])
  })
  it('puts recent drivers first', () => {
    expect(filterDrivers(roster, '', ['zoe', 'luca']).map((x) => x.id)).toEqual(['zoe', 'luca', 'anna'])
  })
})

describe('recent list', () => {
  it('moves to front without duplicates', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })
})

describe('resolveTranscript', () => {
  it('preselects the name_guess driver', () => {
    const r = resolveTranscript('Anna', 'anna', roster)
    expect(r.kind === 'match' && r.driver.id).toBe('anna')
  })
  it('offers to create the heard text when there is no match', () => {
    expect(resolveTranscript(' Marco. ', null, roster)).toEqual({ kind: 'create', name: 'Marco' })
    expect(resolveTranscript('Marco', 'ghost', roster)).toEqual({ kind: 'create', name: 'Marco' })
  })
  it('is empty for blank text', () => {
    expect(resolveTranscript('  ', null, roster)).toEqual({ kind: 'empty' })
  })
})

describe('crossingState', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  it('counts down in whole seconds, rounding up', () => {
    expect(crossingState('2026-01-01T00:00:59.200Z', now)).toEqual({ status: 'armed', seconds: 60 })
    expect(crossingState('2026-01-01T00:00:01Z', now)).toEqual({ status: 'armed', seconds: 1 })
  })
  it('treats a zone-less timestamp as UTC', () => {
    expect(crossingState('2026-01-01T00:00:10', now)).toEqual({ status: 'armed', seconds: 10 })
  })
  it('expires and idles', () => {
    expect(crossingState('2025-12-31T23:59:59Z', now)).toEqual({ status: 'expired' })
    expect(crossingState(null, now)).toEqual({ status: 'idle' })
  })
})

describe('names', () => {
  it('displayName falls back to the car name', () => {
    expect(displayName({ name: 'Car 1', driver_name: 'Anna' })).toBe('Anna')
    expect(displayName({ name: 'Car 1', driver_name: null })).toBe('Car 1')
  })
  it('initials', () => {
    expect(initials('Anna Maria Bianchi')).toBe('AB')
    expect(initials('luca')).toBe('LU')
    expect(initials('')).toBe('?')
  })
  it('carSlots always yields six controllers', () => {
    const s = carSlots([{ address: 1, name: 'Red', color: '#f00' }])
    expect(s.map((x) => x.address)).toEqual([0, 1, 2, 3, 4, 5])
    expect(s[1].name).toBe('Red')
    expect(s[0].name).toBe('Car 1')
  })
})
