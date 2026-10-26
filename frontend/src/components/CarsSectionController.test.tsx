import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { CarsSection } from './CarsSection'
import { useStore } from '../lib/store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'

function Connected() {
  const cars = useStore((s) => s.settings!.cars)
  return <CarsSection cars={cars} />
}

describe('CarsSection controller settings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({ settings: settingsResponse(), language: 'en' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('edits the controller values and autosaves them with the car', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<Connected />)
    fireEvent.click(screen.getAllByTestId('car-ctl-toggle')[1])
    fireEvent.click(screen.getByTestId('car-ctl-1-speed-toggle'))
    fireEvent.change(screen.getByTestId('car-ctl-1-speed-slider'), { target: { value: '7' } })
    await act(() => vi.advanceTimersByTimeAsync(700))
    expect(srv.puts).toHaveLength(1)
    expect(srv.puts[0].cars[1].controller).toEqual({ speed: 7, brake: null, fuel: null })
    // Untouched car keeps its (unset) profile.
    expect(srv.puts[0].cars[0].controller).toEqual({ speed: null, brake: null, fuel: null })
  })

  it('a preset fills all three values; unset is sent as null', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<Connected />)
    fireEvent.click(screen.getAllByTestId('car-ctl-toggle')[0])
    fireEvent.click(screen.getByTestId('car-ctl-0-preset-guest'))
    await act(() => vi.advanceTimersByTimeAsync(700))
    const c = srv.puts[0].cars[0].controller
    expect(c.speed).not.toBeNull()
    expect(c.brake).not.toBeNull()
    expect(c.fuel).not.toBeNull()
    fireEvent.click(screen.getByTestId('car-ctl-0-clear'))
    await act(() => vi.advanceTimersByTimeAsync(700))
    expect(srv.puts[1].cars[0].controller).toEqual({ speed: null, brake: null, fuel: null })
  })

  it('opens the pairing wizard for a car', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ logos: [] }), { status: 200 })))
    render(<Connected />)
    fireEvent.click(screen.getAllByTestId('car-pair')[1])
    expect(screen.getByRole('dialog', { name: 'Pair a car' })).toBeInTheDocument()
    expect((screen.getByTestId('pair-existing') as HTMLSelectElement).value).toBe('1')
    expect((screen.getByTestId('pair-target') as HTMLSelectElement).value).toBe('1')
  })
})
