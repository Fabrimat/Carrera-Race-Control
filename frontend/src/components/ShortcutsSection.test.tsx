import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../lib/store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'
import { ShortcutsSection } from './ShortcutsSection'

function setup(shortcuts: Record<string, string> = {}, language: 'en' | 'it' = 'en') {
  const initial = settingsResponse({ shortcuts })
  const srv = fakeSettingsServer(initial)
  vi.stubGlobal('fetch', srv.fetchMock)
  useStore.setState({ settings: initial, language })
  render(<ShortcutsSection />)
  return srv
}

beforeEach(() => useStore.setState({ settings: settingsResponse(), language: 'en' }))
afterEach(() => vi.unstubAllGlobals())

describe('ShortcutsSection', () => {
  it('records a new combo and saves only the difference from the default', async () => {
    const srv = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Pace car on / off' }))
    expect(screen.getByRole('status')).toHaveTextContent('Press a key')
    fireEvent.keyDown(window, { key: 'X', shiftKey: true })
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].shortcuts).toEqual({ 'race.pace_car': 'Shift+X' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not trigger other shortcuts or controls while recording; Escape cancels', async () => {
    const srv = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Next race mode' }))
    const section = screen.getByTestId('shortcuts-section')
    expect(section).toHaveAttribute('data-shortcut-recording')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(srv.puts).toHaveLength(0)
    expect(screen.queryByRole('status')).toBeNull()
    expect(section).not.toHaveAttribute('data-shortcut-recording')
  })

  it('refuses reserved and AltGr combos with a message and keeps recording', async () => {
    const srv = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Change the shortcut for Start race' }))
    fireEvent.keyDown(window, { key: 'r', ctrlKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent(/reserves/)
    fireEvent.keyDown(window, { key: '@', ctrlKey: true, altKey: true })
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be used/)
    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true }) // a lone modifier is ignored
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(srv.puts).toHaveLength(0)
  })

  it('warns about a conflict', async () => {
    setup({ 'race.mode': 'P' })
    const alerts = screen.getAllByTestId('shortcut-conflict')
    expect(alerts).toHaveLength(2) // both actions of the conflicting pair show the warning
    expect(alerts[0]).toHaveTextContent(/Also used by/)
  })

  it('disables, enables and resets to the default', async () => {
    const srv = setup({ 'race.pace_car': 'Shift+X' })
    const row = screen.getByTestId('shortcut-race.pace_car')
    await userEvent.click(within(row).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].shortcuts).toEqual({ 'race.pace_car': '' })
    expect(row).toHaveTextContent('Disabled')
    await userEvent.click(within(row).getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(srv.puts).toHaveLength(2))
    expect(srv.puts[1].shortcuts).toEqual({})
  })

  it('resets everything', async () => {
    const srv = setup({ 'race.pace_car': 'Shift+X', 'race.mode': '' })
    await userEvent.click(screen.getByRole('button', { name: 'Reset all to default' }))
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].shortcuts).toEqual({})
  })

  it('is translated', () => {
    setup({}, 'it')
    expect(screen.getByRole('heading', { name: 'Scorciatoie da tastiera' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ripristina tutte le predefinite' })).toBeDisabled()
  })
})
