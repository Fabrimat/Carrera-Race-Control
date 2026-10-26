import { useEffect, useState } from 'react'
import { useT } from '../i18n/useT'
import { guarded } from '../lib/errors'
import { saveSettings } from '../lib/settingsSave'
import {
  actionById,
  comboFromEvent,
  comboProblem,
  conflictsFor,
  effectiveBindings,
  overridesFrom,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
} from '../lib/shortcuts'
import { useStore } from '../lib/store'
import { KeyCombo } from './ShortcutHelp'

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS'])
const btn =
  'rounded-md border border-line bg-panel-2 px-3 py-1 text-xs font-bold uppercase tracking-wide hover:border-amber disabled:cursor-not-allowed disabled:opacity-40'

/** Persist the bindings as overrides of the defaults, on the freshest settings. */
function saveBindings(mutate: (current: Record<string, string>) => Record<string, string>): Promise<unknown> {
  return guarded(() =>
    saveSettings((s) => ({ ...s, shortcuts: overridesFrom(mutate(effectiveBindings(s.shortcuts))) })),
  )
}

/** Settings section: rebind (press to record), disable, reset to default, conflict warnings. */
export function ShortcutsSection() {
  const t = useT()
  const overrides = useStore((s) => s.settings?.shortcuts)
  const bindings = effectiveBindings(overrides)
  const [recording, setRecording] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; kind: 'invalid' | 'reserved' } | null>(null)

  useEffect(() => {
    if (!recording) return
    const on = (e: KeyboardEvent) => {
      // Swallow everything while recording so the key never reaches a shortcut or a control.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (MODIFIER_KEYS.has(e.key)) return
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(null)
        setProblem(null)
        return
      }
      const combo = comboFromEvent(e)
      const kind = combo === null ? 'invalid' : comboProblem(combo)
      if (combo === null || kind) {
        setProblem({ id: recording, kind: kind ?? 'invalid' })
        return
      }
      const id = recording
      setRecording(null)
      setProblem(null)
      void saveBindings((b) => ({ ...b, [id]: combo }))
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [recording])

  const label = (id: string) => {
    const a = actionById(id)
    return a ? t(a.labelKey) : id
  }
  const anyCustom = Object.keys(overrides ?? {}).length > 0

  return (
    <section
      className="rounded-lg border border-line bg-panel p-4"
      aria-label={t('shortcuts.title')}
      data-testid="shortcuts-section"
      {...(recording ? { 'data-shortcut-recording': '' } : {})}
    >
      <div className="mb-1 flex items-center gap-3">
        <h3 className="text-sm font-bold uppercase tracking-widest text-dim">{t('shortcuts.title')}</h3>
        <button
          type="button"
          className={`${btn} ml-auto`}
          disabled={!anyCustom}
          onClick={() => void saveBindings(() => ({}))}
        >
          {t('shortcuts.reset_all')}
        </button>
      </div>
      <p className="mb-3 text-sm text-dim">{t('shortcuts.settings_hint')}</p>
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g}>
            <h4 className="mb-1 border-b border-line pb-1 text-xs font-bold uppercase tracking-widest text-dim">
              {t(`shortcuts.group.${g}`)}
            </h4>
            <ul className="flex flex-col">
              {SHORTCUT_ACTIONS.filter((a) => a.group === g).map((a) => {
                const combo = bindings[a.id]
                const others = conflictsFor(a.id, combo, bindings)
                const isRec = recording === a.id
                const name = label(a.id)
                return (
                  <li
                    key={a.id}
                    data-testid={`shortcut-${a.id}`}
                    className="flex flex-wrap items-center gap-2 border-b border-line/40 py-1.5"
                  >
                    <span className="min-w-0 flex-1 text-sm">{name}</span>
                    {isRec ? (
                      <span
                        role="status"
                        className="rounded border border-amber px-2 py-0.5 text-sm font-bold text-amber"
                      >
                        {t('shortcuts.recording')}
                      </span>
                    ) : (
                      <KeyCombo combo={combo} />
                    )}
                    <button
                      type="button"
                      className={btn}
                      aria-label={t('shortcuts.rebind', { action: name })}
                      aria-pressed={isRec}
                      onClick={() => {
                        setProblem(null)
                        setRecording(isRec ? null : a.id)
                      }}
                    >
                      {t('shortcuts.record')}
                    </button>
                    <button
                      type="button"
                      className={btn}
                      onClick={() => void saveBindings((b) => ({ ...b, [a.id]: combo ? '' : a.combo }))}
                    >
                      {combo ? t('shortcuts.disable') : t('shortcuts.enable')}
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={combo === a.combo}
                      onClick={() => void saveBindings((b) => ({ ...b, [a.id]: a.combo }))}
                    >
                      {t('shortcuts.reset')}
                    </button>
                    {others.length > 0 && (
                      <p role="alert" data-testid="shortcut-conflict" className="basis-full text-xs text-amber">
                        {t('shortcuts.conflict', { others: others.map(label).join(', ') })}
                      </p>
                    )}
                    {problem?.id === a.id && (
                      <p role="alert" className="basis-full text-xs text-signal">
                        {t(`shortcuts.problem.${problem.kind}`)}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
