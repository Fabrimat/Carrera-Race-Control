import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useStore } from '../lib/store'
import { fakeSettingsServer, settingsResponse } from '../test/fixtures'
import { SettingsPage } from './SettingsPage'

describe('SettingsPage AI provider', () => {
  beforeEach(() => {
    useStore.setState({
      settings: settingsResponse({ keys: { elevenlabs: false, anthropic: true, openai: false } }),
      language: 'en',
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows both key statuses, never a key value', () => {
    render(<SettingsPage />)
    expect(screen.getByTestId('key-Anthropic')).toHaveTextContent('configured')
    expect(screen.getByTestId('key-OpenAI')).toHaveTextContent('missing')
  })

  it('renders the provider select and saves the choice', async () => {
    const srv = fakeSettingsServer(useStore.getState().settings!)
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<SettingsPage />)
    const select = screen.getByTestId('llm-provider') as HTMLSelectElement
    expect(select.value).toBe('anthropic')
    expect([...select.options].map((o) => o.value)).toEqual(['anthropic', 'openai'])
    fireEvent.change(select, { target: { value: 'openai' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(srv.puts).toHaveLength(1))
    expect(srv.puts[0].commentary.llm_provider).toBe('openai')
  })
})
