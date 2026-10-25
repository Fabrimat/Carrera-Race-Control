import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { api, ApiError } from '../lib/api'
import { ADDRESSES, carSlots, crossingState, driverLabel, rememberDriver } from '../lib/drivers'
import { guarded, notifyError } from '../lib/errors'
import { useStore } from '../lib/store'
import type { Driver } from '../lib/types'
import { DriverAvatar } from './DriverAvatar'
import { DriverPicker } from './DriverPicker'

type Picking = { kind: 'car'; address: number } | { kind: 'crossing' } | null

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** "Who's driving?": one big tile per controller, plus "assign by crossing". */
export function WhoDriving() {
  const t = useT()
  const settingsCars = useStore((s) => s.settings?.cars)
  const raceCars = useStore((s) => s.race.cars)
  const drivers = useStore((s) => s.drivers)
  const assignments = useStore((s) => s.assignments)
  const armedDriverId = useStore((s) => s.armedDriverId)
  const armedUntil = useStore((s) => s.armedUntil)
  const lastAssignment = useStore((s) => s.lastAssignment)
  const [picking, setPicking] = useState<Picking>(null)
  const [done, setDone] = useState<string | null>(null)
  const seenAssignment = useRef(lastAssignment)

  const slots = carSlots(settingsCars ?? raceCars)
  const byId = new Map(drivers.map((d) => [d.id, d]))
  const armed = armedDriverId !== null
  const now = useNow(armed)
  const countdown = armed ? crossingState(armedUntil, now) : { status: 'idle' as const }
  const expired = armed && countdown.status === 'expired'

  // Success feedback when a `driver_assigned` (crossing) event arrives.
  useEffect(() => {
    if (!lastAssignment || lastAssignment === seenAssignment.current) return
    seenAssignment.current = lastAssignment
    if (lastAssignment.method === 'crossing') {
      setDone(t('who.crossing_done', { name: lastAssignment.driver_name, n: lastAssignment.address + 1 }))
    }
  }, [lastAssignment, t])

  // The server drops an expired arming on its own; mirror that locally.
  useEffect(() => {
    if (expired) {
      useStore.getState().setArmed(null, null)
      setDone(t('who.crossing_expired'))
    }
  }, [expired, t])

  const assign = async (address: number, driver: Driver | null) => {
    setPicking(null)
    const res = await guarded(() => api.setAssignments({ [String(address)]: driver ? driver.id : null }))
    if (!res) return
    if (driver) rememberDriver(driver.id)
    useStore.getState().setAssignments(res.assignments)
  }

  const clearAll = async () => {
    const body = Object.fromEntries(ADDRESSES.map((a) => [String(a), null]))
    const res = await guarded(() => api.setAssignments(body))
    if (res) useStore.getState().setAssignments(res.assignments)
  }

  const arm = async (driver: Driver | null) => {
    setPicking(null)
    if (!driver) return
    setDone(null)
    rememberDriver(driver.id)
    let ok: { armed: boolean } | undefined
    try {
      ok = await api.armNextCrossing(driver.id)
    } catch (e) {
      // `busy` is ambiguous with the track's busy code, so it is handled here.
      if (e instanceof ApiError && e.code === 'busy') useStore.getState().pushToast(t('who.busy'))
      else notifyError(e)
    }
    if (!ok) return
    const ev = await guarded(() => api.event())
    if (ev) useStore.getState().setEventState(ev)
    else useStore.getState().setArmed(driver.id, null)
  }

  const cancel = async () => {
    await guarded(() => api.cancelNextCrossing())
    useStore.getState().setArmed(null, null)
  }

  const armedDriver = armedDriverId ? byId.get(armedDriverId) : undefined

  return (
    <section aria-label={t('who.title')} data-testid="who-driving" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-black uppercase tracking-widest">{t('who.title')}</h2>
        <button
          type="button"
          data-testid="by-crossing"
          disabled={armed}
          className="min-h-12 rounded-md border border-line bg-panel-2 px-4 text-base font-bold uppercase tracking-wide hover:border-amber disabled:opacity-40"
          onClick={() => setPicking({ kind: 'crossing' })}
        >
          {t('who.by_crossing')}
        </button>
        <button
          type="button"
          data-testid="clear-all"
          className="min-h-12 rounded-md border border-line bg-panel-2 px-4 text-base font-bold uppercase tracking-wide hover:border-signal"
          onClick={() => void clearAll()}
        >
          {t('who.clear_all')}
        </button>
      </div>
      <p className="text-sm text-dim">{t('who.keep')}</p>

      {armed && (
        <div
          role="status"
          data-testid="crossing-banner"
          className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-amber bg-amber/10 px-4 py-3"
        >
          <span className="flex-1 text-lg font-black">
            {t('who.crossing_wait', {
              name: armedDriver ? driverLabel(armedDriver) : '…',
              seconds: countdown.status === 'armed' ? countdown.seconds : 0,
            })}
          </span>
          <button
            type="button"
            data-testid="crossing-cancel"
            className="min-h-12 rounded-md border border-line bg-panel-2 px-4 font-bold uppercase"
            onClick={() => void cancel()}
          >
            {t('who.crossing_cancel')}
          </button>
        </div>
      )}
      {!armed && done && (
        <p role="status" data-testid="crossing-done" className="rounded-lg border border-go bg-go/10 px-4 py-2 font-bold">
          {done}
        </p>
      )}

      <ul className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-3">
        {slots.map((c) => {
          const driver = byId.get(assignments[String(c.address)] ?? '')
          return (
            <li key={c.address}>
              <button
                type="button"
                data-testid="car-tile"
                data-address={c.address}
                aria-label={t('who.tile', {
                  n: c.address + 1,
                  name: c.name,
                  driver: driver ? driver.name : t('who.no_driver'),
                })}
                className="flex min-h-28 w-full items-center gap-3 rounded-lg border border-line bg-panel-2 p-3 text-left transition-colors hover:border-amber focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber"
                style={{ borderLeft: `8px solid ${c.color}` }}
                onClick={() => setPicking({ kind: 'car', address: c.address })}
              >
                {driver ? <DriverAvatar driver={driver} size={56} /> : null}
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-bold uppercase tracking-widest text-dim">
                    {t('who.controller', { n: c.address + 1 })} · {c.name}
                  </span>
                  <span className={`truncate text-2xl font-black ${driver ? '' : 'text-dim'}`}>
                    {driver ? driver.name : t('who.no_driver')}
                  </span>
                  {driver?.nickname && <span className="truncate text-sm text-dim">{driver.nickname}</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {picking?.kind === 'car' && (
        <DriverPicker
          allowNone
          title={t('who.picker_title_car', {
            name: slots.find((c) => c.address === picking.address)?.name ?? '',
          })}
          onPick={(d) => void assign(picking.address, d)}
          onClose={() => setPicking(null)}
        />
      )}
      {picking?.kind === 'crossing' && (
        <DriverPicker title={t('who.picker_title_crossing')} onPick={(d) => void arm(d)} onClose={() => setPicking(null)} />
      )}
    </section>
  )
}
