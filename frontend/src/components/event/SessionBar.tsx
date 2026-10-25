import { useEffect, useState } from 'react'
import { useT } from '../../i18n/useT'
import { api } from '../../lib/api'
import { notifyError } from '../../lib/errors'
import { activeProgram, currentSpec, gridResult, useEventUi } from '../../lib/eventStore'
import { formatClock } from '../../lib/format'
import { tNow, useStore } from '../../lib/store'
import type { EventState, SessionSpec } from '../../lib/types'
import { sessionTitle } from './ProgramEditor'
import { SessionResultModal } from './SessionResultModal'

const btn = 'rounded-md px-3 py-1 text-sm font-bold uppercase tracking-wide disabled:cursor-not-allowed disabled:opacity-35'

function specSummary(t: ReturnType<typeof useT>, s: SessionSpec): string {
  const mode = s.kind === 'qualifying' ? 'timed' : s.mode
  if (mode === 'laps') return t('ev.laps_count', { count: s.target_laps })
  if (mode === 'timed') return formatClock(s.duration_s * 1000)
  return t('mode.practice')
}

/** Keeps the event UI state in sync with the backend and reacts to session / false start events. */
function useEventSync() {
  const ws = useStore((s) => s.ws)
  const sessionId = useStore((s) => s.race.session?.session_id ?? null)
  useEffect(() => {
    if (ws !== 'open') return
    useEventUi.getState().refresh().catch(() => undefined)
  }, [ws, sessionId])

  useEffect(() => {
    const seen = new WeakSet<object>(useStore.getState().events)
    return useStore.subscribe((s) => {
      for (const e of s.events) {
        if (seen.has(e)) continue
        seen.add(e)
        if (e.type === 'false_start') {
          const car = useStore.getState().race.cars.find((c) => c.address === e.address)
          const who = car ? (car.driver_name ?? car.name) : null
          const key =
            e.action === 'penalty'
              ? 'ev.toast.false_start_penalty'
              : e.action === 'restart'
                ? 'ev.toast.false_start_restart'
                : 'ev.toast.false_start'
          useStore.getState().pushToast(
            tNow(key, { name: who ?? tNow('ev.toast.unknown_car'), seconds: Math.round(e.penalty_ms / 1000) }),
            'error',
          )
        } else if (e.type === 'session_finished') {
          const id = e.session_id
          api.event().then(
            (ev) => {
              const ui = useEventUi.getState()
              ui.setEvent(ev)
              const r = ev.results.find((x) => x.session_id === id)
              if (r) ui.showFinished(r)
            },
            () => undefined,
          )
        }
      }
    })
  }, [])
}

/**
 * Compact session runner for the dashboard: start an event, see the running session and move on.
 * Renders nothing until a program exists or an event is active, so it costs no space otherwise.
 */
export function SessionBar() {
  const t = useT()
  useEventSync()
  const race = useStore((s) => s.race)
  const event = useEventUi((s) => s.event)
  const programs = useEventUi((s) => s.programs)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const program = activeProgram(event, programs)
  const spec = currentSpec(event, programs)
  const live = race.phase === 'starting' || race.phase === 'running' || race.phase === 'paused'

  const run = async (fn: () => Promise<EventState>) => {
    setBusy(true)
    try {
      useEventUi.getState().setEvent(await fn())
    } catch (e) {
      notifyError(e)
    }
    setBusy(false)
  }

  let body = null
  if (event?.program_id && program && spec) {
    const total = program.sessions.length
    const index = event.current_index
    const grid = gridResult(event, spec)
    body = (
      <>
        <span className="text-xs font-bold uppercase tracking-widest text-dim">{program.name}</span>
        <span data-testid="session-label" className="text-base font-black uppercase tracking-wide">
          {t('ev.session_label', { n: index + 1, total, kind: sessionTitle(t, spec), spec: specSummary(t, spec) })}
        </span>
        {grid && race.phase === 'idle' && (
          <span data-testid="session-grid" className="truncate text-sm text-dim">
            {t('ev.grid')}: {grid.classification.slice(0, 6).map((r) => `${r.position}. ${r.name}`).join(' · ')}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            data-testid="next-session"
            className={`${btn} bg-amber text-black`}
            disabled={busy || live || index + 1 >= total}
            onClick={() => void run(() => api.nextSession())}
          >
            {t('ev.next_session')}
          </button>
          <button
            type="button"
            data-testid="stop-event"
            className={`${btn} border border-line bg-panel-2 text-ink`}
            disabled={busy}
            onClick={() => void run(() => api.stopEvent())}
          >
            {t('ev.stop_event')}
          </button>
        </span>
      </>
    )
  } else if (programs.length > 0) {
    const chosen = pick || programs[0].id
    body = (
      <>
        <span className="text-xs font-bold uppercase tracking-widest text-dim">{t('ev.title')}</span>
        <select
          aria-label={t('ev.pick_program')}
          data-testid="program-pick"
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-sm"
          value={chosen}
          onChange={(e) => setPick(e.target.value)}
        >
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="start-event"
          className={`${btn} bg-go text-black`}
          disabled={busy || live}
          onClick={() => void run(() => api.startEvent(chosen))}
        >
          {t('ev.start_event')}
        </button>
      </>
    )
  }

  return (
    <>
      {body && (
        <section
          aria-label={t('ev.runner')}
          data-testid="session-bar"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-3 py-1"
        >
          {body}
        </section>
      )}
      <SessionResultModal />
    </>
  )
}
