import { useT } from '../i18n/useT'
import {
  clampCtl,
  CTL_DEFAULT_ON,
  CTL_FIELDS,
  CTL_MAX,
  CTL_MIN,
  CTL_PRESETS,
  EMPTY_CONTROLLER,
  type CtlField,
} from '../lib/controller'
import type { ControllerSettings } from '../lib/types'

interface Props {
  value: ControllerSettings
  onChange: (next: ControllerSettings) => void
  /** `car`: an unset field leaves the CU's own value. `driver`: an unset field inherits the car's. */
  mode: 'car' | 'driver'
  /** Prefix of the data-testid attributes. */
  testId: string
  /** Show the Kid / Guest / Pro presets (UI only: they just fill the three values). */
  presets?: boolean
  /** Hide the "effect still to be verified" note (shown once by the parent instead). */
  hideNote?: boolean
}

const LABEL: Record<CtlField, 'ctl.speed' | 'ctl.brake' | 'ctl.fuel'> = {
  speed: 'ctl.speed',
  brake: 'ctl.brake',
  fuel: 'ctl.fuel',
}

/**
 * Speed / brake / fuel of one controller: three optional sliders 0..15. A switch per field
 * toggles between "unset" (null, never sent to the CU) and a value.
 */
export function ControllerFields({ value, onChange, mode, testId, presets = false, hideNote = false }: Props) {
  const t = useT()
  const unsetText = mode === 'car' ? t('ctl.unset') : t('ctl.inherit')
  const set = (field: CtlField, v: number | null) => onChange({ ...value, [field]: v })
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      <div className="grid gap-x-6 gap-y-2 md:grid-cols-3">
        {CTL_FIELDS.map((f) => {
          const v = value[f]
          const label = t(LABEL[f])
          return (
            <div key={f} className="flex flex-col gap-1" data-testid={`${testId}-${f}`}>
              <div className="flex items-center justify-between gap-2">
                <label className="flex min-h-8 cursor-pointer items-center gap-2 text-xs font-bold uppercase tracking-widest text-dim">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-go"
                    checked={v !== null}
                    aria-label={t('ctl.set_field', { field: label })}
                    data-testid={`${testId}-${f}-toggle`}
                    onChange={(e) => set(f, e.target.checked ? CTL_DEFAULT_ON[f] : null)}
                  />
                  {label}
                </label>
                <output
                  className={`num text-sm ${v === null ? 'text-dim' : 'font-bold text-ink'}`}
                  data-testid={`${testId}-${f}-value`}
                >
                  {v === null ? unsetText : v}
                </output>
              </div>
              <input
                type="range"
                min={CTL_MIN}
                max={CTL_MAX}
                step={1}
                value={v ?? 0}
                disabled={v === null}
                aria-label={label}
                aria-valuetext={v === null ? unsetText : String(v)}
                data-testid={`${testId}-${f}-slider`}
                className="h-6 w-full accent-go disabled:opacity-30"
                onChange={(e) => set(f, clampCtl(Number(e.target.value)))}
              />
            </div>
          )
        })}
      </div>
      {presets && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('ctl.presets')}>
          <span className="text-xs uppercase tracking-widest text-dim">{t('ctl.presets')}</span>
          {CTL_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`${testId}-preset-${p.id}`}
              className="min-h-8 rounded-md border border-line bg-panel-2 px-3 text-sm font-bold hover:border-go"
              onClick={() => onChange({ ...p.values })}
            >
              {t(`ctl.preset.${p.id}`)}
            </button>
          ))}
          <button
            type="button"
            data-testid={`${testId}-clear`}
            className="min-h-8 rounded-md border border-line px-3 text-sm text-dim hover:border-signal hover:text-ink"
            onClick={() => onChange({ ...EMPTY_CONTROLLER })}
          >
            {mode === 'car' ? t('ctl.clear') : t('ctl.clear_driver')}
          </button>
        </div>
      )}
      {!hideNote && <p className="text-xs text-dim">{t('ctl.note')}</p>}
    </div>
  )
}

/** Compact "S 10 · B — · F 15" summary of a controller's values. */
export function ControllerSummary({ value, className = '' }: { value: ControllerSettings; className?: string }) {
  const t = useT()
  return (
    <span className={`num inline-flex flex-wrap gap-x-3 ${className}`} data-testid="ctl-summary">
      {CTL_FIELDS.map((f) => (
        <span key={f} data-testid={`ctl-summary-${f}`}>
          <span className="text-dim">{t(`ctl.short.${f}`)}</span>{' '}
          <span className={value[f] === null ? 'text-dim' : 'font-bold'}>{value[f] ?? '—'}</span>
        </span>
      ))}
    </span>
  )
}
