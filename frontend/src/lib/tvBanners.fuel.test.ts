import { describe, expect, it } from 'vitest'
import { bannerForEvent, type BannerContext } from './tvBanners'
import { translate } from '../i18n'
import { car } from '../test/fixtures'
import type { RaceEvent } from './types'

const ctx = (lang: 'en' | 'it'): BannerContext => ({
  cars: [car({ address: 0, name: 'Fulmine', color: '#e53935' })],
  codes: new Map([[0, 'FUL']]),
  t: (k, p) => translate(lang, k, p),
  lap: (ms) => `${ms}`,
})
const missed = (penalty_ms: number) =>
  ({ type: 'pit_missed', at: 'a', race_time_ms: 0, address: 0, stops: 0, required: 1, penalty_ms }) as RaceEvent

describe('pit_missed banner', () => {
  it('names the car and the penalty, in both languages', () => {
    expect(bannerForEvent(missed(30000), ctx('en'))).toMatchObject({
      kind: 'pit_missed',
      title: 'FUL MISSED PIT STOP',
      subtitle: '+30 s penalty',
      color: '#e53935',
    })
    expect(bannerForEvent(missed(30000), ctx('it'))?.title).toBe('FUL SOSTA SALTATA')
  })

  it('has no subtitle without a penalty', () => {
    expect(bannerForEvent(missed(0), ctx('en'))?.subtitle).toBeUndefined()
  })
})
