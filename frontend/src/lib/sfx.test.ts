import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./sfx', () => ({ playSfx: vi.fn() }))

import { playSfx } from './sfx'
import { sfxForMessage } from './sfxTriggers'
import { dispatchMessage } from './ws'
import { emptyConnection, emptyRace, useStore } from './store'
import { raceState } from '../test/fixtures'
import type { RaceEvent, WsMessage } from './types'

const ev = (data: Partial<RaceEvent> & { type: RaceEvent['type'] }): WsMessage =>
  ({ type: 'event', data: { at: 'x', race_time_ms: 0, ...data } }) as WsMessage
const state = (over = {}): WsMessage => ({ type: 'state', data: raceState(over) })

describe('sfxForMessage', () => {
  const idle = raceState()

  it('beeps for each red light 2..6 and not for others', () => {
    for (let l = 2; l <= 6; l++) {
      expect(sfxForMessage(raceState({ start_light: l - 1 }), state({ start_light: l }))).toEqual(['light'])
    }
    expect(sfxForMessage(idle, state({ start_light: 1 }))).toEqual([])
    expect(sfxForMessage(idle, state({ start_light: 8 }))).toEqual([])
  })

  it('does not repeat a light on unchanged state ticks', () => {
    const prev = raceState({ start_light: 3, phase: 'starting' })
    expect(sfxForMessage(prev, state({ start_light: 3, phase: 'starting', race_time_ms: 5 }))).toEqual([])
  })

  it('plays go once, on light 7 or on the starting to running change', () => {
    const lit = raceState({ start_light: 6, phase: 'starting' })
    expect(sfxForMessage(lit, state({ start_light: 7, phase: 'starting' }))).toEqual(['go'])
    expect(sfxForMessage(lit, state({ start_light: 7, phase: 'running' }))).toEqual(['go'])
    expect(sfxForMessage(raceState({ start_light: 7, phase: 'starting' }), state({ start_light: 7, phase: 'running' }))).toEqual([])
    expect(sfxForMessage(lit, state({ start_light: 6, phase: 'running' }))).toEqual(['go'])
  })

  it('maps events', () => {
    expect(sfxForMessage(idle, ev({ type: 'best_lap', overall: true } as never))).toEqual(['best_lap'])
    expect(sfxForMessage(idle, ev({ type: 'best_lap', overall: false } as never))).toEqual([])
    expect(sfxForMessage(idle, ev({ type: 'track_record' } as never))).toEqual(['track_record'])
    expect(sfxForMessage(idle, ev({ type: 'race_finished' } as never))).toEqual(['finish'])
    expect(sfxForMessage(idle, ev({ type: 'pit_entry' } as never))).toEqual(['pit'])
    expect(sfxForMessage(idle, ev({ type: 'lap_completed' } as never))).toEqual([])
  })

  it('never plays for snapshots, commentary or mute', () => {
    const snap: WsMessage = {
      type: 'snapshot',
      data: { connection: emptyConnection, race: raceState({ start_light: 4, phase: 'starting' }), commentary: [], muted: false },
    }
    expect(sfxForMessage(idle, snap)).toEqual([])
    expect(sfxForMessage(idle, { type: 'muted', data: { muted: true } })).toEqual([])
  })
})

describe('dispatchMessage sound effects', () => {
  beforeEach(() => {
    vi.mocked(playSfx).mockClear()
    useStore.setState({ race: emptyRace, events: [], commentary: [], muted: false })
  })

  it('plays the effect for a live event', () => {
    dispatchMessage(ev({ type: 'track_record' } as never))
    expect(playSfx).toHaveBeenCalledExactlyOnceWith('track_record')
  })

  it('a snapshot resync replays nothing, and a following same-light state stays silent', () => {
    dispatchMessage(state({ start_light: 4, phase: 'starting' }))
    expect(playSfx).toHaveBeenCalledTimes(1)
    vi.mocked(playSfx).mockClear()
    // Reconnect: the snapshot carries the same light and the next state tick repeats it.
    dispatchMessage({
      type: 'snapshot',
      data: { connection: emptyConnection, race: raceState({ start_light: 4, phase: 'starting' }), commentary: [], muted: false },
    })
    dispatchMessage(state({ start_light: 4, phase: 'starting', race_time_ms: 10 }))
    expect(playSfx).not.toHaveBeenCalled()
  })
})
