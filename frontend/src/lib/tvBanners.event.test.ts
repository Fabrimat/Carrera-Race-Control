import { describe, expect, it } from 'vitest'
import { bannerForEvent, sessionResultBanner, type BannerContext } from './tvBanners'
import { translate } from '../i18n'
import { car } from '../test/fixtures'
import type { RaceEvent, SessionResult } from './types'

const ctx: BannerContext = {
  cars: [car({ address: 0, name: 'Fulmine', color: '#e53935' })],
  codes: new Map([[0, 'FUL']]),
  t: (k, p) => translate('en', k, p),
  lap: (ms) => (ms === null || ms === undefined ? '–' : `${ms}`),
}
const fs = (action: string, penalty_ms = 0) =>
  ({ type: 'false_start', at: 'a', race_time_ms: 0, address: 0, action, penalty_ms }) as RaceEvent

describe('event banners', () => {
  it('shows false starts by action, never for ignore', () => {
    expect(bannerForEvent(fs('ignore'), ctx)).toBeNull()
    expect(bannerForEvent(fs('warn'), ctx)).toMatchObject({ kind: 'false_start', subtitle: 'Fulmine' })
    expect(bannerForEvent(fs('penalty', 5000), ctx)?.subtitle).toBe('Fulmine  +5 s penalty')
    expect(bannerForEvent(fs('restart'), ctx)?.subtitle).toContain('restarting')
  })

  it('builds the session classification card with penalties', () => {
    const result: SessionResult = {
      session_id: 'q',
      kind: 'qualifying',
      race_id: 1,
      finished_at: 't',
      classification: [
        { position: 1, address: 0, driver_id: null, name: 'Anna', laps: 3, best_lap_ms: 7000, total_time_ms: null, penalty_ms: 5000 },
      ],
    }
    const b = sessionResultBanner(result, 'Qualifying', ctx)
    expect(b.layout).toBe('center')
    expect(b.durationMs).toBe(Infinity)
    expect(b.rows?.[0]).toMatchObject({ pos: 1, code: 'FUL', name: 'Anna', best: '7000', note: '+5s' })
  })
})
