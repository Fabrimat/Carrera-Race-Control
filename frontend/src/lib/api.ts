import type {
  ConnectionInfo,
  RaceConfig,
  RaceDetail,
  RaceState,
  RaceSummary,
  ScanDevice,
  Settings,
  SettingsResponse,
  Snapshot,
  TrackMode,
  TrackLayout,
  LayoutDraft,
  Driver,
  EventProgram,
  EventState,
  ExportBundle,
  ExportSection,
  ImportReport,
  Logo,
  TrackRecordInfo,
} from './types'

/**
 * status 0 = network failure (backend unreachable). `code` is the backend's stable error
 * code (docs/PROTOCOL.md "Error codes"), translated by `apiErrorMessage`; `detail` is the
 * English message, used as a fallback.
 */
export class ApiError extends Error {
  status: number
  detail: string | null
  code: string | null
  constructor(status: number, detail: string | null, code: string | null = null) {
    super(detail ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = code
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, null)
  }
  if (!res.ok) {
    let detail: string | null = null
    let code: string | null = null
    try {
      const j = await res.json()
      if (typeof j?.detail === 'string') detail = j.detail
      else if (j?.detail !== undefined) detail = JSON.stringify(j.detail)
      if (typeof j?.code === 'string') code = j.code
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail, code)
  }
  return (await res.json()) as T
}

export const api = {
  state: () => request<Snapshot>('GET', '/api/state'),
  scan: () => request<{ devices: ScanDevice[] }>('GET', '/api/track/scan'),
  connect: (mode: TrackMode, address: string | null) =>
    request<ConnectionInfo>('POST', '/api/connect', { mode, address }),
  disconnect: () => request<ConnectionInfo>('POST', '/api/disconnect'),
  startRace: (config?: RaceConfig) => request<RaceState>('POST', '/api/race/start', config),
  stopRace: () => request<RaceState>('POST', '/api/race/stop'),
  resetRace: () => request<RaceState>('POST', '/api/race/reset'),
  paceCar: () => request<RaceState>('POST', '/api/race/pace-car'),
  getSettings: () => request<SettingsResponse>('GET', '/api/settings'),
  putSettings: (s: Settings) => request<SettingsResponse>('PUT', '/api/settings', s),
  races: () => request<{ races: RaceSummary[] }>('GET', '/api/races'),
  race: (id: number) => request<RaceDetail>('GET', `/api/races/${id}`),
  exportUrl: (id: number, format: 'csv' | 'json') => `/api/races/${id}/export?format=${format}`,
  getRecords: () => request<{ records: TrackRecordInfo[] }>('GET', '/api/records'),
  deleteRecord: (layout: string) =>
    request<{ records: TrackRecordInfo[] }>('DELETE', `/api/records/${encodeURIComponent(layout)}`),
  mute: (muted: boolean) => request<{ muted: boolean }>('POST', '/api/commentary/mute', { muted }),
  layouts: () => request<{ layouts: TrackLayout[] }>('GET', '/api/layouts'),
  layout: (name: string) =>
    request<TrackLayout>('GET', `/api/layouts/${encodeURIComponent(name)}`),
  /** The named layout, or null if none is saved (uses the list: no 404 in the console). */
  findLayout: async (name: string): Promise<TrackLayout | null> => {
    const { layouts } = await request<{ layouts: TrackLayout[] }>('GET', '/api/layouts')
    return layouts.find((l) => l.name === name) ?? null
  },
  saveLayout: (layout: TrackLayout) =>
    request<TrackLayout>('PUT', `/api/layouts/${encodeURIComponent(layout.name)}`, layout),
  deleteLayout: (name: string) =>
    request<{ layouts: TrackLayout[] }>('DELETE', `/api/layouts/${encodeURIComponent(name)}`),
  // ---- event mode (docs/PROTOCOL.md "Event mode")
  drivers: () => request<{ drivers: Driver[] }>('GET', '/api/drivers'),
  createDriver: (d: { name: string; nickname?: string | null; bio?: string }) =>
    request<Driver>('POST', '/api/drivers', d),
  saveDriver: (d: Driver) => request<Driver>('PUT', `/api/drivers/${encodeURIComponent(d.id)}`, d),
  deleteDriver: (id: string) =>
    request<{ drivers: Driver[] }>('DELETE', `/api/drivers/${encodeURIComponent(id)}`),
  driverPhotoUrl: (id: string, bust = '') => `/api/drivers/${encodeURIComponent(id)}/photo${bust ? `?v=${bust}` : ''}`,
  setDriverPhoto: (id: string, body: { image_base64: string; media_type: string }) =>
    request<Driver>('PUT', `/api/drivers/${encodeURIComponent(id)}/photo`, body),
  deleteDriverPhoto: (id: string) =>
    request<Driver>('DELETE', `/api/drivers/${encodeURIComponent(id)}/photo`),
  logos: () => request<{ logos: Logo[] }>('GET', '/api/logos'),
  createLogo: (body: { name: string; image_base64: string }) => request<Logo>('POST', '/api/logos', body),
  updateLogo: (id: string, body: { name: string; image_base64: string | null }) =>
    request<Logo>('PUT', `/api/logos/${encodeURIComponent(id)}`, body),
  deleteLogo: (id: string) => request<{ logos: Logo[] }>('DELETE', `/api/logos/${encodeURIComponent(id)}`),
  /** `version` (the logo's `updated_at`) busts the cache after the image is replaced. */
  logoUrl: (id: string, version = '') =>
    `/api/logos/${encodeURIComponent(id)}/image${version ? `?v=${encodeURIComponent(version)}` : ''}`,
  assignments: () => request<{ assignments: Record<string, string> }>('GET', '/api/event/assignments'),
  setAssignments: (assignments: Record<string, string | null>) =>
    request<{ assignments: Record<string, string> }>('PUT', '/api/event/assignments', { assignments }),
  armNextCrossing: (driver_id: string) =>
    request<{ armed: boolean }>('POST', '/api/event/assign-next-crossing', { driver_id }),
  cancelNextCrossing: () => request<{ armed: boolean }>('DELETE', '/api/event/assign-next-crossing'),
  transcribe: (body: { audio_base64: string; media_type: string; language: 'en' | 'it' }) =>
    request<{ text: string; name_guess: string | null }>('POST', '/api/event/transcribe', body),
  programs: () => request<{ programs: EventProgram[] }>('GET', '/api/programs'),
  saveProgram: (p: EventProgram) =>
    request<EventProgram>('PUT', `/api/programs/${encodeURIComponent(p.id)}`, p),
  deleteProgram: (id: string) =>
    request<{ programs: EventProgram[] }>('DELETE', `/api/programs/${encodeURIComponent(id)}`),
  event: () => request<EventState>('GET', '/api/event'),
  startEvent: (program_id: string) => request<EventState>('POST', '/api/event/start', { program_id }),
  nextSession: () => request<EventState>('POST', '/api/event/next'),
  stopEvent: () => request<EventState>('POST', '/api/event/stop'),
  exportBundle: (sections: ExportSection[]) =>
    request<ExportBundle>('POST', '/api/export', { sections }),
  importBundle: (bundle: ExportBundle, mode: 'merge' | 'replace', dry_run: boolean) =>
    request<ImportReport>('POST', '/api/import', { bundle, mode, dry_run }),
  layoutFromPhoto: (body: {
    image_base64: string
    media_type: 'image/jpeg' | 'image/png' | 'image/webp'
    name: string
    language: 'en' | 'it'
  }) => request<LayoutDraft>('POST', '/api/layouts/from-photo', body),
}
