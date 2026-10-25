import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { detectLanguage, translate } from './index'
import { en } from './en'
import { it as itDict } from './it'
import { StartLights } from '../components/StartLights'
import { RaceClock } from '../components/RaceClock'
import { useStore } from '../lib/store'
import { raceState } from '../test/fixtures'

describe('dictionaries', () => {
  it('en and it have identical key sets', () => {
    expect(Object.keys(itDict).sort()).toEqual(Object.keys(en).sort())
  })

  it('has no empty values and matching {placeholders}', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',')
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(itDict[k], k).not.toBe('')
      expect(ph(itDict[k]), k).toBe(ph(en[k]))
    }
  })
})

describe('translate', () => {
  it('interpolates params', () => {
    expect(translate('en', 'history.race_title', { id: 7 })).toBe('Race #7')
    expect(translate('it', 'history.race_title', { id: 7 })).toBe('Gara n. 7')
  })
  it('handles plurals', () => {
    expect(translate('en', 'gap.laps', { count: 1 })).toBe('+1 lap')
    expect(translate('en', 'gap.laps', { count: 3 })).toBe('+3 laps')
    expect(translate('it', 'gap.laps', { count: 1 })).toBe('+1 giro')
    expect(translate('it', 'gap.laps', { count: 2 })).toBe('+2 giri')
  })
  it('detects the browser language', () => {
    expect(detectLanguage('it-IT')).toBe('it')
    expect(detectLanguage('en-US')).toBe('en')
    expect(detectLanguage(undefined)).toBe('en')
  })
})

describe('components follow the UI language', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))

  it('renders in Italian', () => {
    useStore.setState({ language: 'it' })
    render(<StartLights light={8} />)
    expect(screen.getByText('Falsa partenza')).toBeInTheDocument()
    render(<RaceClock race={raceState({ phase: 'paused' })} />)
    expect(screen.getByTestId('phase-badge')).toHaveTextContent('Safety car')
    expect(screen.getByText('Tempo gara')).toBeInTheDocument()
  })

  it('renders in English', () => {
    render(<StartLights light={8} />)
    expect(screen.getByText('False start')).toBeInTheDocument()
  })
})
