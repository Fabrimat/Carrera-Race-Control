import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ProgramEditor } from './ProgramEditor'
import { api, ApiError } from '../../lib/api'
import { newProgram } from '../../lib/program'
import { useStore } from '../../lib/store'

const base = () => newProgram('Open day', [])

describe('ProgramEditor', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('adds, reorders and removes sessions, forcing qualifying to timed', () => {
    render(<ProgramEditor program={base()} onSaved={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('add-qualifying'))
    fireEvent.click(screen.getByTestId('add-race'))
    let cards = screen.getAllByTestId('session-card')
    expect(cards).toHaveLength(3)
    // the qualifying mode select is locked to timed
    const mode = within(cards[1]).getByDisplayValue('Timed') as HTMLSelectElement
    expect(mode).toBeDisabled()
    // move the race up: order becomes practice, race, qualifying
    fireEvent.click(within(cards[2]).getByLabelText('Move session up'))
    cards = screen.getAllByTestId('session-card')
    expect(within(cards[1]).getByDisplayValue('Race')).toBeInTheDocument()
    fireEvent.click(within(cards[0]).getByLabelText('Remove session'))
    expect(screen.getAllByTestId('session-card')).toHaveLength(2)
  })

  it('only offers earlier sessions for the grid', () => {
    render(<ProgramEditor program={base()} onSaved={vi.fn()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('add-race'))
    const cards = screen.getAllByTestId('session-card')
    expect(within(cards[0]).getByLabelText('Starting order from')).toBeDisabled()
    const sel = within(cards[1]).getByLabelText('Starting order from') as HTMLSelectElement
    expect([...sel.options].map((o) => o.text)).toEqual(['None', '1. Practice'])
  })

  it('shows validation errors and does not save an invalid program', async () => {
    const save = vi.spyOn(api, 'saveProgram')
    render(<ProgramEditor program={base()} onSaved={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('program-name'), { target: { value: '  ' } })
    fireEvent.click(screen.getByTestId('program-save'))
    expect(await screen.findByTestId('program-issues')).toHaveTextContent('Give the program a name.')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves with the commentary context and shows a backend error', async () => {
    const save = vi
      .spyOn(api, 'saveProgram')
      .mockRejectedValueOnce(new ApiError(422, 'bad', 'invalid_request'))
      .mockImplementation(async (p) => p)
    const onSaved = vi.fn()
    render(<ProgramEditor program={base()} onSaved={onSaved} onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId('tone'), { target: { value: 'ironic' } })
    const sponsors = within(screen.getByTestId('sponsors')).getByRole('textbox')
    fireEvent.change(sponsors, { target: { value: 'Acme' } })
    fireEvent.keyDown(sponsors, { key: 'Enter' })
    const avoid = within(screen.getByTestId('avoid-words')).getByRole('textbox')
    fireEvent.change(avoid, { target: { value: 'crash' } })
    fireEvent.keyDown(avoid, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('program-save'))
    expect(await screen.findByTestId('program-issues')).toHaveTextContent('Invalid request.')
    fireEvent.click(screen.getByTestId('program-save'))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const sent = save.mock.calls[1][0]
    expect(sent.commentary).toMatchObject({ tone: 'ironic', sponsors: ['Acme'], avoid_words: ['crash'] })
  })
})
