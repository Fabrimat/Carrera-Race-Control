import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../lib/store'
import { raceState, settingsResponse } from '../test/fixtures'
import { RaceControls } from './RaceControls'

const mocks = vi.hoisted(() => ({ startRace: vi.fn() }))

vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return { ...real, api: { ...real.api, ...mocks } }
})

beforeEach(() => {
  mocks.startRace.mockReset()
  mocks.startRace.mockResolvedValue(raceState())
})

describe('RaceControls', () => {
  it('starts with the edited config when no event is running', async () => {
    useStore.setState({ settings: settingsResponse(), race: raceState({ phase: 'idle' }) })
    render(<RaceControls />)
    expect(screen.getByRole('combobox')).toBeEnabled()
    expect(screen.queryByTestId('session-spec')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mocks.startRace).toHaveBeenCalledTimes(1))
    expect(mocks.startRace.mock.calls[0][0]).toMatchObject({ mode: expect.any(String) })
  })

  it('shows the session spec read-only and starts without a body during an event', async () => {
    const race = raceState({ phase: 'idle' })
    race.config = { ...race.config, mode: 'laps', target_laps: 7 }
    race.session = {
      program_id: 'cup',
      program_name: 'Cup',
      session_id: 'final',
      kind: 'race',
      name: 'Final',
      index: 1,
      total: 2,
    }
    useStore.setState({ settings: settingsResponse(), race })
    render(<RaceControls />)
    const spec = screen.getByTestId('session-spec')
    expect(spec).toHaveTextContent('Final')
    expect(spec).toHaveTextContent('7')
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(mocks.startRace).toHaveBeenCalledTimes(1))
    expect(mocks.startRace.mock.calls[0]).toEqual([])
  })
})
