import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PairingWizard, formatCountdown, pickPairing } from './PairingWizard'
import { useStore } from '../lib/store'
import { settingsResponse } from '../test/fixtures'
import type { PairingState } from '../lib/types'

const NOW = Date.parse('2026-01-01T12:00:00Z')

function pairing(over: Partial<PairingState> = {}): PairingState {
  const settings = settingsResponse()
  return {
    phase: 'waiting',
    target_address: 2,
    car: { ...settings.cars[0], address: 2, name: 'Fulmine' },
    started_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    from_address: null,
    detected_address: null,
    error: null,
    ...over,
  }
}

type Call = { method: string; url: string; body: unknown }

function fakeApi(responses: Record<string, () => Response>) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = responses[`${method} ${url}`]
    if (r) return r()
    if (url === '/api/logos') return new Response(JSON.stringify({ logos: [] }))
    if (url === '/api/settings') return new Response(JSON.stringify(settingsResponse()))
    return new Response(JSON.stringify({ detail: 'x' }), { status: 500 })
  })
  return { calls, fetchMock }
}

const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status })

describe('PairingWizard', () => {
  const cars = settingsResponse().cars
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    useStore.setState({ settings: settingsResponse(), language: 'en' })
    useStore.setState((s) => ({ race: { ...s.race, pairing: null } }))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const open = (initial: number | null = null, onClose = vi.fn()) => {
    render(<PairingWizard cars={cars} initialAddress={initial} onClose={onClose} />)
    return onClose
  }
  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

  it('formats the countdown and picks the newer pairing', () => {
    expect(formatCountdown(59_100)).toBe('1:00')
    expect(formatCountdown(5_000)).toBe('0:05')
    expect(formatCountdown(-3)).toBe('0:00')
    const a = pairing()
    const b = pairing({ started_at: new Date(NOW + 5000).toISOString() })
    expect(pickPairing(a, b)).toBe(b)
    expect(pickPairing(b, a)).toBe(b)
    expect(pickPairing(null, a)).toBe(a)
  })

  it('starts for a new car, shows the steps and a countdown from expires_at', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing()) })
    vi.stubGlobal('fetch', api.fetchMock)
    open()
    // A new car needs a name.
    fireEvent.click(screen.getByTestId('pair-start'))
    expect(api.calls.find((c) => c.url === '/api/pairing')).toBeUndefined()
    expect(screen.getByTestId('pair-name')).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(screen.getByTestId('pair-name'), { target: { value: 'Fulmine' } })
    fireEvent.change(screen.getByTestId('pair-target'), { target: { value: '2' } })
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    const post = api.calls.find((c) => c.url === '/api/pairing')!
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({ target_address: 2, from_address: null, car: { name: 'Fulmine' } })
    expect(screen.getByTestId('pair-waiting')).toBeInTheDocument()
    expect(screen.getByText('Waiting for Fulmine on controller 3…')).toBeInTheDocument()
    expect(screen.getByText('On controller 3, press the lane-change button.')).toBeInTheDocument()
    expect(screen.getByTestId('pair-art-code')).toBeInTheDocument()
    expect(screen.getByTestId('pair-countdown')).toHaveTextContent('1:00 left')
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByTestId('pair-countdown')).toHaveTextContent('0:50 left')
  })

  it('re-coding an existing car on another controller passes from_address', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing({ from_address: 0 })) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.change(screen.getByTestId('pair-target'), { target: { value: '2' } })
    expect(screen.getByTestId('pair-recode-note')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    const post = api.calls.find((c) => c.url === '/api/pairing')!
    expect(post.body).toMatchObject({ target_address: 2, from_address: 0, car: { name: 'Car 1', address: 2 } })
  })

  it('same controller as the car means no from_address', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing({ target_address: 1 })) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(1)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    expect(api.calls.find((c) => c.url === '/api/pairing')!.body).toMatchObject({ target_address: 1, from_address: null })
  })

  it('confirm button posts /api/pairing/confirm and shows the result', async () => {
    const api = fakeApi({
      'POST /api/pairing': json(pairing()),
      'POST /api/pairing/confirm': json(pairing({ phase: 'paired' })),
    })
    vi.stubGlobal('fetch', api.fetchMock)
    const onPaired = vi.fn()
    render(<PairingWizard cars={cars} initialAddress={0} onClose={vi.fn()} onPaired={onPaired} />)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    fireEvent.click(screen.getByTestId('pair-confirm'))
    await flush()
    expect(screen.getByTestId('pair-paired')).toHaveTextContent('Fulmine is ready on controller 3.')
    expect(onPaired).toHaveBeenCalledTimes(1)
    expect(api.calls.some((c) => c.method === 'GET' && c.url === '/api/settings')).toBe(true)
  })

  it('follows RaceState.pairing from the store (paired by a crossing)', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing()) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    act(() => {
      useStore.setState((s) => ({ race: { ...s.race, pairing: pairing({ phase: 'paired', detected_address: 2 }) } }))
    })
    expect(screen.getByTestId('pair-paired')).toBeInTheDocument()
    expect(screen.queryByText(/the line saw/i)).toBeNull()
  })

  it('offers to use the detected controller when it differs, posting again with that target', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing({ from_address: 0 })) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    expect(screen.queryByTestId('pair-mismatch')).toBeNull()
    act(() => {
      useStore.setState((s) => ({ race: { ...s.race, pairing: pairing({ from_address: 0, detected_address: 4 }) } }))
    })
    expect(screen.getByTestId('pair-mismatch')).toHaveTextContent('The line saw controller 5, not controller 3.')
    fireEvent.click(screen.getByTestId('pair-use-detected'))
    await flush()
    const posts = api.calls.filter((c) => c.method === 'POST' && c.url === '/api/pairing')
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toMatchObject({ target_address: 4, from_address: 0, car: { address: 4, name: 'Fulmine' } })
  })

  it('timeout: says so and tells the user to press CODE on the CU', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing()) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    act(() => {
      useStore.setState((s) => ({ race: { ...s.race, pairing: pairing({ phase: 'timeout' }) } }))
    })
    expect(screen.getByTestId('pair-timeout')).toHaveTextContent('Time is up')
    expect(screen.getByText(/press CODE on the unit/)).toBeInTheDocument()
    // Try again returns to the setup form.
    fireEvent.click(screen.getByTestId('pair-retry'))
    expect(screen.getByTestId('pair-setup')).toBeInTheDocument()
  })

  it('cancel: DELETE, then the cancelled view with the CODE hint', async () => {
    const api = fakeApi({
      'POST /api/pairing': json(pairing()),
      'DELETE /api/pairing': json(pairing({ phase: 'cancelled' })),
    })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    fireEvent.click(screen.getByTestId('pair-cancel'))
    await flush()
    expect(api.calls.some((c) => c.method === 'DELETE' && c.url === '/api/pairing')).toBe(true)
    expect(screen.getByTestId('pair-cancelled')).toHaveTextContent('Pairing cancelled.')
    expect(screen.getByText(/press CODE on the unit/)).toBeInTheDocument()
  })

  it('a race start cancels it: dedicated message; failed shows the error', async () => {
    const api = fakeApi({ 'POST /api/pairing': json(pairing()) })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    act(() => {
      useStore.setState((s) => ({
        race: { ...s.race, pairing: pairing({ phase: 'cancelled', error: 'race started' }) },
      }))
    })
    expect(screen.getByTestId('pair-cancelled')).toHaveTextContent('a race started')
    act(() => {
      useStore.setState((s) => ({
        race: { ...s.race, pairing: pairing({ phase: 'failed', error: 'CU said no' }) },
      }))
    })
    expect(screen.getByTestId('pair-failed')).toHaveTextContent('Pairing failed: CU said no')
  })

  it('translates busy and not_connected errors on start', async () => {
    const api = fakeApi({
      'POST /api/pairing': json({ detail: 'busy', code: 'busy' }, 409),
    })
    vi.stubGlobal('fetch', api.fetchMock)
    open(0)
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    expect(screen.getByTestId('pair-error')).toHaveTextContent('A race is in progress')
    expect(screen.getByTestId('pair-setup')).toBeInTheDocument()
    api.fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ detail: 'nc', code: 'not_connected' }), { status: 409 }),
    )
    fireEvent.click(screen.getByTestId('pair-start'))
    await flush()
    expect(screen.getByTestId('pair-error')).toHaveTextContent('Not connected to a track')
  })

  it('resumes a pairing that is already waiting on the backend, and closing cancels it', async () => {
    const api = fakeApi({ 'DELETE /api/pairing': json(pairing({ phase: 'cancelled' })) })
    vi.stubGlobal('fetch', api.fetchMock)
    act(() => {
      useStore.setState((s) => ({ race: { ...s.race, pairing: pairing() } }))
    })
    const onClose = open(0)
    expect(screen.getByTestId('pair-waiting')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await flush()
    expect(onClose).toHaveBeenCalled()
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true)
  })
})
