import { useState, type ReactNode } from 'react'
import { useT } from '../i18n/useT'
import { useStore } from '../lib/store'
import type { IncidentRules, PitRules } from '../lib/types'

// Editors for the race rules (incidents and mandatory pit stops), shared by the Settings page
// (settings.race) and the event ProgramEditor (per-session override or inherit).

const input = 'rounded-md border border-line bg-panel-2 px-3 py-2'

export const DEFAULT_INCIDENT_RULES: IncidentRules = {
  detect: true,
  overdue_factor: 2.5,
  auto_pace_car: false,
  penalty_s: 0,
}
export const DEFAULT_PIT_RULES: PitRules = { min_stops: 0, missed_penalty_s: 30 }

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
      {label}
      {children}
      {hint && <span className="text-[0.8rem] normal-case tracking-normal text-dim">{hint}</span>}
    </label>
  )
}

/**
 * A number input that lets the user type freely (e.g. "1." on the way to "1.8"): valid values in
 * range are committed at once, the field snaps into range on blur.
 */
function NumField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  integer = true,
  testId,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  integer?: boolean
  testId: string
  onChange: (n: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const parse = (v: string) => {
    const n = Number(v.replace(',', '.'))
    return v.trim() === '' || Number.isNaN(n) ? null : integer ? Math.floor(n) : n
  }
  return (
    <Field label={label} hint={hint}>
      <input
        className={input}
        type="number"
        data-testid={testId}
        min={min}
        max={max}
        step={step}
        value={text ?? String(value)}
        onChange={(e) => {
          setText(e.target.value)
          const n = parse(e.target.value)
          if (n !== null && n >= min && n <= max) onChange(n)
        }}
        onBlur={() => {
          if (text === null) return
          const n = parse(text)
          const clamped = Math.min(max, Math.max(min, n ?? value))
          setText(null)
          onChange(clamped)
        }}
      />
    </Field>
  )
}

export function IncidentRulesFields({
  value,
  onChange,
}: {
  value: IncidentRules
  onChange: (v: IncidentRules) => void
}) {
  const t = useT()
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2" data-testid="incident-rules">
      <legend className="mb-2 text-sm font-bold uppercase tracking-widest text-gold">{t('rules.incidents')}</legend>
      <label className="flex items-center gap-3 sm:col-span-2">
        <input
          type="checkbox"
          data-testid="rules-detect"
          checked={value.detect}
          onChange={(e) => onChange({ ...value, detect: e.target.checked })}
        />
        {t('rules.detect')}
      </label>
      <NumField
        label={t('rules.overdue_factor')}
        hint={t('rules.overdue_factor_hint')}
        value={value.overdue_factor}
        min={1.5}
        max={10}
        step={0.5}
        integer={false}
        testId="rules-factor"
        onChange={(overdue_factor) => onChange({ ...value, overdue_factor })}
      />
      <NumField
        label={t('rules.incident_penalty_s')}
        value={value.penalty_s}
        min={0}
        max={120}
        testId="rules-incident-penalty"
        onChange={(penalty_s) => onChange({ ...value, penalty_s })}
      />
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            data-testid="rules-auto-pace"
            checked={value.auto_pace_car}
            onChange={(e) => onChange({ ...value, auto_pace_car: e.target.checked })}
          />
          {t('rules.auto_pace_car')}
        </label>
        <p className="text-sm text-gold" data-testid="rules-auto-pace-note">
          {t('rules.auto_pace_car_note')}
        </p>
      </div>
    </fieldset>
  )
}

export function PitRulesFields({ value, onChange }: { value: PitRules; onChange: (v: PitRules) => void }) {
  const t = useT()
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2" data-testid="pit-rules">
      <legend className="mb-2 text-sm font-bold uppercase tracking-widest text-gold">{t('rules.pits')}</legend>
      <NumField
        label={t('rules.min_stops')}
        value={value.min_stops}
        min={0}
        max={20}
        testId="rules-min-stops"
        onChange={(min_stops) => onChange({ ...value, min_stops })}
      />
      <NumField
        label={t('rules.missed_penalty_s')}
        value={value.missed_penalty_s}
        min={0}
        max={600}
        testId="rules-missed-penalty"
        onChange={(missed_penalty_s) => onChange({ ...value, missed_penalty_s })}
      />
    </fieldset>
  )
}

/**
 * Per-session rules: inherit from Settings (value null) or override. Switching to "override"
 * starts from the current Settings rules so nothing jumps.
 */
export function SessionRules<T extends IncidentRules | PitRules>({
  kind,
  value,
  onChange,
}: {
  kind: 'incidents' | 'pits'
  value: T | null
  onChange: (v: T | null) => void
}) {
  const t = useT()
  const inherited = useStore((s) => s.settings?.race[kind]) as T | undefined
  const fallback = (kind === 'incidents' ? DEFAULT_INCIDENT_RULES : DEFAULT_PIT_RULES) as T
  const overriding = value !== null
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-3 sm:col-span-2 lg:col-span-4" data-testid={`session-${kind}`}>
      <label className="flex items-center gap-3 text-sm font-bold uppercase tracking-wide">
        <input
          type="checkbox"
          data-testid={`override-${kind}`}
          checked={overriding}
          onChange={(e) => onChange(e.target.checked ? { ...(inherited ?? fallback) } : null)}
        />
        {kind === 'incidents' ? t('rules.incidents') : t('rules.pits')}: {t('rules.override')}
        {!overriding && <span className="font-normal normal-case text-dim">({t('rules.inherit')})</span>}
      </label>
      {overriding &&
        (kind === 'incidents' ? (
          <IncidentRulesFields value={value as IncidentRules} onChange={(v) => onChange(v as T)} />
        ) : (
          <PitRulesFields value={value as PitRules} onChange={(v) => onChange(v as T)} />
        ))}
    </div>
  )
}
