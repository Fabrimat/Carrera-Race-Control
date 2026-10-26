import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../components/Modal'
import { ShortcutHelp } from '../components/ShortcutHelp'
import { emptyRace, useStore } from './store'
import { raceState, settingsResponse } from '../test/fixtures'
import { useShortcuts } from './useShortcuts'

const mocks = vi.hoisted(() => ({
  startRace: vi.fn(),
  stopRace: vi.fn(),
  resetRace: vi.fn(),
  paceCar: vi.fn(),
  mute: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>()
  return { ...real, api: { ...real.api, ...mocks } }
})

function Harness({ children }: { children?: React.ReactNode }) {
  useShortcuts()
  return (
    <div>
      {children}
      <ShortcutHelp />
    </div>
  )
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element | Document = document.body) =>
  fireEvent.keyDown(target, { key, ...init })

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset().mockResolvedValue(raceState())
  mocks.mute.mockResolvedValue({ muted: true })
  useStore.setState({
    settings: settingsResponse(),
    race: raceState({ phase: 'idle' }),
    raceOverride: {},
    helpOpen: false,
    language: 'en',
  })
  window.location.hash = '#/'
})
afterEach(() => vi.restoreAllMocks())

describe('global shortcut listener', () => {
  it('Space starts the race through the same path as the Start button', async () => {
    render(<Harness />)
    press(' ')
    await waitFor(() => expect(mocks.startRace).toHaveBeenCalledTimes(1))
    // idle, no session: the effective config goes in the body
    expect(mocks.startRace.mock.calls[0][0]).toMatchObject({ mode: emptyRace.config.mode })
  })

  it('starts without a body during an event session', async () => {
    const race = raceState({ phase: 'idle' })
    race.session = { program_id: 'p', program_name: 'P', session_id: 's', kind: 'race', name: 'F', index: 0, total: 1 }
    useStore.setState({ race })
    render(<Harness />)
    press(' ')
    await waitFor(() => expect(mocks.startRace).toHaveBeenCalledTimes(1))
    expect(mocks.startRace.mock.calls[0]).toEqual([])
  })

  it('does not start while a race is running, and calls preventDefault when it handles a key', async () => {
    useStore.setState({ race: raceState({ phase: 'running' }) })
    render(<Harness />)
    const notPrevented = press(' ')
    expect(notPrevented).toBe(false) // preventDefault was called
    expect(mocks.startRace).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+S stops a running race; plain letters never do', async () => {
    useStore.setState({ race: raceState({ phase: 'running' }) })
    render(<Harness />)
    press('s')
    press('Escape')
    expect(mocks.stopRace).not.toHaveBeenCalled()
    press('S', { ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(mocks.stopRace).toHaveBeenCalledTimes(1))
  })

  it('P toggles the pace car only while racing', async () => {
    render(<Harness />)
    press('p')
    expect(mocks.paceCar).not.toHaveBeenCalled()
    useStore.setState({ race: raceState({ phase: 'running' }) })
    press('p')
    await waitFor(() => expect(mocks.paceCar).toHaveBeenCalledTimes(1))
  })

  it('M cycles the mode and +/- adjust laps and duration', () => {
    render(<Harness />)
    const mode = () => useStore.getState().raceOverride.mode ?? useStore.getState().race.config.mode
    expect(mode()).toBe('practice')
    press('m')
    expect(mode()).toBe('laps')
    const laps = () => useStore.getState().raceOverride.target_laps ?? useStore.getState().race.config.target_laps
    const before = laps()
    press('+', { shiftKey: true })
    expect(laps()).toBe(before + 1)
    press('-')
    press('-')
    expect(laps()).toBe(before - 1)
    press('m')
    expect(mode()).toBe('timed')
    press('+')
    expect(useStore.getState().raceOverride.duration_s).toBe(useStore.getState().race.config.duration_s + 30)
  })

  it('a rebound combo replaces the default and "" disables an action', async () => {
    useStore.setState({ settings: settingsResponse({ shortcuts: { 'race.start': 'Shift+G', 'race.pace_car': '' } }) })
    useStore.setState({ race: raceState({ phase: 'running' }) })
    render(<Harness />)
    press('p')
    expect(mocks.paceCar).not.toHaveBeenCalled()
    useStore.setState({ race: raceState({ phase: 'idle' }) })
    press(' ')
    expect(mocks.startRace).not.toHaveBeenCalled()
    press('G', { shiftKey: true })
    await waitFor(() => expect(mocks.startRace).toHaveBeenCalledTimes(1))
  })

  it('navigates with number keys', () => {
    render(<Harness />)
    press('2')
    expect(window.location.hash).toBe('#/history')
    press('6')
    expect(window.location.hash).toBe('#/settings')
    press('t')
    expect(window.location.hash).toBe('#/tv')
  })

  it('ignores keys typed in inputs, textareas, selects and contenteditable', () => {
    render(
      <Harness>
        <input aria-label="text" />
        <textarea aria-label="area" />
        <select aria-label="sel">
          <option>a</option>
        </select>
        <div contentEditable suppressContentEditableWarning aria-label="ce">
          <span data-testid="inner">x</span>
        </div>
      </Harness>,
    )
    for (const el of [
      screen.getByLabelText('text'),
      screen.getByLabelText('area'),
      screen.getByLabelText('sel'),
      screen.getByTestId('inner'),
    ]) {
      press(' ', {}, el)
      press('2', {}, el)
    }
    expect(mocks.startRace).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
  })

  it('ignores everything while a modal is open, and Escape in a modal does not stop the race', () => {
    useStore.setState({
      race: raceState({ phase: 'running' }),
      settings: settingsResponse({ shortcuts: { 'race.stop': 'Escape' } }),
    })
    const onClose = vi.fn()
    render(
      <Harness>
        <Modal label="dlg" onClose={onClose}>
          <button>inside</button>
        </Modal>
      </Harness>,
    )
    press('Escape', {}, screen.getByRole('dialog'))
    press('Escape')
    press('2')
    expect(mocks.stopRace).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
    expect(onClose).toHaveBeenCalled() // the modal's own Escape still closes it
  })

  it('leaves Space on a focused button to that button (fires once, never twice)', () => {
    const onClick = vi.fn()
    render(
      <Harness>
        <button onClick={onClick}>press me</button>
      </Harness>,
    )
    const button = screen.getByRole('button', { name: 'press me' })
    button.focus()
    const notPrevented = press(' ', {}, button)
    expect(notPrevented).toBe(true) // not intercepted: the button's own activation stays
    expect(mocks.startRace).not.toHaveBeenCalled()
    // other keys on a focused button still reach the shortcuts
    press('2', {}, button)
    expect(window.location.hash).toBe('#/history')
  })

  it('ignores held-down repeats except for repeatable actions', async () => {
    render(<Harness />)
    press(' ', { repeat: true })
    expect(mocks.startRace).not.toHaveBeenCalled()
    const before = useStore.getState().raceOverride
    useStore.setState({ raceOverride: { mode: 'laps', target_laps: 5 } })
    press('+', { repeat: true })
    expect(useStore.getState().raceOverride.target_laps).toBe(6)
    useStore.setState({ raceOverride: before })
  })

  it('does not react to AltGr, dead keys or Meta combos', () => {
    render(<Harness />)
    press('2', { ctrlKey: true, altKey: true })
    press('Dead')
    press('2', { metaKey: true })
    expect(window.location.hash).toBe('#/')
  })

  it('moves focus between leaderboard name controls with J / K', () => {
    render(
      <Harness>
        {[0, 1, 2].map((i) => (
          <div key={i} data-testid="leaderboard-row">
            <button data-testid="rename-button" aria-label={`car ${i}`} />
          </div>
        ))}
      </Harness>,
    )
    press('j')
    expect(screen.getByLabelText('car 0')).toHaveFocus()
    press('j', {}, screen.getByLabelText('car 0'))
    expect(screen.getByLabelText('car 1')).toHaveFocus()
    press('k', {}, screen.getByLabelText('car 1'))
    expect(screen.getByLabelText('car 0')).toHaveFocus()
    press('k', {}, screen.getByLabelText('car 0'))
    expect(screen.getByLabelText('car 2')).toHaveFocus() // wraps around
  })

  it('toggles commentary mute through the API', async () => {
    render(<Harness />)
    press('M', { shiftKey: true })
    await waitFor(() => expect(mocks.mute).toHaveBeenCalledWith(true))
    await waitFor(() => expect(useStore.getState().muted).toBe(true))
  })
})

describe('help overlay', () => {
  it('opens on "?" (also from an IT layout event), lists every shortcut in the UI language, closes on Esc', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).toBeNull()
    press('?', { shiftKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Start race')).toBeInTheDocument()
    expect(screen.getAllByTestId('shortcut-row').length).toBeGreaterThan(20)
    press('Escape')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is translated to Italian and shows rebound combos; "?" closes it again', () => {
    useStore.setState({ language: 'it', settings: settingsResponse({ shortcuts: { 'race.pace_car': 'Shift+X' } }) })
    render(<Harness />)
    press('?')
    expect(screen.getByRole('dialog', { name: 'Scorciatoie da tastiera' })).toBeInTheDocument()
    expect(screen.getByText('Avvia la gara')).toBeInTheDocument()
    const row = screen.getByText('Pace car on / off').closest('li') as HTMLElement
    expect(row).toHaveTextContent('Shift')
    expect(row).toHaveTextContent('X')
    press('?')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not block shortcuts while it is the only dialog open', () => {
    render(<Harness />)
    press('?')
    press('2')
    expect(window.location.hash).toBe('#/history')
  })
})
