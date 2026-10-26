import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { audioPlayer } from '../lib/audio'
import { connectionErrorMessage, guarded } from '../lib/errors'
import { SCAN_EVENT } from '../lib/shortcutActions'
import { useStore } from '../lib/store'
import type { ScanDevice, TrackMode } from '../lib/types'

const MODES: TrackMode[] = ['simulator', 'ble', 'serial']
const PILL: Record<string, string> = {
  disconnected: 'bg-line text-dim',
  connecting: 'bg-amber text-black',
  connected: 'bg-go text-black',
  error: 'bg-signal text-white',
}
const fieldFull = 'rounded-md border border-line bg-panel-2 px-3 py-2'
const fieldCompact = 'rounded-md border border-line bg-panel-2 px-2 py-1 text-sm'

export function ConnectionBar({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const field = compact ? fieldCompact : fieldFull
  const conn = useStore((s) => s.connection)
  const saved = useStore((s) => s.settings?.track)
  const [mode, setMode] = useState<TrackMode | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [devices, setDevices] = useState<ScanDevice[]>([])
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)

  const effMode = mode ?? saved?.mode ?? conn.mode
  const effAddress = address ?? saved?.address ?? conn.address ?? ''
  const needsAddress = effMode !== 'simulator'
  const connected = conn.status === 'connected'
  const message = conn.status === 'error' ? connectionErrorMessage(conn, t) : null

  const scan = async () => {
    setScanning(true)
    const res = await guarded(() => api.scan())
    setScanning(false)
    if (res) {
      setDevices(res.devices)
      if (res.devices.length === 0) useStore.getState().pushToast(t('connection.no_devices'), 'info')
      else if (!effAddress) setAddress(res.devices[0].address)
    }
  }
  // The scan shortcut fills this bar's device list (only when a scan is possible here).
  const canScan = needsAddress && !connected && !scanning
  useEffect(() => {
    const on = (e: Event) => {
      if (!canScan) return
      ;(e as CustomEvent<{ handled: boolean }>).detail.handled = true
      void scan()
    }
    window.addEventListener(SCAN_EVENT, on)
    return () => window.removeEventListener(SCAN_EVENT, on)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scan` is recreated every render
  }, [canScan, effMode, effAddress])
  const connect = async () => {
    setBusy(true)
    void audioPlayer.unlock()
    const res = await guarded(() => api.connect(effMode, needsAddress ? effAddress || null : null))
    if (res) useStore.getState().setConnection(res)
    setBusy(false)
  }
  const disconnect = async () => {
    setBusy(true)
    const res = await guarded(() => api.disconnect())
    if (res) useStore.getState().setConnection(res)
    setBusy(false)
  }

  return (
    <section
      className={`rounded-lg border border-line bg-panel ${compact ? 'p-2' : 'p-3'}`}
      aria-label={t('connection.title')}
    >
      <div className={`flex flex-wrap items-center ${compact ? 'gap-2' : 'gap-3'}`}>
        <span
          className={`rounded-full px-4 py-1 text-sm font-bold uppercase tracking-widest ${PILL[conn.status]}`}
          data-testid="connection-pill"
        >
          {t(`connection.status.${conn.status}`)}
        </span>
        <select
          className={field}
          aria-label={t('connection.mode')}
          value={effMode}
          disabled={connected || conn.status === 'connecting'}
          onChange={(e) => setMode(e.target.value as TrackMode)}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`connection.mode.${m}`)}
            </option>
          ))}
        </select>
        {needsAddress && (
          <>
            <select
              className={`${field} min-w-56`}
              aria-label={t('connection.device')}
              value={effAddress}
              disabled={connected}
              onChange={(e) => setAddress(e.target.value)}
            >
              <option value="">{t('connection.pick_device')}</option>
              {effAddress && !devices.some((d) => d.address === effAddress) && (
                <option value={effAddress}>{effAddress}</option>
              )}
              {devices
                .filter((d) => (effMode === 'ble' ? d.kind === 'ble' : d.kind === 'serial'))
                .map((d) => (
                  <option key={d.address} value={d.address}>
                    {d.name ? `${d.name} (${d.address})` : d.address}
                  </option>
                ))}
            </select>
            <button
              className={`${field} font-semibold disabled:opacity-40`}
              disabled={scanning || connected}
              onClick={() => void scan()}
            >
              {scanning ? t('connection.scanning') : t('connection.scan')}
            </button>
          </>
        )}
        {connected ? (
          <button
            className={`rounded-md bg-panel-2 ${compact ? 'px-3 py-1 text-sm' : 'px-4 py-2'} font-bold uppercase disabled:opacity-40`}
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {t('connection.disconnect')}
          </button>
        ) : (
          <button
            className={`rounded-md bg-go ${compact ? 'px-3 py-1 text-sm' : 'px-4 py-2'} font-bold uppercase text-black disabled:opacity-40`}
            disabled={busy || conn.status === 'connecting' || (needsAddress && !effAddress)}
            onClick={() => void connect()}
          >
            {t('connection.connect')}
          </button>
        )}
      </div>
      {message && (
        <p
          role="alert"
          className="mt-3 rounded-md border border-signal bg-[#2a1210] px-3 py-2 text-signal"
          data-testid="connection-error"
        >
          {message}
        </p>
      )}
    </section>
  )
}
