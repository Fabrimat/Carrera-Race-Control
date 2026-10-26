import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Leaderboard } from './Leaderboard'
import { useStore } from '../lib/store'
import { car, fakeSettingsServer, settingsResponse } from '../test/fixtures'

const cars = [car({ address: 0, name: 'Car 1', position: 1 }), car({ address: 1, name: 'Car 2', position: 2 })]

describe('Leaderboard inline rename', () => {
  beforeEach(() => {
    useStore.setState({
      language: 'en',
      settings: settingsResponse({
        cars: [
          { address: 0, name: 'Car 1', color: '#e53935', nickname: 'Speedy', logo_id: null },
          { address: 1, name: 'Car 2', color: '#1e88e5', nickname: null, logo_id: null },
        ],
      }),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('Enter saves a merged PUT', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    const user = userEvent.setup()
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} editable />)
    await user.click(screen.getByRole('button', { name: 'Rename Car 1' }))
    const input = screen.getByTestId('rename-input')
    await user.clear(input)
    await user.type(input, 'Rosso{Enter}')
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].cars[0]).toMatchObject({ name: 'Rosso', nickname: 'Speedy' })
    expect(srv.puts[0].cars[1].name).toBe('Car 2')
    expect(screen.queryByTestId('rename-input')).toBeNull()
  })

  it('Escape cancels without saving', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    const user = userEvent.setup()
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} editable />)
    await user.click(screen.getByRole('button', { name: 'Rename Car 1' }))
    await user.type(screen.getByTestId('rename-input'), 'zzz{Escape}')
    expect(screen.queryByTestId('rename-input')).toBeNull()
    expect(srv.puts).toHaveLength(0)
    expect(screen.getByText('Car 1')).toBeInTheDocument()
  })

  it('F2 starts editing, blur saves, and an empty name is not sent', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    const user = userEvent.setup()
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} editable />)
    screen.getByRole('button', { name: 'Rename Car 2' }).focus()
    await user.keyboard('{F2}')
    const input = screen.getByTestId('rename-input')
    await user.clear(input)
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('rename-input')).toHaveAttribute('aria-invalid', 'true')
    expect(srv.puts).toHaveLength(0)
    await user.type(input, 'Blu')
    await user.tab()
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].cars[1].name).toBe('Blu')
  })

  it('shows the nickname and is not editable unless asked (TV mode)', () => {
    const { rerender } = render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} editable />)
    expect(screen.getByText('Speedy')).toBeInTheDocument()
    rerender(<Leaderboard cars={cars} bestLap={null} fuelMode={false} large />)
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull()
    expect(screen.getAllByTestId('leaderboard-row')).toHaveLength(2)
  })
})
