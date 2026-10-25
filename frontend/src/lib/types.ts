// Mirrors backend/app/race/models.py and docs/PROTOCOL.md. Times are integer ms.

export type Language = 'en' | 'it'
export type RaceMode = 'practice' | 'laps' | 'timed'
export type RacePhase = 'idle' | 'starting' | 'running' | 'paused' | 'finished'
export type Verbosity = 'low' | 'normal' | 'high'
export type CommentaryPriority = 'low' | 'normal' | 'high'
export type TrackMode = 'simulator' | 'ble' | 'serial'

export interface RaceConfig {
  mode: RaceMode
  target_laps: number
  duration_s: number
  min_lap_ms: number
  max_lap_ms: number
  low_fuel_threshold: number
  idle_after_s: number
}

export interface CarConfig {
  address: number
  name: string
  color: string
  nickname: string | null
}

export interface Lap {
  address: number
  lap_number: number
  lap_ms: number
  race_time_ms: number
  valid: boolean
}

export interface CarState {
  address: number
  name: string
  color: string
  laps: number
  last_lap_ms: number | null
  best_lap_ms: number | null
  avg_lap_ms: number | null
  total_time_ms: number | null
  position: number | null
  gap_to_leader_ms: number | null
  gap_to_leader_laps: number
  gap_to_ahead_ms: number | null
  fuel: number | null
  in_pit: boolean
  pit_stops: number
  finished: boolean
  lap_times: number[]
}

export interface BestLapRecord {
  address: number
  lap_ms: number
  lap_number: number
}

export interface TrackRecordInfo {
  layout: string
  lap_ms: number
  address: number
  holder_name: string
  race_id: number | null
  set_at: string
}

export interface RaceState {
  race_id: number | null
  phase: RacePhase
  config: RaceConfig
  start_light: number
  race_time_ms: number
  remaining_ms: number | null
  remaining_laps: number | null
  fuel_mode: boolean
  pit_lane: boolean
  cars: CarState[]
  best_lap: BestLapRecord | null
  track_record: TrackRecordInfo | null
}

// ------------------------------------------------------------------ events

interface EventBase {
  at: string
  race_time_ms: number
}
export type RaceEvent =
  | (EventBase & { type: 'race_started'; mode: RaceMode; addresses: number[] })
  | (EventBase & {
      type: 'lap_completed'
      address: number
      lap_number: number
      lap_ms: number
      position: number | null
      valid: boolean
    })
  | (EventBase & {
      type: 'best_lap'
      address: number
      lap_ms: number
      previous_ms: number | null
      overall: boolean
    })
  | (EventBase & {
      type: 'position_change'
      address: number
      old_position: number
      new_position: number
      passed_address: number | null
      approximate: boolean
    })
  | (EventBase & { type: 'pit_entry'; address: number })
  | (EventBase & {
      type: 'pit_exit'
      address: number
      duration_ms: number | null
      fuel: number | null
    })
  | (EventBase & { type: 'low_fuel'; address: number; fuel: number })
  | (EventBase & { type: 'race_finished'; winner: number | null; order: number[] })
  | (EventBase & { type: 'idle'; seconds: number })
  | (EventBase & {
      type: 'track_record'
      address: number
      lap_ms: number
      layout: string
      previous_ms: number | null
      previous_holder: string | null
    })

export interface CommentaryLine {
  id: string
  text: string
  priority: CommentaryPriority
  event_type: string
  at: string
  source: 'template' | 'llm'
  audio_url: string | null
}

// ------------------------------------------------------------------ settings

export interface CommentarySettings {
  enabled: boolean
  language: Language
  voice_id: string | null
  verbosity: Verbosity
  tts_enabled: boolean
  llm_enabled: boolean
  audio_output: 'browser' | 'local'
  session_char_budget: number
  monthly_char_budget: number
}

export interface TrackSettings {
  mode: TrackMode
  address: string | null
  layout: string
}

export interface Settings {
  ui_language: Language
  cars: CarConfig[]
  commentary: CommentarySettings
  track: TrackSettings
  race: RaceConfig
}

export interface SettingsResponse extends Settings {
  keys: { elevenlabs: boolean; anthropic: boolean }
}

// ------------------------------------------------------------------ REST shapes

export type ErrorCode =
  | 'busy'
  | 'not_found'
  | 'permission'
  | 'bluetooth_off'
  | 'timeout'
  | 'unknown'

export interface ConnectionInfo {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  mode: TrackMode
  address: string | null
  error: string | null
  error_code: ErrorCode | null
}

export interface Snapshot {
  connection: ConnectionInfo
  race: RaceState
  commentary: CommentaryLine[]
  muted: boolean
}

export interface ScanDevice {
  address: string
  name: string | null
  kind: 'ble' | 'serial'
}

export interface RaceSummary {
  id: number
  started_at: string
  finished_at: string | null
  mode: RaceMode
  winner_name: string | null
  laps: number
  best_lap_ms: number | null
}

// NOTE: PROTOCOL.md says RaceSummary & {laps: Lap[]}, but `laps` is a number in the summary;
// the backend overrides it with the lap list in the detail response.
export interface RaceDetail extends Omit<RaceSummary, 'laps'> {
  config: RaceConfig
  results: CarState[]
  laps: Lap[]
}

// ------------------------------------------------------------------ WebSocket

export type WsMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'state'; data: RaceState }
  | { type: 'connection'; data: ConnectionInfo }
  | { type: 'event'; data: RaceEvent }
  | { type: 'commentary'; data: CommentaryLine }
  | { type: 'commentary_stop'; data: { id: string } }
  | { type: 'muted'; data: { muted: boolean } }
