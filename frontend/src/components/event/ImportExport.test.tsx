import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImportExport } from './ImportExport'
import { api, ApiError } from '../../lib/api'
import { exportFilename, parseBundle } from '../../lib/bundle'
import { useStore } from '../../lib/store'
import type { ExportBundle } from '../../lib/types'

const bundle: ExportBundle = {
  format: 'carrera-rms',
  version: 1,
  exported_at: '2026-01-01T00:00:00Z',
  app_version: '1',
  drivers: [],
}
const file = (text: string) => new File([text], 'backup.json', { type: 'application/json' })
const report = (applied: boolean) => ({ report: { drivers: { added: 2, updated: 1, removed: 0 } }, applied })

describe('bundle helpers', () => {
  it('names the file by local date and parses bundles', () => {
    expect(exportFilename(new Date(2026, 2, 5))).toBe('carrera-rms-2026-03-05.json')
    expect(parseBundle(JSON.stringify(bundle)).ok).toBe(true)
    expect(parseBundle('nope')).toEqual({ ok: false, code: 'import_invalid' })
    expect(parseBundle('{"format":"x","version":1}')).toEqual({ ok: false, code: 'import_invalid' })
  })
})

describe('ImportExport', () => {
  beforeEach(() => useStore.setState({ language: 'en' }))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the dry-run report first and applies only after confirmation', async () => {
    const imp = vi.spyOn(api, 'importBundle').mockImplementation(async (_b, _m, dry) => report(!dry))
    render(<ImportExport />)
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file(JSON.stringify(bundle))] } })
    expect(await screen.findByTestId('import-report')).toHaveTextContent('nothing has been changed yet')
    expect(imp).toHaveBeenCalledTimes(1)
    expect(imp.mock.calls[0][2]).toBe(true)
    fireEvent.click(screen.getByTestId('import-apply'))
    await waitFor(() => expect(imp).toHaveBeenCalledTimes(2))
    expect(imp.mock.calls[1]).toEqual([bundle, 'merge', false])
    expect(await screen.findByText(/Imported backup.json/)).toBeInTheDocument()
    expect(screen.queryByTestId('import-apply')).toBeNull()
  })

  it('warns on replace and re-runs the dry run with that mode', async () => {
    const imp = vi.spyOn(api, 'importBundle').mockResolvedValue(report(false))
    render(<ImportExport />)
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file(JSON.stringify(bundle))] } })
    await screen.findByTestId('import-report')
    fireEvent.click(screen.getByLabelText(/Replace/))
    expect(screen.getByTestId('replace-warning')).toBeInTheDocument()
    await waitFor(() => expect(imp).toHaveBeenCalledTimes(2))
    expect(imp.mock.calls[1]).toEqual([bundle, 'replace', true])
  })

  it('rejects a file that is not a bundle without calling the backend', async () => {
    const imp = vi.spyOn(api, 'importBundle')
    render(<ImportExport />)
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file('{"hello":1}')] } })
    expect(await screen.findByTestId('import-error')).toHaveTextContent('not a valid Carrera export')
    expect(imp).not.toHaveBeenCalled()
  })

  it('refuses an oversize file before reading it, and survives an unreadable one', async () => {
    const imp = vi.spyOn(api, 'importBundle')
    render(<ImportExport />)
    const big = file('{}')
    const text = vi.spyOn(big, 'text')
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [big] } })
    expect(await screen.findByTestId('import-error')).toHaveTextContent('max 5 MB')
    expect(text).not.toHaveBeenCalled()
    const broken = file('{}')
    vi.spyOn(broken, 'text').mockRejectedValue(new Error('read'))
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [broken] } })
    await waitFor(() => expect(screen.getByTestId('import-error')).toHaveTextContent('not a valid Carrera export'))
    expect(imp).not.toHaveBeenCalled()
  })

  it('translates import_unsupported from the backend', async () => {
    vi.spyOn(api, 'importBundle').mockRejectedValue(new ApiError(422, 'v9', 'import_unsupported'))
    render(<ImportExport />)
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file(JSON.stringify(bundle))] } })
    expect(await screen.findByTestId('import-error')).toHaveTextContent('newer version')
    expect(screen.queryByTestId('import-apply')).toBeNull()
  })

  it('exports the chosen sections as a download', async () => {
    const exp = vi.spyOn(api, 'exportBundle').mockResolvedValue(bundle)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    render(<ImportExport />)
    fireEvent.click(screen.getByLabelText('Records')) // untick
    fireEvent.click(screen.getByTestId('export-btn'))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(exp).toHaveBeenCalledWith(['settings', 'drivers', 'programs', 'layouts'])
  })
})
