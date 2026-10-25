import { useState, type ReactNode } from 'react'
import { useT } from '../../i18n/useT'
import type { TFunction } from '../../i18n'
import { api } from '../../lib/api'
import { apiErrorMessage } from '../../lib/errors'
import {
  addSession,
  cleanGrid,
  gridChoices,
  MAX_AVOID_WORDS,
  MAX_SESSIONS,
  MAX_SPONSORS,
  moveSession,
  normaliseSession,
  prepareForSave,
  removeSession,
  validateProgram,
  type ProgramIssue,
} from '../../lib/program'
import type { CommentaryContext, EventProgram, RaceMode, SessionKind, SessionSpec } from '../../lib/types'
import { ChipInput } from './ChipInput'

const KINDS: SessionKind[] = ['practice', 'qualifying', 'race']
const MODES: RaceMode[] = ['practice', 'laps', 'timed']
const TONES: CommentaryContext['tone'][] = ['family', 'enthusiastic', 'technical', 'ironic']
const ACTIONS = ['ignore', 'warn', 'penalty', 'restart'] as const

const input = 'rounded-md border border-line bg-panel-2 px-2 py-1 text-base text-ink num'

export function sessionTitle(t: TFunction, s: { kind: SessionKind; name: string }): string {
  return s.name.trim() || t(`ev.kind.${s.kind}`)
}

export function issueText(t: TFunction, i: ProgramIssue): string {
  const s = 'session' in i ? i.session : ''
  switch (i.code) {
    case 'name_required':
      return t('ev.issue.name_required')
    case 'no_sessions':
      return t('ev.issue.no_sessions')
    case 'too_many_sessions':
      return t('ev.issue.too_many_sessions', { max: MAX_SESSIONS })
    case 'duplicate_session_id':
      return t('ev.issue.duplicate_session_id', { id: s })
    case 'grid_from_invalid':
      return t('ev.issue.grid_from_invalid', { id: s })
    case 'laps_invalid':
      return t('ev.issue.laps_invalid', { id: s })
    case 'duration_invalid':
      return t('ev.issue.duration_invalid', { id: s })
    case 'penalty_invalid':
      return t('ev.issue.penalty_invalid', { id: s })
  }
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-xs uppercase tracking-widest text-dim ${className}`}>
      {label}
      {children}
    </label>
  )
}

function SessionCard({
  spec,
  index,
  all,
  onChange,
  onMove,
  onRemove,
}: {
  spec: SessionSpec
  index: number
  all: SessionSpec[]
  onChange: (s: SessionSpec) => void
  onMove: (d: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useT()
  const qualifying = spec.kind === 'qualifying'
  const mode = qualifying ? 'timed' : spec.mode
  const set = (patch: Partial<SessionSpec>) => onChange(normaliseSession({ ...spec, ...patch }))
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v) || min)))
  return (
    <li
      className="rounded-lg border border-line bg-panel p-3"
      data-testid="session-card"
      aria-label={t('ev.session_n', { n: index + 1 })}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-amber px-3 py-1 text-sm font-black text-black">{index + 1}</span>
        <strong className="uppercase tracking-wide">{sessionTitle(t, spec)}</strong>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1 hover:border-amber disabled:opacity-35"
            aria-label={t('ev.move_up')}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1 hover:border-amber disabled:opacity-35"
            aria-label={t('ev.move_down')}
            disabled={index === all.length - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="rounded-md border border-line px-3 py-1 text-signal hover:border-signal"
            aria-label={t('ev.remove_session')}
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('ev.kind')}>
          <select className={input} value={spec.kind} onChange={(e) => set({ kind: e.target.value as SessionKind })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`ev.kind.${k}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('ev.session_name')}>
          <input
            className={input}
            value={spec.name}
            maxLength={40}
            placeholder={t(`ev.kind.${spec.kind}`)}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label={t('controls.mode')}>
          <select
            className={input}
            value={mode}
            disabled={qualifying}
            title={qualifying ? t('ev.qualifying_timed') : undefined}
            onChange={(e) => set({ mode: e.target.value as RaceMode })}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`mode.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        {mode === 'laps' && (
          <Field label={t('controls.laps')}>
            <input
              className={input}
              type="number"
              min={1}
              max={999}
              value={spec.target_laps}
              onChange={(e) => set({ target_laps: num(e.target.value, 1, 999) })}
            />
          </Field>
        )}
        {mode === 'timed' && (
          <Field label={t('controls.duration')}>
            <input
              className={input}
              type="number"
              min={10}
              max={86400}
              value={spec.duration_s}
              onChange={(e) => set({ duration_s: num(e.target.value, 10, 86400) })}
            />
          </Field>
        )}
        <Field label={t('ev.false_start_rule')}>
          <select
            className={input}
            value={spec.false_start.action}
            onChange={(e) =>
              set({ false_start: { ...spec.false_start, action: e.target.value as SessionSpec['false_start']['action'] } })
            }
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`ev.fs.${a}`)}
              </option>
            ))}
          </select>
        </Field>
        {spec.false_start.action === 'penalty' && (
          <Field label={t('ev.penalty_s')}>
            <input
              className={input}
              type="number"
              min={0}
              max={120}
              value={spec.false_start.penalty_s}
              onChange={(e) => set({ false_start: { ...spec.false_start, penalty_s: num(e.target.value, 0, 120) } })}
            />
          </Field>
        )}
        <Field label={t('ev.grid_from')}>
          <select
            className={input}
            value={spec.grid_from ?? ''}
            disabled={index === 0}
            onChange={(e) => set({ grid_from: e.target.value || null })}
          >
            <option value="">{t('ev.grid_none')}</option>
            {gridChoices(all, index).map((g) => (
              <option key={g.id} value={g.id}>
                {all.indexOf(g) + 1}. {sessionTitle(t, g)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </li>
  )
}

/** Full editor for one program: sessions, commentary context, save. */
export function ProgramEditor({
  program,
  onSaved,
  onClose,
}: {
  program: EventProgram
  onSaved: (saved: EventProgram) => void
  onClose: () => void
}) {
  const t = useT()
  const [draft, setDraft] = useState<EventProgram>(program)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)
  const issues = validateProgram(draft)
  const com = draft.commentary
  const setCom = (patch: Partial<CommentaryContext>) => setDraft((d) => ({ ...d, commentary: { ...d.commentary, ...patch } }))
  const setSessions = (sessions: SessionSpec[]) => setDraft((d) => ({ ...d, sessions }))

  const save = async () => {
    setTried(true)
    setServerError(null)
    if (issues.length) return
    setSaving(true)
    try {
      const saved = await api.saveProgram(prepareForSave(draft))
      onSaved(saved)
    } catch (e) {
      setServerError(apiErrorMessage(e, t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label={t('ev.editor')} data-testid="program-editor">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('ev.program_name')} className="min-w-64 flex-1">
          <input
            className={`${input} ${tried && issues.some((i) => i.code === 'name_required') ? 'border-signal' : ''}`}
            value={draft.name}
            maxLength={80}
            data-testid="program-name"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <button type="button" className="rounded-md border border-line px-4 py-2 font-bold uppercase hover:border-amber" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="rounded-md bg-go px-5 py-2 font-bold uppercase text-black disabled:opacity-35"
          disabled={saving}
          data-testid="program-save"
          onClick={() => void save()}
        >
          {t('ev.save')}
        </button>
      </div>

      {(tried && issues.length > 0) || serverError ? (
        <ul role="alert" data-testid="program-issues" className="rounded-md border border-signal bg-[#2a1210] p-3 text-sm">
          {tried && issues.map((i, n) => <li key={n}>{issueText(t, i)}</li>)}
          {serverError && <li>{serverError}</li>}
        </ul>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-bold uppercase tracking-widest text-dim">{t('ev.sessions')}</h3>
        <ol className="flex flex-col gap-2">
          {draft.sessions.map((s, i) => (
            <SessionCard
              key={s.id}
              spec={s}
              index={i}
              all={draft.sessions}
              onChange={(next) => setSessions(cleanGrid(draft.sessions.map((x, j) => (j === i ? next : x))))}
              onMove={(d) => setSessions(moveSession(draft.sessions, i, d))}
              onRemove={() => setSessions(removeSession(draft.sessions, i))}
            />
          ))}
        </ol>
        <div className="mt-2 flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`add-${k}`}
              className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm font-bold uppercase hover:border-amber disabled:opacity-35"
              disabled={draft.sessions.length >= MAX_SESSIONS}
              onClick={() => setSessions(addSession(draft.sessions, k))}
            >
              + {t(`ev.kind.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-3">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-widest text-dim">{t('ev.commentary')}</h3>
        <p className="mb-3 text-sm text-dim">{t('ev.commentary_hint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('ev.event_name')}>
            <input className={input} value={com.event_name} maxLength={80} onChange={(e) => setCom({ event_name: e.target.value })} />
          </Field>
          <Field label={t('ev.location')}>
            <input className={input} value={com.location} maxLength={80} onChange={(e) => setCom({ location: e.target.value })} />
          </Field>
          <Field label={t('ev.tone')}>
            <select className={input} value={com.tone} data-testid="tone" onChange={(e) => setCom({ tone: e.target.value as CommentaryContext['tone'] })}>
              {TONES.map((x) => (
                <option key={x} value={x}>
                  {t(`ev.tone.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          <ChipInput label={t('ev.sponsors')} values={com.sponsors} max={MAX_SPONSORS} testId="sponsors" onChange={(v) => setCom({ sponsors: v })} />
          <Field label={t('ev.notes')} className="sm:col-span-2">
            <textarea className={`${input} min-h-20`} value={com.notes} maxLength={2000} onChange={(e) => setCom({ notes: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <ChipInput label={t('ev.avoid_words')} values={com.avoid_words} max={MAX_AVOID_WORDS} testId="avoid-words" onChange={(v) => setCom({ avoid_words: v })} />
          </div>
        </div>
        <p className="mt-3 text-xs text-dim">{t('ev.commentary_privacy')}</p>
      </div>
    </section>
  )
}
