import { useEffect, useRef } from 'react'
import { useT } from '../i18n/useT'
import {
  effectiveBindings,
  formatCombo,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
} from '../lib/shortcuts'
import { useStore } from '../lib/store'

/** One key combination drawn as key caps ("Ctrl" "Shift" "R"). */
export function KeyCombo({ combo }: { combo: string }) {
  const t = useT()
  if (!combo) return <span className="text-sm italic text-dim">{t('shortcuts.unbound')}</span>
  // A trailing "+" is the key itself ("Ctrl++"), not a separator.
  const parts = formatCombo(combo).match(/(?:Ctrl|Alt|Shift)(?=\+.)|\+$|[^+]+/g) ?? [combo]
  return (
    <span className="inline-flex items-center gap-1" data-testid="key-combo">
      {parts.map((p, i) => (
        <kbd
          key={i}
          className="num min-w-7 rounded border border-line border-b-2 bg-panel-2 px-2 py-0.5 text-center text-sm font-bold text-ink"
        >
          {p}
        </kbd>
      ))}
    </span>
  )
}

/**
 * The `?` overlay: every shortcut grouped, with the current binding. It is a dialog but marked
 * `data-shortcut-help` so the global listener keeps working (`?` closes it again).
 */
export function ShortcutHelp() {
  const t = useT()
  const open = useStore((s) => s.helpOpen)
  const overrides = useStore((s) => s.settings?.shortcuts)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      useStore.getState().setHelpOpen(false)
    }
    window.addEventListener('keydown', on)
    return () => {
      window.removeEventListener('keydown', on)
      before?.focus?.()
    }
  }, [open])

  if (!open) return null
  const bindings = effectiveBindings(overrides)
  const close = () => useStore.getState().setHelpOpen(false)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        data-shortcut-help
        tabIndex={-1}
        className="flex max-h-full w-full max-w-5xl flex-col rounded-xl border border-line border-t-4 border-t-signal bg-panel p-5 shadow-2xl outline-none"
      >
        <div className="mb-3 flex items-center gap-4">
          <h2 className="text-xl font-black uppercase tracking-[0.2em]">{t('shortcuts.title')}</h2>
          <a
            href="#/settings"
            onClick={close}
            className="ml-auto text-sm font-semibold uppercase tracking-wide text-dim hover:text-ink"
          >
            {t('shortcuts.customise')}
          </a>
          <button
            type="button"
            className="rounded-md border border-line bg-panel-2 px-4 py-1 text-sm font-bold uppercase hover:border-amber"
            onClick={close}
          >
            {t('shortcuts.close')}
          </button>
        </div>
        <div className="grid min-h-0 gap-x-8 gap-y-4 overflow-y-auto pr-1 sm:grid-cols-2 min-[1200px]:grid-cols-3">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g} aria-label={t(`shortcuts.group.${g}`)}>
              <h3 className="mb-1 border-b border-line pb-1 text-xs font-bold uppercase tracking-widest text-dim">
                {t(`shortcuts.group.${g}`)}
              </h3>
              <ul className="flex flex-col gap-1">
                {SHORTCUT_ACTIONS.filter((a) => a.group === g).map((a) => (
                  <li
                    key={a.id}
                    data-testid="shortcut-row"
                    className="flex items-center justify-between gap-3 py-0.5 text-sm"
                  >
                    <span>{t(a.labelKey)}</span>
                    <KeyCombo combo={bindings[a.id]} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-3 text-xs text-dim">{t('shortcuts.help_hint')}</p>
      </div>
    </div>
  )
}
