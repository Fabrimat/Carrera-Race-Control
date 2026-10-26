import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Drivers } from './Drivers'
import { useStore } from '../lib/store'
import { settingsResponse } from '../test/fixtures'
import type { Driver } from '../lib/types'

const driver = (over: Partial<Driver> = {}): Driver => ({
  id: 'd1',
  name: 'Anna Rossi',
  nickname: null,
  bio: '',
  has_photo: false,
  controller: null,
  created_at: '',
  ...over,
})

describe('Drivers handicap profile', () => {
  let puts: Driver[]
  beforeEach(() => {
    puts = []
    useStore.setState({ settings: settingsResponse(), language: 'en', drivers: [driver()] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT' && url === '/api/drivers/d1') {
          const body = JSON.parse(String(init.body)) as Driver
          puts.push(body)
          return new Response(JSON.stringify(body))
        }
        if (url === '/api/drivers') return new Response(JSON.stringify({ drivers: [driver()] }))
        if (url === '/api/event') return new Response('{}', { status: 500 })
        return new Response('{}', { status: 500 })
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  const flush = () => act(() => new Promise((r) => setTimeout(r, 0)))

  it('overrides single fields and the rest inherits (null) in the PUT', async () => {
    render(<Drivers />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Anna Rossi' }))
    expect(screen.getByTestId('driver-ctl-speed-value')).toHaveTextContent("Inherit (car's value)")
    fireEvent.click(screen.getByTestId('driver-ctl-speed-toggle'))
    fireEvent.change(screen.getByTestId('driver-ctl-speed-slider'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(puts).toHaveLength(1)
    expect(puts[0].controller).toEqual({ speed: 5, brake: null, fuel: null })
  })

  it('no override at all is saved as null; a new driver has no profile section', async () => {
    useStore.setState({ drivers: [driver({ controller: { speed: 3, brake: null, fuel: null } })] })
    render(<Drivers />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Anna Rossi' }))
    fireEvent.click(screen.getByTestId('driver-ctl-clear'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(puts[0].controller).toBeNull()
  })

  it('a new driver form only points to editing later', () => {
    useStore.setState({ drivers: [] })
    render(<Drivers />)
    fireEvent.click(screen.getByTestId('add-driver'))
    expect(screen.queryByTestId('driver-ctl')).toBeNull()
    expect(screen.getByText(/Save the driver first/)).toBeInTheDocument()
  })
})
