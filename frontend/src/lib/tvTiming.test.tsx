import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { GAP_CYCLE_MS, nextGapMode, towerCell, useGapMode } from './tvTiming'
import { translate } from '../i18n'
import { formatGap } from './format'
import { car } from '../test/fixtures'

const t = (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('en', k, p)
const gap = (ms: number) => formatGap(ms, 'en')

describe('gap / interval cycling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('toggles every cycle and can be pinned', () => {
    expect(nextGapMode('gap')).toBe('interval')
    const { result, rerender } = renderHook(({ paused }) => useGapMode(GAP_CYCLE_MS, paused), {
      initialProps: { paused: false },
    })
    expect(result.current).toBe('gap')
    act(() => void vi.advanceTimersByTime(GAP_CYCLE_MS))
    expect(result.current).toBe('interval')
    act(() => void vi.advanceTimersByTime(GAP_CYCLE_MS))
    expect(result.current).toBe('gap')
    rerender({ paused: true })
    act(() => void vi.advanceTimersByTime(GAP_CYCLE_MS * 3))
    expect(result.current).toBe('gap')
  })
})

describe('towerCell', () => {
  const leader = car({ address: 0, position: 1 })
  const second = car({ address: 1, position: 2, gap_to_leader_ms: 2500, gap_to_ahead_ms: 2500 })
  const third = car({ address: 2, position: 3, gap_to_leader_ms: 4000, gap_to_ahead_ms: 1500 })
  const lapped = car({ address: 3, position: 4, gap_to_leader_laps: 1, gap_to_leader_ms: null, gap_to_ahead_ms: null })

  it('shows the leader label and gaps to the leader', () => {
    expect(towerCell(leader, 'gap', t, gap)).toEqual({ text: 'LEADER', kind: 'leader' })
    expect(towerCell(third, 'gap', t, gap)).toEqual({ text: '+4.000', kind: 'time' })
  })
  it('shows the interval to the car ahead in interval mode', () => {
    expect(towerCell(third, 'interval', t, gap)).toEqual({ text: '+1.500', kind: 'time' })
    expect(towerCell(second, 'interval', t, gap).text).toBe('+2.500')
  })
  it('shows laps for lapped cars', () => {
    expect(towerCell(lapped, 'gap', t, gap)).toEqual({ text: '+1 lap', kind: 'lapped' })
    expect(towerCell(lapped, 'interval', t, gap).kind).toBe('lapped')
  })
  it('falls back to a dash without data', () => {
    expect(towerCell(car({ address: 5, position: 5 }), 'gap', t, gap)).toEqual({ text: '–', kind: 'none' })
  })
})
