import { useState, type ReactNode } from 'react'
import { CarsSection } from '../components/CarsSection'
import { ShortcutsSection } from '../components/ShortcutsSection'
import { useT } from '../i18n/useT'
import { guarded } from '../lib/errors'
import { saveSettings } from '../lib/settingsSave'
import { useStore } from '../lib/store'
import type { CommentarySettings, Language, Settings, Verbosity } from '../lib/types'

const input = 'rounded-md border border-line bg-panel-2 px-3 py-2'
const LANGS: Language[] = ['en', 'it']
const VERBOSITY: Verbosity[] = ['low', 'normal', 'high']

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
      {label}
      {children}
    </label>
  )
}

function KeyBadge({ ok, label }: { ok: boolean; label: string }) {
  const t = useT()
  return (
    <span
      data-testid={`key-${label}`}
      className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${ok ? 'bg-go text-black' : 'bg-signal text-white'}`}
    >
      {label}: {ok ? t('settings.key_configured') : t('settings.key_missing')}
    </span>
  )
}

interface Draft {
  ui_language?: Language
  track?: Settings['track']
  commentary?: Partial<CommentarySettings>
}

export function SettingsPage() {
  const t = useT()
  const loaded = useStore((s) => s.settings)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  if (!loaded) return <p className="p-6 text-dim">{t('common.loading')}</p>
  // Cars are autosaved by CarsSection; the draft only covers the other sections.
  const s: Settings = {
    ...loaded,
    ui_language: draft?.ui_language ?? loaded.ui_language,
    track: draft?.track ?? loaded.track,
    commentary: { ...loaded.commentary, ...draft?.commentary },
  }
  const layoutOk = s.track.layout.trim().length >= 1 && s.track.layout.length <= 40
  const edit = (patch: Draft) => setDraft({ ...draft, ...patch })
  const editCom = (patch: Partial<CommentarySettings>) =>
    edit({ commentary: { ...draft?.commentary, ...patch } })

  // Merge the draft into the freshest store settings so autosaved cars are never clobbered.
  const save = async () => {
    if (!draft) return
    setSaving(true)
    const res = await guarded(() =>
      saveSettings((cur) => ({
        ...cur,
        ui_language: draft.ui_language ?? cur.ui_language,
        track: draft.track ?? cur.track,
        commentary: { ...cur.commentary, ...draft.commentary },
      })),
    )
    setSaving(false)
    if (res) {
      useStore.getState().pushToast(t('settings.saved'), 'info')
      setDraft(null)
    }
  }

  const langSelect = (value: Language, onChange: (l: Language) => void, label: string) => (
    <Field label={label}>
      <select className={input} value={value} onChange={(e) => onChange(e.target.value as Language)}>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {t(`language.${l}`)}
          </option>
        ))}
      </select>
    </Field>
  )

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-4">
      <h2 className="text-2xl font-black uppercase tracking-widest">{t('settings.title')}</h2>

      <CarsSection cars={loaded.cars} />

      <section className="rounded-lg border border-line bg-panel p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('settings.track')}</h3>
        <Field label={t('settings.track_layout')}>
          <input
            className={`${input} ${layoutOk ? '' : 'border-signal'}`}
            value={s.track.layout}
            minLength={1}
            maxLength={40}
            aria-invalid={!layoutOk}
            data-testid="track-layout"
            onChange={(e) => edit({ track: { ...s.track, layout: e.target.value } })}
          />
        </Field>
        <p className="mt-2 text-sm text-dim">{t('settings.track_layout_hint')}</p>
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('settings.language')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {langSelect(s.ui_language, (l) => edit({ ui_language: l }), t('settings.ui_language'))}
          {langSelect(s.commentary.language, (l) => editCom({ language: l }), t('settings.commentary_language'))}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('settings.commentary')}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={s.commentary.enabled} onChange={(e) => editCom({ enabled: e.target.checked })} />
            {t('settings.commentary_enabled')}
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={s.commentary.tts_enabled} onChange={(e) => editCom({ tts_enabled: e.target.checked })} />
            {t('settings.tts_enabled')}
          </label>
          <label className="flex items-center gap-3">
            <input type="checkbox" checked={s.commentary.llm_enabled} onChange={(e) => editCom({ llm_enabled: e.target.checked })} />
            {t('settings.llm_enabled')}
          </label>
          <Field label={t('settings.llm_provider')}>
            <select
              className={input}
              data-testid="llm-provider"
              value={s.commentary.llm_provider}
              onChange={(e) => editCom({ llm_provider: e.target.value as CommentarySettings['llm_provider'] })}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </Field>
          <Field label={t('settings.voice_id')}>
            <input
              className={input}
              value={s.commentary.voice_id ?? ''}
              placeholder={t('settings.voice_default')}
              onChange={(e) => editCom({ voice_id: e.target.value || null })}
            />
          </Field>
          <Field label={t('settings.verbosity')}>
            <select className={input} value={s.commentary.verbosity} onChange={(e) => editCom({ verbosity: e.target.value as Verbosity })}>
              {VERBOSITY.map((v) => (
                <option key={v} value={v}>
                  {t(`verbosity.${v}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.audio_output')}>
            <select
              className={input}
              value={s.commentary.audio_output}
              onChange={(e) => editCom({ audio_output: e.target.value as 'browser' | 'local' })}
            >
              <option value="browser">{t('settings.audio_browser')}</option>
              <option value="local">{t('settings.audio_local')}</option>
            </select>
          </Field>
          <Field label={t('settings.session_budget')}>
            <input
              type="number"
              min={0}
              className={input}
              value={s.commentary.session_char_budget}
              onChange={(e) => editCom({ session_char_budget: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label={t('settings.monthly_budget')}>
            <input
              type="number"
              min={0}
              className={input}
              value={s.commentary.monthly_char_budget}
              onChange={(e) => editCom({ monthly_char_budget: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
        </div>
      </section>

      <ShortcutsSection />

      <section className="rounded-lg border border-line bg-panel p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('settings.keys')}</h3>
        <div className="flex flex-wrap gap-3">
          <KeyBadge ok={loaded.keys.elevenlabs} label="ElevenLabs" />
          <KeyBadge ok={loaded.keys.anthropic} label="Anthropic" />
          <KeyBadge ok={loaded.keys.openai} label="OpenAI" />
        </div>
        <p className="mt-2 text-sm text-dim">{t('settings.keys_hint')}</p>
      </section>

      <div className="flex gap-3">
        <button
          className="rounded-md bg-go px-6 py-3 text-lg font-bold uppercase text-black disabled:opacity-40"
          disabled={saving || draft === null || !layoutOk}
          onClick={() => void save()}
        >
          {t('settings.save')}
        </button>
        <button
          className="rounded-md bg-panel-2 px-6 py-3 text-lg font-bold uppercase disabled:opacity-40"
          disabled={draft === null}
          onClick={() => setDraft(null)}
        >
          {t('settings.discard')}
        </button>
      </div>
    </div>
  )
}
