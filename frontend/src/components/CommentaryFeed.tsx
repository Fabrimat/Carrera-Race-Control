import { useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { audioPlayer, saveVolume, loadVolume } from '../lib/audio'
import { guarded } from '../lib/errors'
import { getSfxPrefs, setSfxEnabled, setSfxVolume } from '../lib/sfx'
import { useStore } from '../lib/store'
import type { CommentaryLine } from '../lib/types'

const PRIORITY_BAR: Record<CommentaryLine['priority'], string> = {
  high: 'border-l-signal',
  normal: 'border-l-amber',
  low: 'border-l-line',
}

/** `fill`: stretch to the parent's height and scroll the list inside (16:9 control panel). */
export function CommentaryFeed({ fill = false }: { fill?: boolean }) {
  const t = useT()
  const lines = useStore((s) => s.commentary)
  const muted = useStore((s) => s.muted)
  const [volume, setVolume] = useState(loadVolume)
  const [sfx, setSfx] = useState(getSfxPrefs)

  const toggleMute = async () => {
    void audioPlayer.unlock()
    const res = await guarded(() => api.mute(!muted))
    if (res) {
      useStore.getState().setMuted(res.muted)
      audioPlayer.setMuted(res.muted)
    }
  }
  const onVolume = (v: number) => {
    setVolume(v)
    audioPlayer.setVolume(v)
    saveVolume(v)
  }

  const toggleSfx = () => {
    void audioPlayer.unlock()
    setSfxEnabled(!sfx.enabled)
    setSfx(getSfxPrefs())
  }
  const onSfxVolume = (v: number) => {
    setSfxVolume(v)
    setSfx(getSfxPrefs())
  }

  return (
    <section
      className={`rounded-lg border border-line bg-panel ${fill ? 'flex h-full min-h-0 flex-col p-3' : 'p-4'}`}
      aria-label={t('commentary.title')}
    >
      <div className={`flex flex-wrap items-center ${fill ? 'mb-2 gap-x-4 gap-y-1' : 'mb-3 gap-4'}`}>
        <h2 className="text-sm font-bold uppercase tracking-widest text-dim">{t('commentary.title')}</h2>
        <button
          className={`rounded-md px-3 py-1 text-sm font-bold uppercase ${muted ? 'bg-signal text-white' : 'bg-panel-2'}`}
          onClick={() => void toggleMute()}
          aria-pressed={muted}
        >
          {muted ? t('commentary.unmute') : t('commentary.mute')}
        </button>
        <label className="flex items-center gap-2 text-sm text-dim">
          {t('commentary.volume')}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </label>
        <button
          className={`rounded-md px-3 py-1 text-sm font-bold uppercase ${sfx.enabled ? 'bg-go text-black' : 'bg-panel-2'}`}
          onClick={toggleSfx}
          aria-pressed={sfx.enabled}
          data-testid="sfx-toggle"
        >
          {t('sfx.toggle')}
        </button>
        <label className="flex items-center gap-2 text-sm text-dim">
          {t('sfx.volume')}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sfx.volume}
            disabled={!sfx.enabled}
            onChange={(e) => onSfxVolume(Number(e.target.value))}
          />
        </label>
      </div>
      {lines.length === 0 ? (
        <p className="text-dim">{t('commentary.empty')}</p>
      ) : (
        <ul className={`flex flex-col gap-2 overflow-y-auto ${fill ? 'min-h-0 flex-1' : 'max-h-80'}`}>
          {[...lines].reverse().map((l) => (
            <li
              key={l.id}
              data-testid="commentary-line"
              className={`rounded border-l-4 bg-panel-2 px-3 py-2 text-lg ${PRIORITY_BAR[l.priority]}`}
            >
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
