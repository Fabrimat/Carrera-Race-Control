import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Garage } from './Garage'
import { useStore } from '../lib/store'
import { settingsResponse } from '../test/fixtures'
import type { ControllerStatus, GarageCar } from '../lib/types'

const none = { speed: null, brake: null, fuel: null }

function garage(): GarageCar[] {
  const [a, b] = settingsResponse().cars
  return [
    { address: 0, car: { ...a, name: 'Fulmine', color: '#e53935' }, races: 4, laps: 37, best_lap_ms: 8123, best_lap_layout: 'Oval' },
    { address: 1, car: b, races: 0, laps: 0, best_lap_ms: null, best_lap_layout: null },
  ]
}

function statuses(over: Partial<ControllerStatus>[] = []): ControllerStatus[] {
  return [
    { address: 0, effective: { speed: 10, brake: null, fuel: 15 }, applied: null, pending: true, driver_id: null, ...over[0] },
    { address: 1, effective: none, applied: null, pending: false, driver_id: null, ...over[1] },
  ]
}

describe('Garage page', () => {
  let ctl: ControllerStatus[]
  let calls: string[]
  beforeEach(() => {
    ctl = statuses()
    calls = []
    const s = settingsResponse()
    s.cars[0] = { ...s.cars[0], name: 'Fulmine' }
    useStore.setState({ settings: s, language: 'en', ws: 'open' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (url === '/api/garage') return new Response(JSON.stringify({ cars: garage() }))
        if (url === '/api/controllers') return new Response(JSON.stringify({ controllers: ctl }))
        if (url === '/api/controllers/apply') {
          ctl = statuses([{ pending: false, applied: { speed: 10, brake: null, fuel: 15 } }])
          return new Response(JSON.stringify({ controllers: ctl }))
        }
        if (url === '/api/logos') return new Response(JSON.stringify({ logos: [] }))
        return new Response('{}', { status: 500 })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  const renderPage = async () => {
    render(<Garage />)
    await act(() => new Promise((r) => setTimeout(r, 0)))
  }

  it('renders a card per car with stats, summary and status', async () => {
    await renderPage()
    const cards = screen.getAllByTestId('garage-card')
    expect(cards).toHaveLength(2)
    const first = within(cards[0])
    expect(first.getByTestId('garage-name')).toHaveTextContent('Fulmine')
    expect(first.getByTestId('garage-controller')).toHaveTextContent('#1')
    expect(first.getByTestId('garage-best')).toHaveTextContent('Oval')
    expect(first.getByTestId('garage-best')).toHaveTextContent('8.123')
    expect(first.getByTestId('garage-races')).toHaveTextContent('4')
    expect(first.getByTestId('garage-laps')).toHaveTextContent('37')
    expect(first.getByTestId('ctl-summary-speed')).toHaveTextContent('10')
    expect(first.getByTestId('ctl-summary-brake')).toHaveTextContent('—')
    expect(first.getByTestId('ctl-badge')).toHaveAttribute('data-status', 'pending')
    const second = within(cards[1])
    expect(second.getByTestId('garage-best')).toHaveTextContent('—')
    expect(second.getByTestId('ctl-badge')).toHaveAttribute('data-status', 'unset')
    expect(screen.getByTestId('garage-pending-note')).toBeInTheDocument()
  })

  it('Apply now posts and the badge turns to applied', async () => {
    await renderPage()
    fireEvent.click(screen.getByTestId('garage-apply'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(calls).toContain('POST /api/controllers/apply')
    expect(within(screen.getAllByTestId('garage-card')[0]).getByTestId('ctl-badge')).toHaveAttribute('data-status', 'applied')
    expect(screen.queryByTestId('garage-pending-note')).toBeNull()
  })

  it('translates apply errors', async () => {
    await renderPage()
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => new Response(JSON.stringify({ detail: 'x', code: 'not_connected' }), { status: 409 }),
    )
    fireEvent.click(screen.getByTestId('garage-apply'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(screen.getByTestId('garage-apply-error')).toHaveTextContent('Not connected to a track')
    ;(fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => new Response(JSON.stringify({ detail: 'x', code: 'busy' }), { status: 409 }),
    )
    fireEvent.click(screen.getByTestId('garage-apply'))
    await act(() => new Promise((r) => setTimeout(r, 0)))
    expect(screen.getByTestId('garage-apply-error')).toHaveTextContent('A race is in progress')
  })

  it('shows the assigned driver profile note', async () => {
    ctl = statuses([{ driver_id: 'd1' }])
    useStore.setState({
      drivers: [{ id: 'd1', name: 'Anna Rossi', nickname: 'Anna', bio: '', has_photo: false, controller: null, created_at: '' }],
    })
    await renderPage()
    expect(screen.getByTestId('garage-driver')).toHaveTextContent("Includes Anna's handicap profile")
  })

  it('opens the pairing wizard and the settings editor from a card', async () => {
    await renderPage()
    fireEvent.click(within(screen.getAllByTestId('garage-card')[1]).getByTestId('garage-pair'))
    expect(screen.getByRole('dialog', { name: 'Pair a car' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(screen.getAllByTestId('garage-card')[0]).getByTestId('garage-edit'))
    expect(screen.getByRole('dialog', { name: 'Controller settings: Fulmine' })).toBeInTheDocument()
  })
})
