import { useEffect, useState } from 'react'
import type { TFunction } from '../i18n'
import type { CarState } from './types'

export type GapMode = 'gap' | 'interval'

/** Broadcasts alternate between "gap to leader" and "interval to the car ahead". */
export const GAP_CYCLE_MS = 10000

export function nextGapMode(m: GapMode): GapMode {
  return m === 'gap' ? 'interval' : 'gap'
}

/** Auto-cycling gap/interval mode. `paused` keeps the current mode (e.g. when the user pins it). */
export function useGapMode(intervalMs = GAP_CYCLE_MS, paused = false): GapMode {
  const [mode, setMode] = useState<GapMode>('gap')
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => setMode(nextGapMode), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, paused])
  return mode
}

export interface TowerCell {
  text: string
  /** `leader` renders the label style, `lapped` the "+N LAP" style, `time` a plain gap. */
  kind: 'leader' | 'lapped' | 'time' | 'none'
}

/** Gap or interval text for one timing-tower row. */
export function towerCell(
  car: CarState,
  mode: GapMode,
  t: TFunction,
  gap: (ms: number) => string,
): TowerCell {
  if (car.position === 1) return { text: t('tv.tower.leader'), kind: 'leader' }
  if (car.gap_to_leader_laps > 0 && (mode === 'gap' || car.gap_to_ahead_ms === null)) {
    return { text: t('gap.laps', { count: car.gap_to_leader_laps }), kind: 'lapped' }
  }
  const ms = mode === 'gap' ? car.gap_to_leader_ms : car.gap_to_ahead_ms
  if (ms === null) return { text: '–', kind: 'none' }
  return { text: gap(ms), kind: 'time' }
}
