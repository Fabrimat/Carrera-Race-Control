import { create } from 'zustand'
import { detectLanguage, translate, type Params, type TKey } from '../i18n'
import type {
  CommentaryLine,
  ConnectionInfo,
  Driver,
  EventState,
  Language,
  RaceConfig,
  RaceEvent,
  RaceState,
  SettingsResponse,
  WsMessage,
} from './types'

export type WsStatus = 'connecting' | 'open' | 'offline'

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

export const MAX_COMMENTARY = 50
const MAX_EVENTS = 100

export const emptyRace: RaceState = {
  race_id: null,
  phase: 'idle',
  config: {
    mode: 'practice',
    target_laps: 10,
    duration_s: 300,
    min_lap_ms: 2000,
    max_lap_ms: 120000,
    low_fuel_threshold: 3,
    idle_after_s: 30,
    incidents: { detect: true, overdue_factor: 2.5, auto_pace_car: false, penalty_s: 0 },
    pits: { min_stops: 0, missed_penalty_s: 30 },
  },
  start_light: 0,
  race_time_ms: 0,
  remaining_ms: null,
  remaining_laps: null,
  fuel_mode: false,
  pit_lane: false,
  cars: [],
  best_lap: null,
  track_record: null,
  layout: 'default',
  num_sectors: 1,
  best_sectors: [],
  session: null,
  pairing: null,
}

export const emptyConnection: ConnectionInfo = {
  status: 'disconnected',
  mode: 'simulator',
  address: null,
  error: null,
  error_code: null,
}

/** Server-driven slice of the store, updated by WebSocket messages. */
export interface LiveState {
  connection: ConnectionInfo
  race: RaceState
  commentary: CommentaryLine[]
  events: RaceEvent[]
  muted: boolean
  stoppedLineId: string | null
  // Event mode: controller address (as string) -> driver id, kept in sync by `driver_assigned`.
  assignments: Record<string, string>
  armedDriverId: string | null
  armedUntil: string | null
  /** The latest `driver_assigned` event, for "assigned by crossing" feedback. */
  lastAssignment: { address: number; driver_id: string; driver_name: string; method: string; at: string } | null
}

export interface AppState extends LiveState {
  ws: WsStatus
  settings: SettingsResponse | null
  language: Language
  toasts: Toast[]
  /** Mode / laps / duration edited before the start (dashboard controls and shortcuts). */
  raceOverride: Partial<RaceConfig>
  setRaceOverride: (patch: Partial<RaceConfig>) => void
  /** The `?` shortcut help overlay. */
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  drivers: Driver[]
  setDrivers: (d: Driver[]) => void
  setEventState: (e: EventState) => void
  setAssignments: (a: Record<string, string>) => void
  setArmed: (driverId: string | null, until: string | null) => void
  setWs: (s: WsStatus) => void
  applyMessage: (m: WsMessage) => void
  setSettings: (s: SettingsResponse) => void
  setMuted: (m: boolean) => void
  setConnection: (c: ConnectionInfo) => void
  setRace: (r: RaceState) => void
  pushToast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
}

/** Pure reducer for WebSocket messages: returns the changed slice of LiveState. */
export function reduceMessage(s: LiveState, m: WsMessage): Partial<LiveState> {
  switch (m.type) {
    case 'snapshot':
      return {
        connection: m.data.connection,
        race: m.data.race,
        commentary: m.data.commentary.slice(-MAX_COMMENTARY),
        muted: m.data.muted,
      }
    case 'state':
      return { race: m.data }
    case 'connection':
      return { connection: m.data }
    case 'event': {
      const events = [...s.events, m.data].slice(-MAX_EVENTS)
      if (m.data.type !== 'driver_assigned') return { events }
      const e = m.data
      return {
        events,
        assignments: assignDriver(s.assignments, e.address, e.driver_id, e.method === 'crossing'),
        armedDriverId: e.method === 'crossing' ? null : s.armedDriverId,
        armedUntil: e.method === 'crossing' ? null : s.armedUntil,
        lastAssignment: {
          address: e.address,
          driver_id: e.driver_id,
          driver_name: e.driver_name,
          method: e.method,
          at: e.at,
        },
      }
    }
    case 'commentary':
      if (s.commentary.some((l) => l.id === m.data.id)) return {}
      return { commentary: [...s.commentary, m.data].slice(-MAX_COMMENTARY) }
    case 'commentary_stop':
      return { stoppedLineId: m.data.id }
    case 'muted':
      return { muted: m.data.muted }
  }
}

/** Assign a driver to an address; a crossing moves the driver, so drop it from other cars. */
function assignDriver(
  current: Record<string, string>,
  address: number,
  driverId: string,
  moves: boolean,
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(current)) if (!(moves && v === driverId)) next[k] = v
  next[String(address)] = driverId
  return next
}

let toastSeq = 0

export const useStore = create<AppState>((set, get) => ({
  connection: emptyConnection,
  race: emptyRace,
  commentary: [],
  events: [],
  muted: false,
  stoppedLineId: null,
  assignments: {},
  armedDriverId: null,
  armedUntil: null,
  lastAssignment: null,
  drivers: [],
  setDrivers: (drivers) => set({ drivers }),
  setEventState: (e) => set({ assignments: e.assignments, armedDriverId: e.armed_driver_id, armedUntil: e.armed_until }),
  setAssignments: (assignments) => set({ assignments }),
  setArmed: (armedDriverId, armedUntil) => set({ armedDriverId, armedUntil }),
  ws: 'connecting',
  settings: null,
  language: detectLanguage(),
  toasts: [],
  raceOverride: {},
  setRaceOverride: (patch) => set((s) => ({ raceOverride: { ...s.raceOverride, ...patch } })),
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setWs: (ws) => set({ ws }),
  applyMessage: (m) => set((s) => reduceMessage(s, m)),
  setSettings: (settings) => set({ settings, language: settings.ui_language }),
  setMuted: (muted) => set({ muted }),
  setConnection: (connection) => set({ connection }),
  setRace: (race) => set({ race }),
  pushToast: (message, kind = 'error') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, message }] }))
    setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Translate outside React using the current UI language. */
export function tNow(key: TKey, params?: Params): string {
  return translate(useStore.getState().language, key, params)
}
