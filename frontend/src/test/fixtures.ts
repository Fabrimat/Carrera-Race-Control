import { vi } from 'vitest'
import type { CarState, RaceState, Settings, SettingsResponse } from '../lib/types'
import { emptyRace } from '../lib/store'

export function settingsResponse(over: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    ui_language: 'en',
    cars: [
      { address: 0, name: 'Car 1', color: '#e53935', nickname: null },
      { address: 1, name: 'Car 2', color: '#1e88e5', nickname: null },
    ],
    commentary: {
      enabled: true,
      language: 'en',
      voice_id: null,
      verbosity: 'normal',
      tts_enabled: false,
      llm_enabled: false,
      llm_provider: 'anthropic',
      audio_output: 'browser',
      session_char_budget: 1000,
      monthly_char_budget: 10000,
    },
    track: { mode: 'simulator', address: null, layout: 'Default' },
    race: emptyRace.config,
    keys: { elevenlabs: false, anthropic: false, openai: false },
    ...over,
  }
}

/** Fake backend for PUT /api/settings: records bodies and echoes them back (with keys). */
export function fakeSettingsServer(initial: SettingsResponse, delayMs = 0) {
  const puts: Settings[] = []
  let server = initial
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Settings
    puts.push(body)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    server = { ...body, keys: initial.keys }
    return new Response(JSON.stringify(server), { status: 200 })
  })
  return { puts, fetchMock, current: () => server }
}

export function car(over: Partial<CarState> & { address: number }): CarState {
  return {
    name: `Auto ${over.address + 1}`,
    color: '#e53935',
    laps: 0,
    last_lap_ms: null,
    best_lap_ms: null,
    avg_lap_ms: null,
    total_time_ms: null,
    position: null,
    gap_to_leader_ms: null,
    gap_to_leader_laps: 0,
    gap_to_ahead_ms: null,
    fuel: null,
    in_pit: false,
    pit_stops: 0,
    finished: false,
    lap_times: [],
    current_sectors: [],
    last_sectors: [],
    best_sectors: [],
    last_crossing: null,
    segment_estimates: {},
    track_pos: null,
    ...over,
  }
}

export function raceState(over: Partial<RaceState> = {}): RaceState {
  return { ...emptyRace, ...over }
}
