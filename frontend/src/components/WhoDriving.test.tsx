import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyRace, useStore } from '../lib/store'
import type { Driver } from '../lib/types'
import { settingsResponse } from '../test/fixtures'
import { DriverPicker } from './DriverPicker'
import { WhoDriving } from './WhoDriving'

const mocks = vi.hoisted(() => ({
  setAssignments: vi.fn(),
  armNextCrossing: vi.fn(),
  cancelNextCrossing: vi.fn(),
  event: vi.fn(),
  createDriver: vi.fn(),
  voice: { text: 'Anna', guess: 'anna' as string | null },
}))

vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return { ...real, api: { ...real.api, ...mocks } }
})

// The recorder itself needs a browser: a button stands in and reports a canned transcript.
vi.mock('./VoiceInput', () => ({
  VoiceInput: ({ onTranscript }: { onTranscript: (t: string, g: string | null) => void }) => (
    <button type="button" onClick={() => onTranscript(mocks.voice.text, mocks.voice.guess)}>
      mic
    </button>
  ),
}))

const drv = (id: string, name: string): Driver => ({
  id,
  name,
  nickname: null,
  bio: '',
  has_photo: false,
  created_at: '2026-01-01T00:00:00Z',
})

beforeEach(() => {
  localStorage.clear()
  Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockReset())
  useStore.setState({
    settings: settingsResponse(),
    race: emptyRace,
    drivers: [drv('anna', 'Anna Bianchi'), drv('luca', 'Luca Verdi')],
    assignments: {},
    armedDriverId: null,
    armedUntil: null,
    lastAssignment: null,
    toasts: [],
  })
})
afterEach(() => vi.useRealTimers())

describe('DriverPicker', () => {
  it('filters the roster while typing and closes on Escape', async () => {
    const onClose = vi.fn()
    render(<DriverPicker title="Pick" onPick={vi.fn()} onClose={onClose} />)
    expect(screen.getAllByTestId('pick-driver')).toHaveLength(2)
    await userEvent.type(screen.getByRole('searchbox'), 'luc')
    expect(screen.getAllByTestId('pick-driver')).toHaveLength(1)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('preselects the voice name_guess driver', async () => {
    mocks.voice = { text: 'Anna', guess: 'anna' }
    const onPick = vi.fn()
    render(<DriverPicker title="Pick" onPick={onPick} onClose={vi.fn()} />)
    await userEvent.click(screen.getByText('mic'))
    const use = screen.getByTestId('voice-use')
    expect(use).toHaveTextContent('Anna Bianchi')
    expect(screen.getAllByTestId('pick-driver').find((b) => b.dataset.selected === 'true')).toHaveTextContent('Anna')
    await userEvent.click(use)
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'anna' }))
  })

  it('offers to create the heard name when nothing matches', async () => {
    mocks.voice = { text: 'Marco', guess: null }
    mocks.createDriver.mockResolvedValue(drv('marco', 'Marco'))
    const onPick = vi.fn()
    render(<DriverPicker title="Pick" onPick={onPick} onClose={vi.fn()} />)
    await userEvent.click(screen.getByText('mic'))
    await userEvent.click(screen.getByTestId('voice-create'))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'marco' })))
    expect(mocks.createDriver).toHaveBeenCalledWith({ name: 'Marco' })
  })

  it('creates a new driver inline with just a name', async () => {
    mocks.createDriver.mockResolvedValue(drv('nina', 'Nina'))
    const onPick = vi.fn()
    render(<DriverPicker title="Pick" onPick={onPick} onClose={vi.fn()} />)
    await userEvent.click(screen.getByTestId('new-driver'))
    await userEvent.type(screen.getByLabelText('Name of the new driver'), 'Nina{Enter}')
    await waitFor(() => expect(onPick).toHaveBeenCalled())
    expect(useStore.getState().drivers.some((x) => x.id === 'nina')).toBe(true)
  })
})

describe('WhoDriving', () => {
  it('assigns a driver to a car from the tile picker', async () => {
    mocks.setAssignments.mockResolvedValue({ assignments: { '0': 'luca' } })
    render(<WhoDriving />)
    expect(screen.getAllByTestId('car-tile')).toHaveLength(6)
    await userEvent.click(screen.getAllByTestId('car-tile')[0])
    await userEvent.click(screen.getByText('Luca Verdi'))
    await waitFor(() => expect(mocks.setAssignments).toHaveBeenCalledWith({ '0': 'luca' }))
    await waitFor(() => expect(useStore.getState().assignments).toEqual({ '0': 'luca' }))
    expect(screen.getAllByTestId('car-tile')[0]).toHaveTextContent('Luca Verdi')
  })

  it('clears all assignments', async () => {
    useStore.setState({ assignments: { '0': 'luca' } })
    mocks.setAssignments.mockResolvedValue({ assignments: {} })
    render(<WhoDriving />)
    await userEvent.click(screen.getByTestId('clear-all'))
    await waitFor(() => expect(mocks.setAssignments).toHaveBeenCalled())
    expect(Object.values(mocks.setAssignments.mock.calls[0][0])).toEqual([null, null, null, null, null, null])
    await waitFor(() => expect(useStore.getState().assignments).toEqual({}))
  })

  it('arms a crossing, counts down and reports success on driver_assigned', async () => {
    const until = new Date(Date.now() + 42_000).toISOString()
    mocks.armNextCrossing.mockResolvedValue({ armed: true })
    mocks.event.mockResolvedValue({
      program_id: null,
      current_index: 0,
      assignments: {},
      results: [],
      armed_driver_id: 'anna',
      armed_until: until,
    })
    render(<WhoDriving />)
    await userEvent.click(screen.getByTestId('by-crossing'))
    await userEvent.click(screen.getByText('Anna Bianchi'))
    const banner = await screen.findByTestId('crossing-banner')
    expect(banner).toHaveTextContent(/Anna Bianchi.*across the line.*(41|42) s/)

    act(() => {
      useStore.getState().applyMessage({
        type: 'event',
        data: {
          type: 'driver_assigned',
          at: new Date().toISOString(),
          race_time_ms: 0,
          address: 2,
          driver_id: 'anna',
          driver_name: 'Anna Bianchi',
          method: 'crossing',
        },
      })
    })
    expect(screen.queryByTestId('crossing-banner')).toBeNull()
    expect(screen.getByTestId('crossing-done')).toHaveTextContent('Anna Bianchi is now driving car 3.')
    expect(screen.getAllByTestId('car-tile')[2]).toHaveTextContent('Anna Bianchi')
  })

  it('cancels an armed crossing', async () => {
    useStore.setState({ armedDriverId: 'anna', armedUntil: new Date(Date.now() + 30_000).toISOString() })
    mocks.cancelNextCrossing.mockResolvedValue({ armed: false })
    render(<WhoDriving />)
    fireEvent.click(screen.getByTestId('crossing-cancel'))
    await waitFor(() => expect(useStore.getState().armedDriverId).toBeNull())
    expect(mocks.cancelNextCrossing).toHaveBeenCalled()
  })

  it('stops the countdown when the arming expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    useStore.setState({ armedDriverId: 'anna', armedUntil: new Date(Date.now() + 1_000).toISOString() })
    render(<WhoDriving />)
    expect(screen.getByTestId('crossing-banner')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(screen.queryByTestId('crossing-banner')).toBeNull()
    expect(screen.getByTestId('crossing-done')).toHaveTextContent('Time is up')
  })
})
