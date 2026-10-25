import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionBar } from './SessionBar'
import { api } from '../../lib/api'
import { useEventUi } from '../../lib/eventStore'
import { newProgram, newSession } from '../../lib/program'
import { useStore } from '../../lib/store'
import type { EventProgram, EventState, RaceEvent } from '../../lib/types'
import { car, raceState } from '../../test/fixtures'

const program = (): EventProgram => {
  const q = { ...newSession('qualifying', []), duration_s: 300 }
  const r = { ...newSession('race', [q]), target_laps: 8, grid_from: q.id }
  return { ...newProgram('Open day', []), sessions: [q, r] }
}
const ev = (over: Partial<EventState> = {}): EventState => ({
  program_id: null,
  current_index: 0,
  assignments: {},
  results: [],
  armed_driver_id: null,
  armed_until: null,
  ...over,
})
const push = (e: Record<string, unknown>) =>
  act(() => useStore.getState().applyMessage({ type: 'event', data: { at: 'x', race_time_ms: 0, ...e } as RaceEvent }))

describe('SessionBar', () => {
  beforeEach(() => {
    useStore.setState({ language: 'en', ws: 'offline', race: raceState(), events: [], toasts: [] })
    useEventUi.setState({ event: ev(), programs: [], finished: null })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders nothing without programs or an active event', () => {
    render(<SessionBar />)
    expect(screen.queryByTestId('session-bar')).toBeNull()
  })

  it('starts an event from the picked program', async () => {
    const p = program()
    useEventUi.setState({ programs: [p] })
    const start = vi.spyOn(api, 'startEvent').mockResolvedValue(ev({ program_id: p.id }))
    render(<SessionBar />)
    fireEvent.click(screen.getByTestId('start-event'))
    await waitFor(() => expect(start).toHaveBeenCalledWith(p.id))
    expect(await screen.findByTestId('session-label')).toHaveTextContent('Session 1/2 · Qualifying · 5:00')
  })

  it('shows the running session, the grid from the earlier one, and moves on', async () => {
    const p = program()
    const q = p.sessions[0]
    useEventUi.setState({
      programs: [p],
      event: ev({
        program_id: p.id,
        current_index: 1,
        results: [
          {
            session_id: q.id,
            kind: 'qualifying',
            race_id: 1,
            finished_at: 'x',
            classification: [
              { position: 1, address: 1, driver_id: null, name: 'Bea', laps: 3, best_lap_ms: 7000, total_time_ms: null, penalty_ms: 0 },
              { position: 2, address: 0, driver_id: null, name: 'Ale', laps: 3, best_lap_ms: 7100, total_time_ms: null, penalty_ms: 0 },
            ],
          },
        ],
      }),
    })
    const next = vi.spyOn(api, 'nextSession').mockResolvedValue(ev({ program_id: p.id, current_index: 1 }))
    render(<SessionBar />)
    expect(screen.getByTestId('session-label')).toHaveTextContent('Session 2/2 · Race · 8 laps')
    expect(screen.getByTestId('session-grid')).toHaveTextContent('1. Bea · 2. Ale')
    // last session: no next
    expect(screen.getByTestId('next-session')).toBeDisabled()
    expect(next).not.toHaveBeenCalled()
  })

  it('opens the classification modal on session_finished, then Next session advances', async () => {
    const p = program()
    const result = {
      session_id: p.sessions[0].id,
      kind: 'qualifying' as const,
      race_id: 1,
      finished_at: 'x',
      classification: [
        { position: 1, address: 0, driver_id: null, name: 'Ale', laps: 3, best_lap_ms: 7100, total_time_ms: null, penalty_ms: 0 },
        { position: 2, address: 1, driver_id: null, name: 'Bea', laps: 2, best_lap_ms: null, total_time_ms: null, penalty_ms: 5000 },
      ],
    }
    useEventUi.setState({ programs: [p], event: ev({ program_id: p.id }) })
    vi.spyOn(api, 'event').mockResolvedValue(ev({ program_id: p.id, results: [result] }))
    const next = vi.spyOn(api, 'nextSession').mockResolvedValue(ev({ program_id: p.id, current_index: 1 }))
    render(<SessionBar />)
    push({ type: 'session_finished', session_id: p.sessions[0].id, kind: 'qualifying', order: [0, 1] })
    expect(await screen.findByTestId('session-result')).toBeInTheDocument()
    expect(screen.getByTestId('classification')).toHaveTextContent('+5s')
    fireEvent.click(screen.getByTestId('result-next'))
    await waitFor(() => expect(next).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('session-result')).toBeNull())
    expect(useEventUi.getState().event?.current_index).toBe(1)
  })

  it('toasts a false start with the driver name and the action', () => {
    useStore.setState({ race: raceState({ cars: [car({ address: 0, driver_name: 'Anna' })] }) })
    render(<SessionBar />)
    push({ type: 'false_start', address: 0, action: 'penalty', penalty_ms: 5000 })
    expect(useStore.getState().toasts.at(-1)?.message).toBe('False start by Anna: +5 s penalty')
    push({ type: 'false_start', address: 0, action: 'warn', penalty_ms: 0, at: 'y' })
    expect(useStore.getState().toasts.at(-1)?.message).toBe('False start by Anna!')
  })
})
