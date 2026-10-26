import { useCallback, useEffect, useState } from 'react'
import { CarLogo } from '../components/CarLogo'
import { ControllerFields, ControllerSummary } from '../components/ControllerFields'
import { Modal } from '../components/Modal'
import { PairingWizard } from '../components/PairingWizard'
import { useFormat, useT } from '../i18n/useT'
import { api } from '../lib/api'
import {
  controllerBadge,
  controllerErrorMessage,
  sameController,
  useControllerStatuses,
  type ControllerBadge,
} from '../lib/controller'
import { guarded, notifyError } from '../lib/errors'
import { applyCarPatches, saveSettings } from '../lib/settingsSave'
import { useStore } from '../lib/store'
import type { CarConfig, ControllerSettings, ControllerStatus, GarageCar } from '../lib/types'
import { driverLabel } from '../lib/drivers'

const btn = 'min-h-11 rounded-md border border-line bg-panel-2 px-4 text-sm font-bold uppercase tracking-wide hover:border-go'

const BADGE_STYLE: Record<ControllerBadge, string> = {
  pending: 'border-amber text-amber',
  applied: 'border-go text-go',
  unset: 'border-line text-dim',
}

function StatusBadge({ status }: { status: ControllerStatus | undefined }) {
  const t = useT()
  const kind = controllerBadge(status)
  return (
    <span
      data-testid="ctl-badge"
      data-status={kind}
      className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase tracking-widest ${BADGE_STYLE[kind]}`}
    >
      {t(`ctl.status.${kind}`)}
    </span>
  )
}

function EditSettingsModal({ car, onClose, onSaved }: { car: CarConfig; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [ctl, setCtl] = useState<ControllerSettings>(car.controller)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    const res = await guarded(() => saveSettings((s) => applyCarPatches(s, { [car.address]: { controller: ctl } })))
    setSaving(false)
    if (res !== undefined) {
      onSaved()
      onClose()
    }
  }
  return (
    <Modal label={t('garage.edit_title', { name: car.name })} onClose={onClose} width="max-w-2xl">
      <h2 className="mb-3 text-lg font-black uppercase tracking-widest">{t('garage.edit_title', { name: car.name })}</h2>
      <ControllerFields value={ctl} onChange={setCtl} mode="car" testId="garage-ctl" presets />
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={saving || sameController(ctl, car.controller)}
          data-testid="garage-ctl-save"
          className="min-h-11 rounded-md border border-go bg-go/20 px-5 text-sm font-bold uppercase tracking-wide disabled:opacity-50"
          onClick={() => void save()}
        >
          {t('settings.save')}
        </button>
        <button type="button" className={btn} onClick={onClose}>
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}

function CarCard({
  g,
  status,
  onEdit,
  onPair,
}: {
  g: GarageCar
  status: ControllerStatus | undefined
  onEdit: () => void
  onPair: () => void
}) {
  const t = useT()
  const fmt = useFormat()
  const drivers = useStore((s) => s.drivers)
  const driver = status?.driver_id ? drivers.find((d) => d.id === status.driver_id) : undefined
  const shown = status?.effective ?? g.car.controller
  return (
    <li
      className="flex flex-col gap-3 overflow-hidden rounded-lg border border-line bg-panel p-0"
      data-testid="garage-card"
      data-address={g.address}
    >
      <div className="h-1.5" style={{ background: g.car.color }} aria-hidden />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 shrink-0 rounded-full border border-line" style={{ background: g.car.color }} aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-lg font-black" data-testid="garage-name">
              {g.car.name}
            </span>
            {g.car.nickname && <span className="truncate text-sm text-dim">{g.car.nickname}</span>}
          </span>
          <CarLogo logoId={g.car.logo_id} size={36} />
          <span
            className="num rounded-md border border-line bg-panel-2 px-2 py-1 text-sm font-bold"
            data-testid="garage-controller"
            title={t('garage.controller')}
          >
            #{g.address + 1}
          </span>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div className="col-span-3">
            <dt className="text-xs uppercase tracking-widest text-dim">{t('garage.best_lap')}</dt>
            <dd className="num text-xl font-bold" data-testid="garage-best">
              {g.best_lap_ms === null ? (
                '—'
              ) : (
                <>
                  {fmt.lap(g.best_lap_ms)}
                  {g.best_lap_layout && <span className="ml-2 text-sm font-normal text-dim">{g.best_lap_layout}</span>}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-widest text-dim">{t('garage.races')}</dt>
            <dd className="num font-bold" data-testid="garage-races">
              {g.races}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-widest text-dim">{t('garage.laps')}</dt>
            <dd className="num font-bold" data-testid="garage-laps">
              {g.laps}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-widest text-dim">{t('ctl.title')}</span>
            <StatusBadge status={status} />
          </div>
          <ControllerSummary value={shown} className="text-sm" />
          {driver && (
            <span className="text-xs text-dim" data-testid="garage-driver">
              {t('garage.driver_profile', { name: driverLabel(driver) })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="garage-edit" className={btn} onClick={onEdit}>
            {t('garage.edit')}
          </button>
          <button type="button" data-testid="garage-pair" className={btn} onClick={onPair}>
            {t('pair.pair')}
          </button>
        </div>
      </div>
    </li>
  )
}

/** `#/garage`: one card per car with its history, controller settings and status. */
export function Garage() {
  const t = useT()
  const ws = useStore((s) => s.ws)
  const settingsCars = useStore((s) => s.settings?.cars)
  const [cars, setCars] = useState<GarageCar[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [pairFor, setPairFor] = useState<number | 'new' | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const { statuses, setStatuses, reload: reloadStatuses } = useControllerStatuses(ws === 'open')

  const reload = useCallback(async () => {
    try {
      setCars((await api.garage()).cars)
    } catch (e) {
      notifyError(e)
    } finally {
      setLoaded(true)
    }
  }, [])
  useEffect(() => {
    if (ws !== 'open') return
    api.garage().then(
      (r) => {
        setCars(r.cars)
        setLoaded(true)
      },
      (e) => {
        notifyError(e)
        setLoaded(true)
      },
    )
  }, [ws])

  const apply = async () => {
    setApplying(true)
    setApplyError(null)
    try {
      setStatuses((await api.applyControllers()).controllers)
    } catch (e) {
      setApplyError(controllerErrorMessage(e, t))
    } finally {
      setApplying(false)
    }
  }

  // Prefer the freshest car profile from settings (just edited or paired) over the garage payload.
  const merged = cars.map((g) => ({ ...g, car: settingsCars?.find((c) => c.address === g.address) ?? g.car }))
  const anyPending = statuses.some((s) => s.pending)
  const editingCar = merged.find((g) => g.address === editing)?.car
  const wizardCars = settingsCars ?? merged.map((g) => g.car)

  return (
    <div data-testid="garage-page" className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-black uppercase tracking-widest">{t('garage.title')}</h1>
        {anyPending && (
          <span className="text-sm text-amber" data-testid="garage-pending-note">
            {t('garage.pending_note')}
          </span>
        )}
        <button type="button" data-testid="garage-apply" disabled={applying} className={btn} onClick={() => void apply()}>
          {t('ctl.apply_now')}
        </button>
        <button type="button" data-testid="garage-pair-new" className={btn} onClick={() => setPairFor('new')}>
          {t('pair.open')}
        </button>
      </div>
      {applyError && (
        <p role="alert" className="text-sm text-signal" data-testid="garage-apply-error">
          {applyError}
        </p>
      )}
      <p className="text-xs text-dim">{t('ctl.note')}</p>
      {loaded && merged.length === 0 && <p className="text-dim">{t('garage.empty')}</p>}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {merged.map((g) => (
          <CarCard
            key={g.address}
            g={g}
            status={statuses.find((s) => s.address === g.address)}
            onEdit={() => setEditing(g.address)}
            onPair={() => setPairFor(g.address)}
          />
        ))}
      </ul>
      {editingCar && (
        <EditSettingsModal
          car={editingCar}
          onClose={() => setEditing(null)}
          onSaved={() => {
            void reload()
            void reloadStatuses()
          }}
        />
      )}
      {pairFor !== null && (
        <PairingWizard
          cars={wizardCars}
          initialAddress={pairFor === 'new' ? null : pairFor}
          onClose={() => setPairFor(null)}
          onPaired={() => {
            void reload()
            void reloadStatuses()
          }}
        />
      )}
    </div>
  )
}
