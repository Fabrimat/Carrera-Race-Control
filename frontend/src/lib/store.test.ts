import { beforeEach, describe, expect, it } from 'vitest'
import { dispatchMessage } from './ws'
import { emptyConnection, emptyRace, reduceMessage, useStore, type LiveState } from './store'
import { raceState } from '../test/fixtures'
import type { CommentaryLine, SettingsResponse } from './types'

const line = (id: string): CommentaryLine => ({
  id,
  text: `line ${id}`,
  priority: 'normal',
  event_type: 'lap_completed',
  at: '2026-01-01T00:00:00Z',
  source: 'template',
  audio_url: null,
})

const base = (): LiveState => ({
  connection: emptyConnection,
  race: emptyRace,
  commentary: [],
  events: [],
  muted: false,
  stoppedLineId: null,
})

describe('reduceMessage', () => {
  it('applies a snapshot', () => {
    const race = raceState({ phase: 'running' })
    const out = reduceMessage(base(), {
      type: 'snapshot',
      data: {
        connection: { ...emptyConnection, status: 'connected' },
        race,
        commentary: [line('a'), line('b')],
        muted: true,
      },
    })
    expect(out.race?.phase).toBe('running')
    expect(out.connection?.status).toBe('connected')
    expect(out.commentary?.map((l) => l.id)).toEqual(['a', 'b'])
    expect(out.muted).toBe(true)
  })

  it('replaces race on state and connection on connection', () => {
    expect(reduceMessage(base(), { type: 'state', data: raceState({ race_time_ms: 5 }) }).race?.race_time_ms).toBe(5)
    const c = { ...emptyConnection, status: 'error' as const, error_code: 'busy' as const }
    expect(reduceMessage(base(), { type: 'connection', data: c }).connection?.error_code).toBe('busy')
  })

  it('appends commentary without duplicates and caps at 50', () => {
    let s = base()
    s = { ...s, ...reduceMessage(s, { type: 'commentary', data: line('1') }) }
    s = { ...s, ...reduceMessage(s, { type: 'commentary', data: line('1') }) }
    expect(s.commentary).toHaveLength(1)
    for (let i = 2; i < 80; i++) s = { ...s, ...reduceMessage(s, { type: 'commentary', data: line(String(i)) }) }
    expect(s.commentary).toHaveLength(50)
    expect(s.commentary[49].id).toBe('79')
  })

  it('records stop and muted messages', () => {
    expect(reduceMessage(base(), { type: 'commentary_stop', data: { id: 'x' } }).stoppedLineId).toBe('x')
    expect(reduceMessage(base(), { type: 'muted', data: { muted: true } }).muted).toBe(true)
  })

  it('collects events', () => {
    const out = reduceMessage(base(), {
      type: 'event',
      data: { type: 'pit_entry', address: 1, at: 'x', race_time_ms: 1 },
    })
    expect(out.events).toHaveLength(1)
  })
})

describe('store via dispatchMessage', () => {
  beforeEach(() => {
    useStore.setState({ ...base(), settings: null })
  })

  it('updates the store from a commentary message', () => {
    dispatchMessage({ type: 'commentary', data: line('z') })
    expect(useStore.getState().commentary.map((l) => l.id)).toEqual(['z'])
  })

  it('setSettings switches the UI language', () => {
    const settings = { ui_language: 'it', keys: { elevenlabs: false, anthropic: false } } as SettingsResponse
    useStore.getState().setSettings(settings)
    expect(useStore.getState().language).toBe('it')
  })
})
