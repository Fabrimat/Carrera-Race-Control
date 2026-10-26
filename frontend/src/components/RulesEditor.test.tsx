import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProgramEditor } from './event/ProgramEditor'
import { SettingsPage } from '../pages/SettingsPage'
import { newProgram } from '../lib/program'
import { useStore } from '../lib/store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('rules in Settings', () => {
  beforeEach(() => useStore.setState({ settings: settingsResponse(), language: 'en' }))

  it('round-trips incident and pit rules through the save', async () => {
    const srv = fakeSettingsServer(useStore.getState().settings!)
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<SettingsPage />)
    expect(screen.getByTestId('rules-detect')).toBeChecked()
    expect(screen.getByTestId('rules-auto-pace-note')).toHaveTextContent(/real pace car/)
    fireEvent.change(screen.getByTestId('rules-factor'), { target: { value: '4' } })
    fireEvent.click(screen.getByTestId('rules-auto-pace'))
    fireEvent.change(screen.getByTestId('rules-incident-penalty'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('rules-detect'))
    fireEvent.change(screen.getByTestId('rules-min-stops'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('rules-missed-penalty'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].race.incidents).toEqual({ detect: false, overdue_factor: 4, auto_pace_car: true, penalty_s: 5 })
    expect(srv.puts[0].race.pits).toEqual({ min_stops: 2, missed_penalty_s: 45 })
    // the rest of the race config is untouched
    expect(srv.puts[0].race.mode).toBe('practice')
  })

  it('snaps out-of-range values into range on blur', () => {
    render(<SettingsPage />)
    const factor = screen.getByTestId('rules-factor') as HTMLInputElement
    fireEvent.change(factor, { target: { value: '99' } })
    fireEvent.blur(factor)
    expect(factor.value).toBe('10')
    const stops = screen.getByTestId('rules-min-stops') as HTMLInputElement
    fireEvent.change(stops, { target: { value: '-3' } })
    fireEvent.blur(stops)
    expect(stops.value).toBe('0')
  })
})

describe('rules per session', () => {
  beforeEach(() => {
    const s = settingsResponse()
    s.race = { ...s.race, incidents: { detect: true, overdue_factor: 3, auto_pace_car: false, penalty_s: 7 } }
    useStore.setState({ settings: s, language: 'en' })
  })

  it('inherits by default, overrides from the Settings values and goes back to inherit', () => {
    const onSaved = vi.fn()
    render(<ProgramEditor program={newProgram('Open day', [])} onSaved={onSaved} onClose={vi.fn()} />)
    const card = screen.getByTestId('session-card')
    const inc = within(card).getByTestId('session-incidents')
    expect(within(inc).queryByTestId('incident-rules')).toBeNull()
    expect(within(inc).getByText(/Use the Settings rules/)).toBeInTheDocument()

    fireEvent.click(within(inc).getByTestId('override-incidents'))
    expect((within(inc).getByTestId('rules-factor') as HTMLInputElement).value).toBe('3')
    expect((within(inc).getByTestId('rules-incident-penalty') as HTMLInputElement).value).toBe('7')
    fireEvent.change(within(inc).getByTestId('rules-factor'), { target: { value: '5' } })
    expect((within(inc).getByTestId('rules-factor') as HTMLInputElement).value).toBe('5')

    const pits = within(card).getByTestId('session-pits')
    fireEvent.click(within(pits).getByTestId('override-pits'))
    fireEvent.change(within(pits).getByTestId('rules-min-stops'), { target: { value: '1' } })
    expect((within(pits).getByTestId('rules-min-stops') as HTMLInputElement).value).toBe('1')

    fireEvent.click(within(inc).getByTestId('override-incidents'))
    expect(within(inc).queryByTestId('incident-rules')).toBeNull()
  })
})
