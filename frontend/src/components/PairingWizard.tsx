import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n/useT'
import { api, ApiError } from '../lib/api'
import { controllerErrorMessage, EMPTY_CONTROLLER } from '../lib/controller'
import { loadLogos, useLogos } from '../lib/logos'
import { MAX_CAR_NAME, validateCarPatch } from '../lib/settingsSave'
import { useStore } from '../lib/store'
import type { CarConfig, ControllerSettings, PairingState } from '../lib/types'
import { CarLogo } from './CarLogo'
import { ControllerFields } from './ControllerFields'
import { Modal } from './Modal'
import { CarOnTrack, ControllerButton, CrossTheLine, CuCodeLed } from './PairingIllustrations'

const input = 'min-h-10 rounded-md border border-line bg-panel-2 px-3 py-2'
const btn = 'min-h-11 rounded-md border border-line bg-panel-2 px-4 text-sm font-bold uppercase tracking-wide'
const primary = 'min-h-11 rounded-md border border-go bg-go/20 px-5 text-sm font-bold uppercase tracking-wide disabled:opacity-50'

/** The newer of the pairing the backend broadcast and the one our own call returned. */
export function pickPairing(store: PairingState | null, local: PairingState | null): PairingState | null {
  if (!store) return local
  if (!local) return store
  return Date.parse(local.started_at) > Date.parse(store.started_at) ? local : store
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim">
      {label}
      {children}
    </label>
  )
}

interface Props {
  /** The configured cars (settings). */
  cars: CarConfig[]
  /** Preselect this existing car (and its controller); null = start from a new car. */
  initialAddress?: number | null
  onClose: () => void
  /** Called once when a pairing completed (e.g. to reload the garage). */
  onPaired?: () => void
}

/**
 * Pairing wizard (docs/PROTOCOL.md "Pairing"): pick the car profile and the controller, start,
 * follow the steps, and watch `RaceState.pairing` until the car is paired, times out or is
 * cancelled. The CU may be left in CODE mode when it ends without a crossing: the UI says so.
 */
export function PairingWizard({ cars, initialAddress = null, onClose, onPaired }: Props) {
  const t = useT()
  const storePairing = useStore((s) => s.race.pairing)
  const logos = useLogos((s) => s.logos)

  const [profile, setProfile] = useState<'existing' | 'new'>(initialAddress !== null ? 'existing' : 'new')
  const [existing, setExisting] = useState<number>(initialAddress ?? cars[0]?.address ?? 0)
  const [target, setTarget] = useState<number>(initialAddress ?? 0)
  const [name, setName] = useState('')
  const [nickname, setNickname] = useState('')
  const [color, setColor] = useState('#e53935')
  const [logoId, setLogoId] = useState<string | null>(null)
  const [ctl, setCtl] = useState<ControllerSettings>({ ...EMPTY_CONTROLLER })
  const [touched, setTouched] = useState(false)

  const [local, setLocal] = useState<PairingState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    void loadLogos()
  }, [])

  const live = pickPairing(storePairing, local)
  // Setup form unless we started one here or the backend is already waiting for a car.
  const active = local !== null || storePairing?.phase === 'waiting'
  const pairing = active ? live : null
  const waiting = pairing?.phase === 'waiting'

  // Countdown while waiting.
  useEffect(() => {
    if (!waiting) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 250)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [waiting, pairing?.started_at])

  // On success: the backend stored the profile in settings; reload them once.
  const pairedKey = pairing?.phase === 'paired' ? pairing.started_at : null
  const onPairedRef = useRef(onPaired)
  useEffect(() => {
    onPairedRef.current = onPaired
  }, [onPaired])
  useEffect(() => {
    if (!pairedKey) return
    api.getSettings().then(
      (s) => useStore.getState().setSettings(s),
      () => undefined,
    )
    onPairedRef.current?.()
  }, [pairedKey])

  const call = useCallback(
    async (fn: () => Promise<PairingState>): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        setLocal(await fn())
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && e.code === 'not_found') {
          // nothing to cancel any more
        } else setError(controllerErrorMessage(e, t))
      } finally {
        setBusy(false)
      }
    },
    [t],
  )

  const existingCar = cars.find((c) => c.address === existing)
  const bad = profile === 'new' ? validateCarPatch({ name, color }) : {}
  const valid = profile === 'existing' ? existingCar !== undefined : !bad.name && !bad.color

  const start = () => {
    setTouched(true)
    if (!valid || busy) return
    const car: CarConfig =
      profile === 'existing' && existingCar
        ? { ...existingCar, address: target }
        : { address: target, name: name.trim(), color, nickname: nickname.trim() || null, logo_id: logoId, controller: ctl }
    const from = profile === 'existing' && existingCar && existingCar.address !== target ? existingCar.address : null
    void call(() => api.startPairing({ target_address: target, car, from_address: from }))
  }

  const chooseDetected = (p: PairingState) => {
    if (p.detected_address === null) return
    const addr = p.detected_address
    void call(() => api.startPairing({ target_address: addr, car: { ...p.car, address: addr }, from_address: p.from_address }))
  }

  const close = () => {
    // Do not leave a pairing armed behind a closed dialog.
    if (waiting) void api.cancelPairing().catch(() => undefined)
    onClose()
  }

  const retry = () => {
    setLocal(null)
    setError(null)
  }

  const codeHint = <p className="rounded-md border border-amber/50 bg-amber/10 p-3 text-sm">{t('pair.code_hint')}</p>

  let body: ReactNode
  if (!pairing) {
    body = (
      <form
        className="flex flex-col gap-4"
        data-testid="pair-setup"
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
      >
        <p className="text-sm text-dim">{t('pair.intro')}</p>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-xs uppercase tracking-widest text-dim">{t('pair.profile')}</legend>
          <div className="flex flex-wrap gap-4">
            {(['existing', 'new'] as const).map((p) => (
              <label key={p} className="flex min-h-10 items-center gap-2">
                <input
                  type="radio"
                  name="pair-profile"
                  className="h-4 w-4 accent-go"
                  checked={profile === p}
                  data-testid={`pair-profile-${p}`}
                  onChange={() => {
                    setProfile(p)
                    if (p === 'existing') setTarget(existing)
                  }}
                />
                {t(p === 'existing' ? 'pair.profile_existing' : 'pair.profile_new')}
              </label>
            ))}
          </div>
          {profile === 'existing' ? (
            <Field label={t('pair.car')}>
              <select
                className={input}
                value={existing}
                data-testid="pair-existing"
                onChange={(e) => {
                  setExisting(Number(e.target.value))
                  setTarget(Number(e.target.value))
                }}
              >
                {cars.map((c) => (
                  <option key={c.address} value={c.address}>
                    {c.address + 1} · {c.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('settings.car_name')}>
                <input
                  className={`${input} ${touched && bad.name ? 'border-signal' : ''}`}
                  value={name}
                  maxLength={MAX_CAR_NAME}
                  aria-invalid={touched && bad.name === true}
                  data-testid="pair-name"
                  onChange={(e) => setName(e.target.value)}
                />
                {touched && bad.name && (
                  <span className="text-xs normal-case tracking-normal text-signal">{t('settings.invalid_name')}</span>
                )}
              </Field>
              <Field label={t('settings.car_nickname')}>
                <input className={input} value={nickname} data-testid="pair-nickname" onChange={(e) => setNickname(e.target.value)} />
              </Field>
              <Field label={t('logos.car_logo')}>
                <span className="flex items-center gap-2">
                  <select
                    className={`${input} min-w-0 flex-1`}
                    value={logoId ?? ''}
                    data-testid="pair-logo"
                    onChange={(e) => setLogoId(e.target.value || null)}
                  >
                    <option value="">{t('logos.none')}</option>
                    {logos.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <CarLogo logoId={logoId} size={32} />
                </span>
              </Field>
              <Field label={t('settings.car_color')}>
                <input
                  type="color"
                  className="h-10 w-full rounded-md border border-line bg-panel-2"
                  value={color}
                  data-testid="pair-color"
                  onChange={(e) => setColor(e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <ControllerFields value={ctl} onChange={setCtl} mode="car" testId="pair-ctl" presets />
              </div>
            </div>
          )}
        </fieldset>
        <Field label={t('pair.controller')}>
          <select
            className={input}
            value={target}
            data-testid="pair-target"
            onChange={(e) => setTarget(Number(e.target.value))}
          >
            {[0, 1, 2, 3, 4, 5].map((a) => (
              <option key={a} value={a}>
                {t('pair.controller_option', { n: a + 1 })}
              </option>
            ))}
          </select>
        </Field>
        {profile === 'existing' && existingCar && existingCar.address !== target && (
          <p className="text-sm text-dim" data-testid="pair-recode-note">
            {t('pair.recode_note', { name: existingCar.name, from: existingCar.address + 1 })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-signal" data-testid="pair-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} data-testid="pair-start" className={primary}>
            {t('pair.start')}
          </button>
          <button type="button" className={btn} onClick={close}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    )
  } else if (pairing.phase === 'waiting') {
    const remaining = Date.parse(pairing.expires_at) - now
    const detected = pairing.detected_address
    const mismatch = detected !== null && detected !== pairing.target_address
    const steps: { art: ReactNode; text: string }[] = [
      { art: <CuCodeLed />, text: t('pair.step1') },
      { art: <CarOnTrack />, text: t('pair.step2') },
      { art: <ControllerButton />, text: t('pair.step3', { n: pairing.target_address + 1 }) },
      { art: <CrossTheLine />, text: t('pair.step4') },
    ]
    body = (
      <div className="flex flex-col gap-4" data-testid="pair-waiting">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-lg font-bold">
            {t('pair.waiting', { name: pairing.car.name, n: pairing.target_address + 1 })}
          </p>
          <span
            className="num rounded-md border border-line bg-panel-2 px-3 py-1 text-xl font-bold text-amber"
            data-testid="pair-countdown"
          >
            {t('pair.countdown', { time: formatCountdown(remaining) })}
          </span>
        </div>
        <ol className="grid gap-3 sm:grid-cols-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 p-2">
              <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-line text-sm font-bold">{i + 1}</span>
              <span className="shrink-0">{s.art}</span>
              <span className="text-sm">{s.text}</span>
            </li>
          ))}
        </ol>
        {mismatch && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-amber bg-amber/10 p-3" data-testid="pair-mismatch">
            <span className="flex-1 text-sm">
              {t('pair.mismatch', { detected: detected + 1, target: pairing.target_address + 1 })}
            </span>
            <button type="button" disabled={busy} data-testid="pair-use-detected" className={btn} onClick={() => chooseDetected(pairing)}>
              {t('pair.use_detected', { n: detected + 1 })}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-signal" data-testid="pair-error">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="pair-confirm"
            className={primary}
            onClick={() => void call(() => api.confirmPairing())}
          >
            {t('pair.led_stopped')}
          </button>
          <button type="button" disabled={busy} data-testid="pair-cancel" className={btn} onClick={() => void call(() => api.cancelPairing())}>
            {t('pair.cancel')}
          </button>
        </div>
      </div>
    )
  } else if (pairing.phase === 'paired') {
    const detected = pairing.detected_address
    body = (
      <div className="flex flex-col gap-4" data-testid="pair-paired">
        <p role="status" className="rounded-md border border-go bg-go/10 p-3 text-lg font-bold">
          {t('pair.paired', { name: pairing.car.name, controller: pairing.target_address + 1 })}
        </p>
        {detected !== null && detected !== pairing.target_address && (
          <p className="text-sm text-amber">{t('pair.paired_mismatch', { detected: detected + 1 })}</p>
        )}
        <div className="flex gap-2">
          <button type="button" data-testid="pair-done" className={primary} onClick={onClose}>
            {t('pair.done')}
          </button>
        </div>
      </div>
    )
  } else {
    // timeout | cancelled | failed
    const message =
      pairing.phase === 'timeout'
        ? t('pair.timeout')
        : pairing.phase === 'cancelled'
          ? pairing.error === 'race started'
            ? t('pair.race_started')
            : t('pair.cancelled')
          : t('pair.failed', { error: pairing.error ?? t('error.unknown') })
    body = (
      <div className="flex flex-col gap-4" data-testid={`pair-${pairing.phase}`}>
        <p role="status" className="rounded-md border border-signal bg-signal/10 p-3 font-bold">
          {message}
        </p>
        {codeHint}
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="pair-retry" className={primary} onClick={retry}>
            {t('pair.retry')}
          </button>
          <button type="button" className={btn} onClick={onClose}>
            {t('pair.close')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <Modal label={t('pair.title')} onClose={close} width="max-w-3xl">
      <h2 className="mb-3 text-lg font-black uppercase tracking-widest">{t('pair.title')}</h2>
      {body}
    </Modal>
  )
}
