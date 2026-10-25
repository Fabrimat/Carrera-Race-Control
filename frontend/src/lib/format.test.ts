import { describe, expect, it } from 'vitest'
import { formatClock, formatGap, formatLapTime } from './format'

describe('formatLapTime', () => {
  it('formats under a minute as s.mmm', () => {
    expect(formatLapTime(7342)).toBe('7.342')
    expect(formatLapTime(59999)).toBe('59.999')
    expect(formatLapTime(500)).toBe('0.500')
  })
  it('formats above a minute as m:ss.mmm', () => {
    expect(formatLapTime(72340)).toBe('1:12.340')
    expect(formatLapTime(60000)).toBe('1:00.000')
    expect(formatLapTime(605007)).toBe('10:05.007')
  })
  it('uses a decimal comma in Italian', () => {
    expect(formatLapTime(7342, 'it')).toBe('7,342')
    expect(formatLapTime(72340, 'it')).toBe('1:12,340')
  })
  it('handles null', () => {
    expect(formatLapTime(null)).toBe('–')
  })
})

describe('formatGap / formatClock', () => {
  it('prefixes gaps with +', () => {
    expect(formatGap(1234)).toBe('+1.234')
    expect(formatGap(1234, 'it')).toBe('+1,234')
  })
  it('formats the race clock', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(75_900)).toBe('1:15')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})
