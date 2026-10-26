import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CameraPage } from './CameraPage'
import { api } from '../lib/api'
import { cameraEngine } from '../lib/camera/engine'
import { useStore } from '../lib/store'
import type { TrackLayout } from '../lib/types'
import { car, raceState } from '../test/fixtures'

const layout: TrackLayout = {
  name: 'Kitchen',
  points: [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ],
  aspect: 1,
  sensors: [],
  pit_s: null,
  source: 'drawn',
  updated_at: '2026-01-01T00:00:00Z',
}

const BOX = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) }

/** Client coordinates of a display-space point on the layout map (viewBox padded by 0.08). */
const mapXY = (x: number, y: number) => ({ clientX: ((x + 0.08) / 1.16) * 640, clientY: ((y + 0.08) / 1.16) * 480 })
const imgXY = (x: number, y: number) => ({ clientX: x * 640, clientY: y * 480 })

describe('CameraPage', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(BOX as DOMRect)
    useStore.setState({
      language: 'en',
      camera: {},
      race: raceState({ layout: 'Kitchen', cars: [car({ address: 0, name: 'Rosso' }), car({ address: 1, name: 'Blu', color: '#1e88e5' })] }),
    })
  })
  afterEach(() => {
    cleanup()
    cameraEngine.stop()
    cameraEngine.setBackground(false)
    vi.restoreAllMocks()
  })

  it('says that video never leaves the browser and offers both sources', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    render(<CameraPage />)
    expect(screen.getByTestId('camera-privacy')).toHaveTextContent('never leaves this browser')
    expect(screen.getByRole('button', { name: 'Simulated camera' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Webcam' }))
    expect(screen.getByRole('combobox', { name: 'Camera device' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start camera' })).toBeEnabled())
  })

  it('links to the track editor when the layout has no map', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(null)
    render(<CameraPage />)
    expect(await screen.findByTestId('camera-no-layout')).toHaveTextContent('Kitchen')
    expect(screen.getByRole('button', { name: 'Start camera' })).toBeDisabled()
  })

  it('runs the calibration wizard: start line first, then image ↔ layout pairs, save', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    render(<CameraPage />)
    const startBtn = await screen.findByRole('button', { name: 'Start camera' })
    await waitFor(() => expect(startBtn).toBeEnabled())
    await act(async () => fireEvent.click(startBtn))
    expect(cameraEngine.getSnapshot().running).toBe(true)
    expect(screen.getByTestId('camera-instruction')).toHaveTextContent('start/finish line')
    const view = screen.getByTestId('camera-view')
    // 1: the start line (layout point implied).
    fireEvent.click(view, imgXY(0.15, 0.2))
    expect(screen.getByText(/Add 3 more points/)).toBeInTheDocument()
    // 2..4: image point, then the same point on the map.
    const corners: [number, number, number, number][] = [
      [0.85, 0.2, 0.9, 0.1],
      [0.95, 0.9, 0.9, 0.9],
      [0.05, 0.9, 0.1, 0.9],
    ]
    for (const [ix, iy, lx, ly] of corners) {
      fireEvent.click(view, imgXY(ix, iy))
      expect(screen.getByTestId('camera-instruction')).toHaveTextContent('same point on the layout map')
      expect(screen.getByTestId('camera-layout-map')).toHaveAttribute('data-active', 'true')
      fireEvent.click(screen.getByTestId('camera-layout-map'), mapXY(lx, ly))
    }
    expect(screen.getAllByTestId('camera-layout-point')).toHaveLength(4)
    expect(screen.getByTestId('camera-error')).toHaveTextContent('Reprojection error: 0.0 %')
    expect(cameraEngine.getSnapshot().calibrated).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('status')).toHaveTextContent('Calibration saved')
    const stored = JSON.parse(localStorage.getItem('carrera.camera.Kitchen')!)
    expect(stored.pairs).toHaveLength(4)
    expect(stored.pairs[0].layout).toEqual([0.1, 0.1])
    // Undo removes the last pair and invalidates the view.
    fireEvent.click(screen.getByRole('button', { name: 'Undo last point' }))
    expect(screen.getByText(/Add 1 more point \(/)).toBeInTheDocument()
    expect(cameraEngine.getSnapshot().calibrated).toBe(false)
  })

  it('loads a stored calibration and rejects an invalid import', async () => {
    localStorage.setItem(
      'carrera.camera.Kitchen',
      JSON.stringify({
        version: 1,
        layout: 'Kitchen',
        saved_at: '',
        pairs: [
          { image: [0.1, 0.1], layout: [0.1, 0.1] },
          { image: [0.9, 0.1], layout: [0.9, 0.1] },
          { image: [0.9, 0.9], layout: [0.9, 0.9] },
          { image: [0.1, 0.9], layout: [0.1, 0.9] },
        ],
      }),
    )
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    const { container } = render(<CameraPage />)
    expect(await screen.findByTestId('camera-error')).toHaveAttribute('data-grade', 'good')
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    const file = new File(['{"version": 1, "pairs": 3}'], 'bad.json', { type: 'application/json' })
    await act(async () => fireEvent.change(input, { target: { files: [file] } }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not a camera calibration')
  })

  it('samples a car colour by clicking it', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    render(<CameraPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start camera' })).toBeEnabled())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })))
    fireEvent.click(screen.getByRole('button', { name: 'Car colours' }))
    const spy = vi.spyOn(cameraEngine, 'captureSignature').mockReturnValue(true)
    fireEvent.click(screen.getAllByRole('button', { name: 'Sample colour' })[1])
    expect(screen.getByTestId('camera-instruction')).toHaveTextContent('Click Blu on the camera image')
    fireEvent.click(screen.getByTestId('camera-view'), imgXY(0.5, 0.25))
    expect(spy).toHaveBeenCalledWith(1, 0.5, 0.25)
    expect(screen.getByRole('status')).toHaveTextContent('Colour of Blu sampled')
  })

  it('stops the camera when the page closes, unless it keeps tracking in the background', async () => {
    vi.spyOn(api, 'findLayout').mockResolvedValue(layout)
    const first = render(<CameraPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start camera' })).toBeEnabled())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })))
    first.unmount()
    expect(cameraEngine.getSnapshot().running).toBe(false)

    const second = render(<CameraPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start camera' })).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep tracking/ }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })))
    second.unmount()
    expect(cameraEngine.getSnapshot().running).toBe(true)
  })
})
