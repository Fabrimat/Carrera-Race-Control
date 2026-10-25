import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSettings, validateCarPatch } from './settingsSave'
import { useStore } from './store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'

describe('saveSettings', () => {
  beforeEach(() => useStore.setState({ settings: settingsResponse(), language: 'en' }))
  afterEach(() => vi.unstubAllGlobals())

  it('does not lose a concurrent language switch and car edit', async () => {
    const srv = fakeSettingsServer(settingsResponse(), 10)
    vi.stubGlobal('fetch', srv.fetchMock)
    const lang = saveSettings((s) => ({ ...s, ui_language: 'it' }))
    const car = saveSettings((s) => ({
      ...s,
      cars: s.cars.map((c) => (c.address === 0 ? { ...c, name: 'Rosso' } : c)),
    }))
    await Promise.all([lang, car])
    expect(srv.puts).toHaveLength(2)
    const final = srv.current()
    expect(final.ui_language).toBe('it')
    expect(final.cars[0].name).toBe('Rosso')
    expect(useStore.getState().settings?.cars[0].name).toBe('Rosso')
    expect(useStore.getState().language).toBe('it')
  })

  it('does not send the response-only keys field', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    await saveSettings((s) => s)
    expect(srv.puts[0]).not.toHaveProperty('keys')
  })

  it('a failed save does not block the next one', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    const failing = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 422 }))
    failing.mockImplementation(srv.fetchMock)
    vi.stubGlobal('fetch', failing)
    await expect(saveSettings((s) => s)).rejects.toThrow()
    await expect(saveSettings((s) => s)).resolves.not.toBeNull()
  })
})

describe('validateCarPatch', () => {
  it('mirrors the backend rules', () => {
    expect(validateCarPatch({ name: '' })).toEqual({ name: true })
    expect(validateCarPatch({ name: '   ' })).toEqual({ name: true })
    expect(validateCarPatch({ name: 'x'.repeat(41) })).toEqual({ name: true })
    expect(validateCarPatch({ name: 'x'.repeat(40), color: '#aAbB09' })).toEqual({})
    expect(validateCarPatch({ color: 'red' })).toEqual({ color: true })
    expect(validateCarPatch({ color: '#abc' })).toEqual({ color: true })
  })
})
