import { lazy, Suspense, useEffect } from 'react'
import { Header } from './components/Header'
import { Toasts } from './components/Toasts'
import { useLanguage, useT } from './i18n/useT'
import { api } from './lib/api'
import { connectionErrorMessage } from './lib/errors'
import { useRoute } from './lib/route'
import { useStore } from './lib/store'
import { wsClient } from './lib/ws'
import { Dashboard } from './pages/Dashboard'

// Secondary pages are loaded on demand to keep the initial bundle small.
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })))
const HistoryDetail = lazy(() => import('./pages/History').then((m) => ({ default: m.HistoryDetail })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const TvMode = lazy(() => import('./pages/TvMode').then((m) => ({ default: m.TvMode })))
const TrackEditor = lazy(() => import('./pages/TrackEditor').then((m) => ({ default: m.TrackEditor })))

export default function App() {
  const route = useRoute()
  const t = useT()
  const language = useLanguage()
  const ws = useStore((s) => s.ws)
  const conn = useStore((s) => s.connection)

  useEffect(() => {
    wsClient.start()
    return () => wsClient.stop()
  }, [])

  // Load settings (UI language etc.) whenever the backend becomes reachable.
  useEffect(() => {
    if (ws !== 'open') return
    api.getSettings().then(
      (s) => useStore.getState().setSettings(s),
      () => undefined,
    )
  }, [ws])

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  // Surface connection errors as toasts as well as in the connection bar.
  useEffect(() => {
    if (conn.status !== 'error') return
    const msg = connectionErrorMessage(conn, t)
    if (msg) useStore.getState().pushToast(msg)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.status, conn.error_code, conn.error])

  return (
    <div className="flex min-h-full flex-col">
      {route.name !== 'tv' && <Header route={route} />}
      <main className="flex-1">
        <Suspense fallback={<p className="p-6 text-dim">{t('common.loading')}</p>}>
          {route.name === 'dashboard' && <Dashboard />}
          {route.name === 'history' && <History />}
          {route.name === 'history-detail' && <HistoryDetail id={route.id} />}
          {route.name === 'settings' && <SettingsPage />}
          {route.name === 'tv' && <TvMode />}
          {route.name === 'track' && <TrackEditor layout={route.layout} />}
        </Suspense>
      </main>
      <Toasts />
    </div>
  )
}
