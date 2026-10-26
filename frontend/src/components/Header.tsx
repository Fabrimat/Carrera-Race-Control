import { useT } from '../i18n/useT'
import { saveSettings } from '../lib/settingsSave'
import { guarded } from '../lib/errors'
import { useStore } from '../lib/store'
import type { Route } from '../lib/route'
import type { Language } from '../lib/types'
import { AudioHint } from './AudioHint'

const NAV: { href: string; key: 'nav.dashboard' | 'nav.drivers' | 'nav.history' | 'nav.settings' | 'nav.tv' | 'track.nav' | 'ev.nav' | 'camera.nav'; name: Route['name'][] }[] = [
  { href: '#/', key: 'nav.dashboard', name: ['dashboard'] },
  { href: '#/drivers', key: 'nav.drivers', name: ['drivers'] },
  { href: '#/history', key: 'nav.history', name: ['history', 'history-detail'] },
  { href: '#/event', key: 'ev.nav', name: ['event'] },
  { href: '#/track', key: 'track.nav', name: ['track'] },
  { href: '#/camera', key: 'camera.nav', name: ['camera'] },
  { href: '#/settings', key: 'nav.settings', name: ['settings'] },
  { href: '#/tv', key: 'nav.tv', name: ['tv'] },
]

export function LanguageSwitcher() {
  const t = useT()
  const language = useStore((s) => s.language)
  const settings = useStore((s) => s.settings)
  const change = async (lang: Language) => {
    if (!settings) {
      useStore.setState({ language: lang })
      return
    }
    await guarded(() => saveSettings((s) => ({ ...s, ui_language: lang })))
  }
  return (
    <select
      aria-label={t('settings.ui_language')}
      className="rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-bold uppercase"
      value={language}
      onChange={(e) => void change(e.target.value as Language)}
    >
      <option value="en">EN</option>
      <option value="it">IT</option>
    </select>
  )
}

export function Header({ route }: { route: Route }) {
  const t = useT()
  const ws = useStore((s) => s.ws)
  return (
    <header className="flex flex-wrap items-center gap-4 border-b border-line bg-panel px-5 py-3">
      <h1 className="text-xl font-black uppercase tracking-[0.2em]">
        <span className="text-signal">▮</span> {t('app.title')}
      </h1>
      <nav className="flex gap-1">
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className={`rounded-md px-3 py-1 text-sm font-semibold uppercase tracking-wide ${
              n.name.includes(route.name) ? 'bg-panel-2 text-ink' : 'text-dim hover:text-ink'
            }`}
          >
            {t(n.key)}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <AudioHint />
        {ws !== 'open' && (
          <span
            data-testid="backend-offline"
            className="rounded-full bg-signal px-3 py-1 text-xs font-bold uppercase tracking-widest text-white"
          >
            {ws === 'connecting' ? t('app.connecting') : t('app.offline')}
          </span>
        )}
        <LanguageSwitcher />
      </div>
    </header>
  )
}
