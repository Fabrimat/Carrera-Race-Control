import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n/useT'
import { apiErrorMessage } from '../lib/errors'
import {
  applyCarPatches,
  saveSettings,
  saveSettingsKeepalive,
  validateCarPatch,
} from '../lib/settingsSave'
import type { CarConfig } from '../lib/types'

const input = 'rounded-md border border-line bg-panel-2 px-3 py-2'
const AUTOSAVE_MS = 600

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }
type CarEdits = Record<number, Partial<CarConfig>>

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
      {label}
      {children}
    </label>
  )
}

/** Only the fields that pass client-side validation; invalid ones are never sent. */
export function sendableEdits(edits: CarEdits): CarEdits {
  const out: CarEdits = {}
  for (const [addr, patch] of Object.entries(edits)) {
    const bad = validateCarPatch(patch)
    const ok: Partial<CarConfig> = {}
    if (patch.name !== undefined && !bad.name) ok.name = patch.name.trim()
    if (patch.color !== undefined && !bad.color) ok.color = patch.color
    if (patch.nickname !== undefined) ok.nickname = patch.nickname
    if (Object.keys(ok).length > 0) out[Number(addr)] = ok
  }
  return out
}

/** Edits minus the fields whose current value equals what was just saved. */
function dropSaved(edits: CarEdits, sent: CarEdits): CarEdits {
  const next: CarEdits = {}
  for (const [addr, patch] of Object.entries(edits)) {
    const was = sent[Number(addr)] ?? {}
    const rest: Partial<CarConfig> = { ...patch }
    // Compare RAW values: an edit with a trailing space stays in the overlay so the input keeps it.
    if (was.name !== undefined && patch.name === was.name) delete rest.name
    if (was.color !== undefined && patch.color === was.color) delete rest.color
    if (was.nickname !== undefined && patch.nickname === was.nickname) delete rest.nickname
    if (Object.keys(rest).length > 0) next[Number(addr)] = rest
  }
  return next
}

/**
 * Car name / nickname / colour editor with debounced autosave. Edits live in a local
 * overlay on top of the store's cars; a save PUTs the freshest store settings merged with
 * only these edits, so other settings (e.g. the UI language) are never clobbered.
 */
export function CarsSection({ cars }: { cars: CarConfig[] }) {
  const t = useT()
  const [edits, setEdits] = useState<CarEdits>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const editsRef = useRef<CarEdits>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const sent = sendableEdits(editsRef.current)
    if (Object.keys(sent).length === 0) return
    setStatus({ kind: 'saving' })
    try {
      await saveSettings((cur) => applyCarPatches(cur, sent))
      // Newer keystrokes made while the PUT was in flight stay pending.
      editsRef.current = dropSaved(editsRef.current, sent)
      setEdits(editsRef.current)
      setStatus({ kind: 'saved' })
    } catch (e) {
      setStatus({ kind: 'error', message: apiErrorMessage(e, t) })
    }
  }, [t])

  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  useEffect(() => {
    const onUnload = () => saveSettingsKeepalive(sendableEdits(editsRef.current))
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      void flushRef.current() // flush pending edits when leaving the page
    }
  }, [])

  const edit = (address: number, patch: Partial<CarConfig>) => {
    editsRef.current = { ...editsRef.current, [address]: { ...editsRef.current[address], ...patch } }
    setEdits(editsRef.current)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }

  const anyInvalid = Object.values(edits).some((p) => Object.keys(validateCarPatch(p)).length > 0)
  let statusText = ''
  if (anyInvalid) statusText = t('settings.autosave_invalid')
  else if (status.kind === 'saving') statusText = t('settings.autosave_saving')
  else if (status.kind === 'saved') statusText = t('settings.autosave_saved')
  else if (status.kind === 'error') statusText = t('settings.autosave_error', { error: status.message })

  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <h3 className="mb-3 text-sm font-bold uppercase tracking-widest text-dim">{t('settings.cars')}</h3>
      <div className="flex flex-col gap-2">
        {cars.map((c) => {
          const e = edits[c.address] ?? {}
          const name = e.name ?? c.name
          const color = e.color ?? c.color
          const nickname = e.nickname !== undefined ? e.nickname : c.nickname
          const bad = validateCarPatch({ name, color })
          return (
            <div key={c.address} className="grid grid-cols-[3rem_1fr_1fr_4rem] items-start gap-3" data-testid="car-row">
              <span className="num pt-6 text-xl font-bold">{c.address + 1}</span>
              <Field label={t('settings.car_name')}>
                <input
                  className={`${input} ${bad.name ? 'border-signal' : ''}`}
                  value={name}
                  aria-invalid={bad.name === true}
                  data-testid="car-name"
                  onChange={(ev) => edit(c.address, { name: ev.target.value })}
                />
                {bad.name && (
                  <span className="text-xs normal-case tracking-normal text-signal">{t('settings.invalid_name')}</span>
                )}
              </Field>
              <Field label={t('settings.car_nickname')}>
                <input
                  className={input}
                  value={nickname ?? ''}
                  data-testid="car-nickname"
                  onChange={(ev) => edit(c.address, { nickname: ev.target.value || null })}
                />
              </Field>
              <Field label={t('settings.car_color')}>
                <input
                  type="color"
                  className="h-10 w-full rounded-md border border-line bg-panel-2"
                  value={color}
                  aria-invalid={bad.color === true}
                  data-testid="car-color"
                  onChange={(ev) => edit(c.address, { color: ev.target.value })}
                />
              </Field>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-sm text-dim">
        {t('settings.autosave_hint')}{' '}
        <span
          role="status"
          data-testid="cars-status"
          className={status.kind === 'error' || anyInvalid ? 'text-signal' : ''}
        >
          {statusText}
        </span>
      </p>
    </section>
  )
}
