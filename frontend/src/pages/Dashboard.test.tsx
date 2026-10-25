import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { api, ApiError } from '../lib/api'
import { useStore } from '../lib/store'
import { raceState } from '../test/fixtures'

describe('Dashboard 16:9 layout', () => {
  beforeEach(() => {
    vi.spyOn(api, 'layout').mockRejectedValue(new ApiError(404, null, 'layout_not_found'))
    useStore.setState({ language: 'en', race: raceState() })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete window.carreraDesktop
  })

  it('uses a full-viewport, non-scrolling grid from 1200 px wide', () => {
    render(<Dashboard />)
    const root = screen.getByTestId('dashboard')
    for (const cls of [
      'min-[1200px]:grid',
      'min-[1200px]:h-full',
      'min-[1200px]:overflow-hidden',
      'min-[1200px]:grid-rows-[auto_minmax(0,1.45fr)_minmax(0,1fr)]',
    ]) {
      expect(root.className).toContain(cls)
    }
    // stacked (no grid) below 1200 px: the base classes are a plain column
    expect(root.className).toContain('flex-col')
  })

  it('contains every panel: connection, controls, leaderboard, map, chart, commentary, record, events', () => {
    render(<Dashboard />)
    for (const name of [
      'Connection',
      'Race controls',
      'Leaderboard',
      'Live track map',
      'Lap times',
      'Commentary',
      'Track record',
      'Event log',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument()
    }
  })

  it('opens the TV view in a named browser window outside the desktop app', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<Dashboard />)
    fireEvent.click(screen.getByTestId('open-tv'))
    expect(open).toHaveBeenCalledWith('#/tv', 'carrera-tv')
  })

  it('asks the desktop shell for the TV window when running inside it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const openTvWindow = vi.fn().mockResolvedValue({ ok: true, displayId: 2 })
    window.carreraDesktop = { isDesktop: true, openTvWindow } as unknown as typeof window.carreraDesktop
    render(<Dashboard />)
    fireEvent.click(screen.getByTestId('open-tv'))
    await Promise.resolve()
    expect(openTvWindow).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    ['ok:false', () => vi.fn().mockResolvedValue({ ok: false, error: 'no_such_display' })],
    ['rejection', () => vi.fn().mockRejectedValue(new Error('boom'))],
    ['throw', () => vi.fn(() => { throw new Error('boom') })],
  ])('falls back to a browser window when the desktop call fails (%s)', async (_n, make) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    window.carreraDesktop = { isDesktop: true, openTvWindow: make() } as unknown as typeof window.carreraDesktop
    render(<Dashboard />)
    fireEvent.click(screen.getByTestId('open-tv'))
    await waitFor(() => expect(open).toHaveBeenCalledWith('#/tv', 'carrera-tv'))
  })
})
