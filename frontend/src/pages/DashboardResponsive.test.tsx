import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { Dashboard } from './Dashboard'
import { Header } from '../components/Header'
import { api, ApiError } from '../lib/api'
import { useLayoutSync } from '../lib/layout'
import { useStore } from '../lib/store'
import { raceState } from '../test/fixtures'

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

describe('responsive dashboard', () => {
  beforeEach(() => {
    vi.spyOn(api, 'layout').mockRejectedValue(new ApiError(404, null, 'layout_not_found'))
    useStore.setState({
      language: 'en',
      race: raceState(),
      commentary: [1, 2, 3, 4].map((id) => ({ id, text: `line ${id}`, priority: 'normal' }) as never),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setViewport(1024, 768)
    document.documentElement.removeAttribute('data-layout')
    document.documentElement.style.fontSize = ''
  })

  it('shows the pit wall on a phone: controls, leaderboard, latest commentary, map on tap', () => {
    setViewport(390, 844)
    render(<Dashboard />)
    expect(screen.getByTestId('pit-wall')).toBeInTheDocument()
    expect(screen.queryByTestId('dashboard')).toBeNull()
    expect(screen.getByRole('region', { name: 'Race controls' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Leaderboard' })).toBeInTheDocument()
    expect(screen.queryByTestId('best-lap')).toBeNull() // compact rows: no best / actions
    expect(screen.queryByTestId('report-off')).toBeNull()
    // only the latest three lines, newest first
    const lines = screen.getAllByTestId('pit-commentary-line').map((l) => l.textContent)
    expect(lines).toEqual(['line 4', 'line 3', 'line 2'])
    // the map is behind a tap
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('pit-map'))
    expect(screen.getByRole('dialog', { name: 'Live track map' })).toBeInTheDocument()
  })

  it('lets a phone open the full dashboard', () => {
    setViewport(390, 844)
    render(<Dashboard />)
    fireEvent.click(screen.getByTestId('pit-full'))
    expect(screen.getByTestId('dashboard')).toBeInTheDocument()
    expect(screen.queryByTestId('pit-wall')).toBeNull()
  })

  it('collapses panels on a tablet and keeps the 16:9 grid classes', () => {
    setViewport(768, 1024)
    render(<Dashboard />)
    expect(screen.getByTestId('dashboard').className).toContain('min-[1200px]:grid')
    const toggle = screen.getByRole('button', { name: 'Hide Lap times' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Lap times' })).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.queryByRole('region', { name: 'Lap times' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Show Lap times' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('has no collapse buttons on the desktop layouts', () => {
    for (const [w, h] of [
      [1366, 768],
      [1920, 1080],
      [2560, 1080],
      [3840, 2160],
    ]) {
      setViewport(w, h)
      const { unmount } = render(<Dashboard />)
      expect(screen.queryByTestId('collapse-chart')).toBeNull()
      expect(screen.getByRole('region', { name: 'Lap times' })).toBeInTheDocument()
      unmount()
    }
  })

  it('mirrors the layout class and the UI scale onto <html>', () => {
    setViewport(3840, 2160)
    renderHook(() => useLayoutSync())
    expect(document.documentElement.dataset.layout).toBe('uhd')
    expect(document.documentElement.style.fontSize).toBe('24px')
    setViewport(2560, 1080)
    expect(document.documentElement.dataset.layout).toBe('ultrawide')
    expect(document.documentElement.style.fontSize).toBe('')
    setViewport(1920, 1080)
    expect(document.documentElement.dataset.layout).toBe('desktop')
  })
})

describe('header menu', () => {
  beforeEach(() => useStore.setState({ language: 'en', ws: 'open' }))

  it('opens and closes the collapsed navigation, with every page link in one nav', () => {
    render(<Header route={{ name: 'dashboard' }} />)
    const toggle = screen.getByTestId('nav-toggle')
    const nav = screen.getByTestId('main-nav')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).toHaveAttribute('data-open', 'false')
    expect(nav.querySelectorAll('a').length).toBeGreaterThanOrEqual(7)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(nav).toHaveAttribute('data-open', 'true')
    fireEvent.click(toggle)
    expect(nav).toHaveAttribute('data-open', 'false')
  })

  it('closes on Escape and returns focus to the toggle', () => {
    render(<Header route={{ name: 'dashboard' }} />)
    const toggle = screen.getByTestId('nav-toggle')
    fireEvent.click(toggle)
    fireEvent.keyDown(screen.getByTestId('main-nav').querySelector('a')!, { key: 'Escape' })
    expect(screen.getByTestId('main-nav')).toHaveAttribute('data-open', 'false')
    expect(toggle).toHaveFocus()
  })

  it('closes the menu when the page changes', () => {
    const { rerender } = render(<Header route={{ name: 'dashboard' }} />)
    fireEvent.click(screen.getByTestId('nav-toggle'))
    expect(screen.getByTestId('main-nav')).toHaveAttribute('data-open', 'true')
    rerender(<Header route={{ name: 'history' }} />)
    expect(screen.getByTestId('main-nav')).toHaveAttribute('data-open', 'false')
  })
})
