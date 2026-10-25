import type { RaceState, WsMessage } from './types'

export type SfxName = 'light' | 'go' | 'best_lap' | 'track_record' | 'finish' | 'pit'

/**
 * Sound effects to play for a server message, given the race state held *before* the message
 * was applied. Pure, so it can be tested without audio.
 *
 * A `snapshot` (initial load or reconnect resync) never plays anything: it only replaces the
 * state, and since the caller passes the stored race as `prev`, the next `state` message is
 * compared against the snapshot rather than against stale pre-disconnect state. Events are
 * only ever delivered live, never replayed inside a snapshot.
 */
export function sfxForMessage(prev: RaceState, msg: WsMessage): SfxName[] {
  switch (msg.type) {
    case 'event': {
      const e = msg.data
      switch (e.type) {
        case 'best_lap':
          return e.overall ? ['best_lap'] : []
        case 'track_record':
          return ['track_record']
        case 'race_finished':
          return ['finish']
        case 'pit_entry':
          return ['pit']
        default:
          return []
      }
    }
    case 'state': {
      const next = msg.data
      const goNow =
        (next.start_light === 7 && prev.start_light !== 7) ||
        (prev.phase === 'starting' && next.phase === 'running' && prev.start_light !== 7)
      if (goNow) return ['go']
      if (next.start_light !== prev.start_light && next.start_light >= 2 && next.start_light <= 6) {
        return ['light']
      }
      return []
    }
    default:
      return []
  }
}
