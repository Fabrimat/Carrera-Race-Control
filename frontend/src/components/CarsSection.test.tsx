import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CarsSection } from './CarsSection'
import { useStore } from '../lib/store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'

function Connected() {
  const cars = useStore((s) => s.settings!.cars)
  return <CarsSection cars={cars} />
}

describe('CarsSection autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({ settings: settingsResponse(), language: 'en' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const setup = (delayMs = 0) => {
    const srv = fakeSettingsServer(settingsResponse(), delayMs)
    vi.stubGlobal('fetch', srv.fetchMock)
    const view = render(<Connected />)
    return { srv, view }
  }

  it('debounces edits into a single PUT with merged settings', async () => {
    const { srv } = setup()
    const [name] = screen.getAllByTestId('car-name')
    fireEvent.change(name, { target: { value: 'R' } })
    fireEvent.change(name, { target: { value: 'Ro' } })
    fireEvent.change(name, { target: { value: 'Rosso' } })
    // Another setting changes meanwhile (e.g. the header language switch).
    act(() => useStore.setState({ settings: settingsResponse({ ui_language: 'it' }) }))
    await act(() => vi.advanceTimersByTimeAsync(599))
    expect(srv.puts).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(2))
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].cars[0].name).toBe('Rosso')
    expect(srv.puts[0].cars[1].name).toBe('Car 2')
    expect(srv.puts[0].ui_language).toBe('it')
    expect(screen.getByTestId('cars-status')).toHaveTextContent('Salvato ✓') // UI language switched to Italian meanwhile
  })

  it('keeps a trailing space typed before a pause', async () => {
    const { srv } = setup()
    const name = screen.getAllByTestId('car-name')[0] as HTMLInputElement
    fireEvent.change(name, { target: { value: 'A ' } })
    await act(() => vi.advanceTimersByTimeAsync(650))
    expect(srv.puts[0].cars[0].name).toBe('A')
    expect(name.value).toBe('A ')
    fireEvent.change(name, { target: { value: 'A B' } })
    expect(name.value).toBe('A B')
    await act(() => vi.advanceTimersByTimeAsync(650))
    expect(srv.puts).toHaveLength(2)
    expect(srv.puts[1].cars[0].name).toBe('A B')
    expect(name.value).toBe('A B')
  })

  it('shows Saving… while the request is in flight', async () => {
    const { srv } = setup(300)
    fireEvent.change(screen.getAllByTestId('car-nickname')[1], { target: { value: 'Blu' } })
    await act(() => vi.advanceTimersByTimeAsync(650))
    expect(screen.getByTestId('cars-status')).toHaveTextContent('Saving…')
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(srv.puts[0].cars[1].nickname).toBe('Blu')
  })

  it('does not send invalid values and flags them inline', async () => {
    const { srv } = setup()
    const [name] = screen.getAllByTestId('car-name')
    fireEvent.change(name, { target: { value: '' } })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(srv.puts).toHaveLength(0)
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Name must be 1 to 40 characters.')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'x'.repeat(41) } })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(srv.puts).toHaveLength(0)
  })

  it('flushes pending edits on unmount', async () => {
    const { srv, view } = setup()
    fireEvent.change(screen.getAllByTestId('car-name')[0], { target: { value: 'Verde' } })
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].cars[0].name).toBe('Verde')
  })

  it('sends a keepalive PUT on beforeunload', () => {
    const { srv } = setup()
    fireEvent.change(screen.getAllByTestId('car-name')[0], { target: { value: 'Verde' } })
    window.dispatchEvent(new Event('beforeunload'))
    expect(srv.fetchMock).toHaveBeenCalledTimes(1)
    expect(srv.fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT', keepalive: true })
  })
})
