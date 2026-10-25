import { useEffect } from 'react'
import { Header } from './components/Header'
import { Toasts } from './components/Toasts'
import { useLanguage, useT } from './i18n/useT'
import { api } from './lib/api'
import { connectionErrorMessage } from './lib/errors'
import { useRoute } from './lib/route'
import { useStore } from './lib/store'
import { wsClient } from './lib/ws'
import { Dashboard } from './pages/Dashboard'
import { History, HistoryDetail } from './pages/History'
import { SettingsPage } from './pages/SettingsPage'
import { TvMode } from './pages/TvMode'

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
        {route.name === 'dashboard' && <Dashboard />}
        {route.name === 'history' && <History />}
        {route.name === 'history-detail' && <HistoryDetail id={route.id} />}
        {route.name === 'settings' && <SettingsPage />}
        {route.name === 'tv' && <TvMode />}
      </main>
      <Toasts />
    </div>
  )
}
