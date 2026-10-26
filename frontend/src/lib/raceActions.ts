import { api } from './api'
import { useStore } from './store'
import type { RaceConfig, RaceMode, RaceState } from './types'

// Race-control logic shared by the dashboard buttons (RaceControls) and the keyboard shortcuts.

export const RACE_MODES: RaceMode[] = ['practice', 'laps', 'timed']
const DURATION_STEP_S = 30

export function isRaceActive(race: RaceState): boolean {
  return race.phase === 'starting' || race.phase === 'running' || race.phase === 'paused'
}

/**
 * The config a race would start with: the live one while racing or during an event session,
 * else the backend config with the saved defaults and the unsaved edits on top.
 */
export function effectiveRaceConfig(
  race: RaceState,
  defaults: RaceConfig | undefined,
  override: Partial<RaceConfig>,
): RaceConfig {
  return isRaceActive(race) || race.session ? race.config : { ...race.config, ...defaults, ...override }
}

/** Start a race exactly like the Start button: no body during an event session. */
export function startRace(): Promise<RaceState> {
  const s = useStore.getState()
  if (s.race.session) return api.startRace()
  return api.startRace(effectiveRaceConfig(s.race, s.settings?.race, s.raceOverride))
}

/** The mode / laps / duration inputs are editable (idle, no event session). */
export function canEditRaceConfig(race: RaceState): boolean {
  return !isRaceActive(race) && !race.session
}

export function cycleRaceMode(): void {
  const s = useStore.getState()
  if (!canEditRaceConfig(s.race)) return
  const cfg = effectiveRaceConfig(s.race, s.settings?.race, s.raceOverride)
  const next = RACE_MODES[(RACE_MODES.indexOf(cfg.mode) + 1) % RACE_MODES.length]
  s.setRaceOverride({ mode: next })
}

/** Laps +/-1 in laps mode, duration +/-30 s in timed mode; nothing in practice. */
export function adjustRaceAmount(direction: 1 | -1): void {
  const s = useStore.getState()
  if (!canEditRaceConfig(s.race)) return
  const cfg = effectiveRaceConfig(s.race, s.settings?.race, s.raceOverride)
  if (cfg.mode === 'laps') {
    s.setRaceOverride({ target_laps: Math.min(999, Math.max(1, cfg.target_laps + direction)) })
  } else if (cfg.mode === 'timed') {
    s.setRaceOverride({ duration_s: Math.max(10, cfg.duration_s + direction * DURATION_STEP_S) })
  }
}
