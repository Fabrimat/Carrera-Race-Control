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
} from './types'

/** status 0 = network failure (backend unreachable). */
export class ApiError extends Error {
  status: number
  detail: string | null
  constructor(status: number, detail: string | null) {
    super(detail ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
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
    try {
      const j = await res.json()
      if (typeof j?.detail === 'string') detail = j.detail
      else if (j?.detail !== undefined) detail = JSON.stringify(j.detail)
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail)
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
  mute: (muted: boolean) => request<{ muted: boolean }>('POST', '/api/commentary/mute', { muted }),
}
