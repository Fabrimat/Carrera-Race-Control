import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import { useStore } from '../lib/store'
import type { LayoutDraft, TrackLayout } from '../lib/types'
import { settingsResponse } from '../test/fixtures'
import { TrackEditor } from './TrackEditor'

const mocks = vi.hoisted(() => ({
  layout: vi.fn(),
  layouts: vi.fn(),
  saveLayout: vi.fn(),
  deleteLayout: vi.fn(),
  layoutFromPhoto: vi.fn(),
  prepareImage: vi.fn(),
}))

vi.mock('../lib/api', async (orig) => {
  const real = await orig<typeof import('../lib/api')>()
  return { ...real, api: { ...real.api, ...mocks } }
})
vi.mock('../lib/photo', async (orig) => {
  const real = await orig<typeof import('../lib/photo')>()
  return { ...real, prepareImage: mocks.prepareImage }
})

const circle = (n: number, r = 0.4): [number, number][] =>
  Array.from({ length: n }, (_, i) => [
    0.5 + r * Math.cos((2 * Math.PI * i) / n),
    0.5 + r * Math.sin((2 * Math.PI * i) / n),
  ])

const layoutOf = (over: Partial<TrackLayout> = {}): TrackLayout => ({
  name: 'Home',
  points: circle(80),
  aspect: 1.5,
  sensors: [],
  pit_s: null,
  source: 'drawn',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

function mockRect(svg: Element) {
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

const ptr = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 })

async function drawLoop(svg: Element) {
  const pts = circle(60, 0.35)
  fireEvent.pointerDown(svg, ptr(pts[0][0] * 1000, pts[0][1] * 1000))
  for (const p of pts.slice(1, 56)) fireEvent.pointerMove(svg, ptr(p[0] * 1000, p[1] * 1000))
  fireEvent.pointerUp(svg, ptr(pts[55][0] * 1000, pts[55][1] * 1000))
}

describe('TrackEditor', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset())
    useStore.setState({ language: 'en', settings: settingsResponse() })
    mocks.layout.mockRejectedValue(new ApiError(404, 'not found', 'layout_not_found'))
    mocks.layouts.mockResolvedValue({ layouts: [] })
  })

  it('turns a freehand stroke into a closed resampled path with handles', async () => {
    render(<TrackEditor layout="Fresh" />)
    const svg = await screen.findByTestId('track-canvas')
    mockRect(svg)
    await drawLoop(svg)
    const path = await screen.findByTestId('track-path')
    expect(path.getAttribute('points')!.trim().split(' ')).toHaveLength(150)
    expect(screen.getByTestId('handle-0')).toBeInTheDocument()
    expect(screen.getByTestId('handle-23')).toBeInTheDocument()
    expect(screen.getAllByTestId('track-arrow').length).toBeGreaterThan(0)
    expect(screen.getByTestId('dirty-badge')).toBeInTheDocument()
  })

  it('dragging a handle moves it, undo restores it', async () => {
    mocks.layout.mockResolvedValue(layoutOf())
    render(<TrackEditor layout="Home" />)
    const svg = await screen.findByTestId('track-canvas')
    mockRect(svg)
    const handle = await screen.findByTestId('handle-5')
    const dot = () => screen.getByTestId('handle-5').querySelectorAll('circle')[1].getAttribute('cx')
    const before = dot()
    fireEvent.pointerDown(handle, ptr(300, 300))
    fireEvent.pointerMove(svg, ptr(400, 450))
    fireEvent.pointerUp(svg, ptr(400, 450))
    expect(dot()).not.toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(dot()).toBe(before)
  })

  it('adds Check Lane sensors and saves them with the layout', async () => {
    mocks.layout.mockResolvedValue(layoutOf())
    mocks.saveLayout.mockImplementation(async (l: TrackLayout) => l)
    render(<TrackEditor layout="Home" />)
    await screen.findByTestId('track-canvas')
    fireEvent.click(screen.getByRole('button', { name: /Add Check Lane S2/ }))
    expect(screen.getByTestId('marker-sensor-2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalled())
    const saved = mocks.saveLayout.mock.calls[0][0] as TrackLayout
    expect(saved.name).toBe('Home')
    expect(saved.sensors.map((s) => s.sensor)).toEqual([2])
    expect(saved.source).toBe('drawn')
    await waitFor(() => expect(screen.queryByTestId('dirty-badge')).toBeNull())
  })

  it('reverse direction keeps the start/finish line', async () => {
    mocks.layout.mockResolvedValue(layoutOf())
    render(<TrackEditor layout="Home" />)
    await screen.findByTestId('track-canvas')
    const first = () => screen.getByTestId('track-path').getAttribute('points')!.split(' ')[0]
    const start = first()
    fireEvent.click(screen.getByRole('button', { name: /Reverse direction/ }))
    expect(first()).toBe(start)
  })

  it('photo flow: shows the privacy notice, then loads the draft over the photo', async () => {
    const draft: LayoutDraft = { layout: layoutOf({ source: 'photo', aspect: 1.78 }), notes: 'Looks like an oval' }
    mocks.prepareImage.mockResolvedValue({ base64: 'QUJD', dataUrl: 'data:image/jpeg;base64,QUJD', width: 16, height: 9 })
    mocks.layoutFromPhoto.mockResolvedValue(draft)
    mocks.saveLayout.mockImplementation(async (l: TrackLayout) => l)
    render(<TrackEditor layout="Photo" />)
    await screen.findByTestId('track-canvas')
    fireEvent.click(screen.getByRole('button', { name: 'From a photo' }))
    expect(screen.getByTestId('photo-notice')).toHaveTextContent(/sent to Anthropic/)
    expect(screen.getByTestId('photo-notice')).toHaveTextContent(/re-encoded in your browser/)
    const file = new File(['x'], 'track.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByTestId('photo-input'), { target: { files: [file] } })
    expect(await screen.findByTestId('photo-notes')).toHaveTextContent('Looks like an oval')
    expect(mocks.layoutFromPhoto).toHaveBeenCalledWith({
      image_base64: 'QUJD',
      media_type: 'image/jpeg',
      name: 'Photo',
      language: 'en',
    })
    expect(screen.getByTestId('track-path')).toBeInTheDocument()
    expect(screen.getByTestId('track-canvas').querySelector('image')).not.toBeNull()
    // Saving fits the drawing to the frame (bounding box 0..1).
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalled())
    const saved = mocks.saveLayout.mock.calls[0][0] as TrackLayout
    expect(saved.source).toBe('photo')
    expect(Math.max(...saved.points.map((p) => p[0]))).toBeCloseTo(1, 5)
    expect(Math.min(...saved.points.map((p) => p[1]))).toBeCloseTo(0, 5)
  })

  it('still fits a photo draft to the frame after hiding the photo', async () => {
    const draft: LayoutDraft = {
      layout: layoutOf({ source: 'photo', aspect: 1.78, points: circle(80, 0.2).map(([x, y]) => [x * 0.5 + 0.1, y]) }),
      notes: '',
    }
    mocks.prepareImage.mockResolvedValue({ base64: 'QUJD', dataUrl: 'data:image/jpeg;base64,QUJD', width: 16, height: 9 })
    mocks.layoutFromPhoto.mockResolvedValue(draft)
    mocks.saveLayout.mockImplementation(async (l: TrackLayout) => l)
    render(<TrackEditor layout="Photo" />)
    await screen.findByTestId('track-canvas')
    fireEvent.click(screen.getByRole('button', { name: 'From a photo' }))
    fireEvent.change(screen.getByTestId('photo-input'), { target: { files: [new File(['x'], 't.jpg', { type: 'image/jpeg' })] } })
    await screen.findByTestId('photo-notes').catch(() => null)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide photo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalled())
    const saved = mocks.saveLayout.mock.calls[0][0] as TrackLayout
    expect(Math.max(...saved.points.map((p) => p[0]))).toBeCloseTo(1, 5)
    expect(Math.min(...saved.points.map((p) => p[0]))).toBeCloseTo(0, 5)
  })

  it('translates photo errors', async () => {
    mocks.prepareImage.mockResolvedValue({ base64: 'QUJD', dataUrl: 'data:x', width: 1, height: 1 })
    mocks.layoutFromPhoto.mockRejectedValue(new ApiError(422, 'no track', 'photo_unrecognised'))
    useStore.setState({ language: 'it' })
    render(<TrackEditor layout="Photo" />)
    await screen.findByTestId('track-canvas')
    fireEvent.click(screen.getByRole('button', { name: 'Da una foto' }))
    fireEvent.change(screen.getByTestId('photo-input'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Nessuna pista riconosciuta')
  })

  it('warns before following a link while dirty', async () => {
    mocks.layout.mockResolvedValue(layoutOf())
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(
      <>
        <a href="#/settings">settings</a>
        <TrackEditor layout="Home" />
      </>,
    )
    await screen.findByTestId('track-canvas')
    fireEvent.click(screen.getByRole('button', { name: /Add Check Lane S2/ }))
    fireEvent.click(screen.getByText('settings'))
    expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })
})

describe('LayoutPicker', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset())
    useStore.setState({ language: 'en', settings: settingsResponse() })
  })

  it('lists layouts, duplicates, deletes with confirm and sets the layout in use', async () => {
    const home = layoutOf({ name: 'Default' })
    mocks.layouts.mockResolvedValueOnce({ layouts: [home, layoutOf({ name: 'Garage' })] })
    mocks.layouts.mockResolvedValue({ layouts: [home, layoutOf({ name: 'Garage' }), layoutOf({ name: 'Garage copy' })] })
    mocks.saveLayout.mockImplementation(async (l: TrackLayout) => l)
    mocks.deleteLayout.mockResolvedValue({ layouts: [home] })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<TrackEditor layout={null} />)
    expect(await screen.findByTestId('layout-Garage')).toBeInTheDocument()
    expect(screen.getByTestId('layout-Default')).toHaveTextContent('In use')

    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[1])
    await waitFor(() => expect(mocks.saveLayout).toHaveBeenCalled())
    expect((mocks.saveLayout.mock.calls[0][0] as TrackLayout).name).toBe('Garage copy')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1])
    await waitFor(() => expect(mocks.deleteLayout).toHaveBeenCalledWith('Garage'))
    expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })
})
