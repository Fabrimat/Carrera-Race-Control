import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { LogosSection } from './LogosSection'
import { CarsSection } from './CarsSection'
import { Leaderboard } from './Leaderboard'
import { checkLogoFile, MAX_LOGO_BYTES, nameFromFile, useLogos } from '../lib/logos'
import { useStore } from '../lib/store'
import { car, fakeSettingsServer, settingsResponse } from '../test/fixtures'
import type { Logo } from '../lib/types'

const ferrari: Logo = { id: 'ferrari', name: 'Ferrari', media_type: 'image/png', updated_at: '2026-01-01T00:00:00Z' }
const audi: Logo = { id: 'audi', name: 'Audi', media_type: 'image/svg+xml', updated_at: '2026-01-02T00:00:00Z' }

interface Call {
  method: string
  url: string
  body: unknown
}

/** Fake logo backend: records calls, keeps a list, answers the logo endpoints. */
function fakeLogoApi(initial: Logo[] = []) {
  let logos = [...initial]
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
    if (url === '/api/logos' && method === 'GET') return json({ logos })
    if (url === '/api/logos' && method === 'POST') {
      const created: Logo = { id: 'new-logo', name: body.name, media_type: 'image/png', updated_at: '2026-02-01T00:00:00Z' }
      logos = [...logos, created]
      return json(created, 201)
    }
    if (url.startsWith('/api/logos/') && method === 'PUT') {
      const id = url.split('/')[3]
      logos = logos.map((l) => (l.id === id ? { ...l, name: body.name } : l))
      return json(logos.find((l) => l.id === id))
    }
    if (url.startsWith('/api/logos/') && method === 'DELETE') {
      logos = logos.filter((l) => l.id !== url.split('/')[3])
      return json({ logos })
    }
    if (url === '/api/settings' && method === 'GET') return json(settingsResponse())
    return json({ detail: 'unexpected' }, 500)
  })
  return { calls, fetchMock }
}

function pngFile(name = 'brand.png', size = 16, type = 'image/png') {
  return new File([new Uint8Array(size)], name, { type })
}

describe('logo file checks', () => {
  it('accepts the four types and rejects others or oversize files', () => {
    expect(checkLogoFile({ name: 'a.png', type: 'image/png', size: 10 })).toBeNull()
    expect(checkLogoFile({ name: 'a.svg', type: 'image/svg+xml', size: 10 })).toBeNull()
    expect(checkLogoFile({ name: 'a.svg', type: '', size: 10 })).toBeNull()
    expect(checkLogoFile({ name: 'a.gif', type: 'image/gif', size: 10 })).toBe('invalid_image')
    expect(checkLogoFile({ name: 'a.png', type: 'image/png', size: MAX_LOGO_BYTES + 1 })).toBe('image_too_large')
    expect(checkLogoFile({ name: 'a.png', type: 'image/png', size: MAX_LOGO_BYTES })).toBeNull()
  })

  it('derives a name from the file name', () => {
    expect(nameFromFile('ferrari-logo.png')).toBe('ferrari-logo')
    expect(nameFromFile('.png')).toBe('Logo')
  })
})

describe('LogosSection', () => {
  beforeEach(() => {
    useLogos.setState({ logos: [], loaded: false })
    useStore.setState({ language: 'en', settings: settingsResponse(), toasts: [] })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists the library and uploads a new logo as base64', async () => {
    const srv = fakeLogoApi([ferrari])
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<LogosSection />)
    await screen.findByDisplayValue('Ferrari')

    fireEvent.change(screen.getByTestId('logo-upload-input'), { target: { files: [pngFile('Maserati.png')] } })
    await screen.findByDisplayValue('Maserati')
    const post = srv.calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe('/api/logos')
    expect(post.body).toMatchObject({ name: 'Maserati', image_base64: 'AAAAAAAAAAAAAAAAAAAAAA==' })
  })

  it('rejects an oversized file on the client without calling the backend', async () => {
    const srv = fakeLogoApi()
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<LogosSection />)
    await waitFor(() => expect(srv.calls).toHaveLength(1))
    fireEvent.change(screen.getByTestId('logo-upload-input'), {
      target: { files: [pngFile('big.png', MAX_LOGO_BYTES + 1)] },
    })
    await waitFor(() => expect(useStore.getState().toasts.map((x) => x.message)).toContain('That file is larger than 512 KB.'))
    expect(srv.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('rejects a file of the wrong type', async () => {
    const srv = fakeLogoApi()
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<LogosSection />)
    await waitFor(() => expect(srv.calls).toHaveLength(1))
    fireEvent.change(screen.getByTestId('logo-upload-input'), {
      target: { files: [pngFile('anim.gif', 10, 'image/gif')] },
    })
    await waitFor(() =>
      expect(useStore.getState().toasts.map((x) => x.message)).toContain('Use a PNG, JPEG, WebP or SVG image.'),
    )
  })

  it('renames on blur', async () => {
    const srv = fakeLogoApi([ferrari])
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<LogosSection />)
    const input = await screen.findByDisplayValue('Ferrari')
    fireEvent.change(input, { target: { value: 'Scuderia' } })
    fireEvent.blur(input)
    await waitFor(() => expect(srv.calls.some((c) => c.method === 'PUT')).toBe(true))
    expect(srv.calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/logos/ferrari',
      body: { name: 'Scuderia', image_base64: null },
    })
  })

  it('deletes only after a confirmation', async () => {
    const srv = fakeLogoApi([ferrari, audi])
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<LogosSection />)
    const rows = await screen.findAllByTestId('logo-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(within(rows[1]).getByTestId('logo-delete'))
    expect(srv.calls.some((c) => c.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByTestId('logo-confirm-delete'))
    await waitFor(() => expect(screen.getAllByTestId('logo-row')).toHaveLength(1))
    expect(srv.calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/logos/audi')
  })
})

describe('logo picker in the cars settings', () => {
  beforeEach(() => {
    useLogos.setState({ logos: [ferrari, audi], loaded: true })
    useStore.setState({ language: 'en', settings: settingsResponse() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('saves the chosen logo_id with the car', async () => {
    const srv = fakeSettingsServer(settingsResponse())
    vi.stubGlobal('fetch', srv.fetchMock)
    render(<CarsSection cars={settingsResponse().cars} />)
    const selects = screen.getAllByTestId('car-logo-select') as HTMLSelectElement[]
    expect([...selects[0].options].map((o) => o.textContent)).toEqual(['No logo', 'Ferrari', 'Audi'])
    fireEvent.change(selects[1], { target: { value: 'audi' } })
    await waitFor(() => expect(srv.puts).toHaveLength(1), { timeout: 3000 })
    expect(srv.puts[0].cars.map((c) => c.logo_id)).toEqual([null, 'audi'])
  })
})

describe('Leaderboard logos', () => {
  beforeEach(() => {
    useLogos.setState({ logos: [ferrari], loaded: true })
    useStore.setState({ language: 'en' })
  })

  it('shows the logo of a car, with the logo name as alt, and none for cars without', () => {
    const cars = [car({ address: 0, name: 'Rosso', position: 1, logo_id: 'ferrari' }), car({ address: 1, name: 'Blu', position: 2 })]
    render(<Leaderboard cars={cars} bestLap={null} fuelMode={false} />)
    const rows = screen.getAllByTestId('leaderboard-row')
    const img = within(rows[0]).getByAltText('Ferrari')
    expect(img.tagName).toBe('IMG')
    expect(img).toHaveAttribute('src', '/api/logos/ferrari/image?v=2026-01-01T00%3A00%3A00Z')
    expect(within(rows[1]).queryByTestId('car-logo')).toBeNull()
  })

  it('hides the image when it fails to load', () => {
    render(<Leaderboard cars={[car({ address: 0, position: 1, logo_id: 'ferrari' })]} bestLap={null} fuelMode={false} />)
    fireEvent.error(screen.getByTestId('car-logo'))
    expect(screen.queryByTestId('car-logo')).toBeNull()
  })
})
