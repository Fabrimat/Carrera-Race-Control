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
  // Sector timing (Check Lanes), arrays of length RaceState.num_sectors.
  current_sectors: (number | null)[]
  last_sectors: (number | null)[]
  best_sectors: (number | null)[]
  last_crossing: Crossing | null
  segment_estimates: Record<string, number> // key "a>b", sensors 1 (line), 2, 3
  track_pos: TrackPosition | null
  // Event mode: the person driving this controller (else show the car name).
  driver_id: string | null
  driver_name: string | null
  penalty_ms: number
}

export interface Crossing {
  sensor: number // 1 = start/finish, 2 and 3 = Check Lanes
  race_time_ms: number
}

/** See backend/app/race/models.py TrackPosition and src/lib/geometry.ts estimateS. */
export interface TrackPosition {
  from_sensor: number
  to_sensor: number
  s_from: number
  s_to: number
  anchor_race_ms: number
  expected_ms: number | null
  in_pit: boolean
  confidence: 'measured' | 'estimated' | 'stale'
}

export interface LayoutSensor {
  sensor: number // 2 or 3
  s: number // fraction of the lap from the start/finish line
}

/** points: closed centre line in driving order, normalised 0..1, points[0] = start/finish. */
export interface TrackLayout {
  name: string
  points: [number, number][]
  aspect: number // width / height
  sensors: LayoutSensor[]
  pit_s: number | null
  source: 'drawn' | 'photo'
  updated_at: string
}

export interface LayoutDraft {
  layout: TrackLayout
  notes: string
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
  layout: string
  num_sectors: number
  best_sectors: (number | null)[]
  session: SessionInfo | null
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
  | (EventBase & {
      type: 'sector_completed'
      address: number
      lap_number: number
      sector: number
      split_ms: number
      personal_best: boolean
      overall_best: boolean
    })
  | (EventBase & {
      type: 'false_start'
      address: number | null
      action: 'ignore' | 'warn' | 'penalty' | 'restart'
      penalty_ms: number
    })
  | (EventBase & {
      type: 'driver_assigned'
      address: number
      driver_id: string
      driver_name: string
      method: 'manual' | 'crossing' | 'voice'
    })
  | (EventBase & {
      type: 'session_finished'
      session_id: string
      kind: SessionKind
      order: number[]
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
  llm_provider: 'anthropic' | 'openai'
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
  keys: { elevenlabs: boolean; anthropic: boolean; openai: boolean }
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


// ------------------------------------------------------------------ event mode

export type SessionKind = 'practice' | 'qualifying' | 'race'

export interface SessionInfo {
  program_id: string
  program_name: string
  session_id: string
  kind: SessionKind
  name: string
  index: number
  total: number
}

export interface Driver {
  id: string
  name: string
  nickname: string | null
  bio: string
  has_photo: boolean
  created_at: string
}

export interface FalseStartRule {
  action: 'ignore' | 'warn' | 'penalty' | 'restart'
  penalty_s: number
}

export interface SessionSpec {
  id: string
  kind: SessionKind
  name: string
  mode: RaceMode
  target_laps: number
  duration_s: number
  false_start: FalseStartRule
  grid_from: string | null
}

export interface CommentaryContext {
  event_name: string
  location: string
  sponsors: string[]
  tone: 'family' | 'enthusiastic' | 'technical' | 'ironic'
  notes: string
  avoid_words: string[]
}

export interface EventProgram {
  id: string
  name: string
  sessions: SessionSpec[]
  commentary: CommentaryContext
  updated_at: string
}

export interface ClassificationRow {
  position: number
  address: number
  driver_id: string | null
  name: string
  laps: number
  best_lap_ms: number | null
  total_time_ms: number | null
  penalty_ms: number
}

export interface SessionResult {
  session_id: string
  kind: SessionKind
  race_id: number | null
  finished_at: string
  classification: ClassificationRow[]
}

export interface EventState {
  program_id: string | null
  current_index: number
  assignments: Record<string, string> // address (as string key) -> driver id
  results: SessionResult[] // one per session_id (re-run replaces)
  armed_driver_id: string | null // "assign on next crossing"
  armed_until: string | null
}

export type ExportSection = 'settings' | 'drivers' | 'programs' | 'layouts' | 'records'

export interface ExportBundle {
  format: 'carrera-rms'
  version: number
  exported_at: string
  app_version: string
  settings?: Settings | null
  drivers?: Driver[] | null
  programs?: EventProgram[] | null
  layouts?: TrackLayout[] | null
  records?: TrackRecordInfo[] | null
}

export interface ImportReport {
  report: Record<string, { added: number; updated: number; removed: number }>
  applied: boolean
}
