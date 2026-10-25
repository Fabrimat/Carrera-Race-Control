import { useEffect, useRef, useState } from 'react'
import { useFormat, useT } from '../../i18n/useT'
import { advance, dismiss, emptyQueue, enqueue, nextWake, type Banner, type QueueState } from '../../lib/bannerQueue'
import {
  bannerForEvent,
  chequeredBanner,
  controlBanner,
  finalLapBanner,
  isFinalLap,
  type BannerContext,
} from '../../lib/tvBanners'
import { api } from '../../lib/api'
import { photoVersion } from '../../lib/drivers'
import { useStore } from '../../lib/store'
import type { CarState } from '../../lib/types'

export interface BannerView {
  banner: Banner
  exiting: boolean
}

/**
 * Turns the live store (domain events and race-state transitions) into queued broadcast banners
 * and tracks which one is on screen. Existing events are marked as seen on mount, so opening
 * the TV window never replays history.
 */
/** Photo URL of the driver assigned to a car, if that driver has one. */
function photoFor(car: CarState): string | null {
  if (!car.driver_id) return null
  const d = useStore.getState().drivers.find((x) => x.id === car.driver_id)
  return d?.has_photo ? api.driverPhotoUrl(d.id, photoVersion(d.id)) : null
}

export function useBanners(codes: Map<number, string>): BannerView | null {
  const t = useT()
  const f = useFormat()
  const [queue, setQueue] = useState<QueueState>(emptyQueue)
  // `clock` is the time of the last timer wake-up; it drives the exiting flag.
  const [clock, setClock] = useState(0)
  const ctx = useRef<BannerContext | null>(null)
  useEffect(() => {
    ctx.current = { cars: useStore.getState().race.cars, codes, t, lap: f.lap, photoFor }
  })

  useEffect(() => {
    const push = (b: Banner | null) => {
      if (b) setQueue((q) => enqueue(q, b, performance.now()))
    }
    const context = (): BannerContext => ({
      ...(ctx.current as BannerContext),
      cars: useStore.getState().race.cars,
    })
    const seen = new WeakSet<object>(useStore.getState().events)
    let prev = useStore.getState().race
    let finalFor: number | null = null
    if (prev.phase === 'finished') push(chequeredBanner(prev, context()))

    return useStore.subscribe((s) => {
      for (const e of s.events) {
        if (seen.has(e)) continue
        seen.add(e)
        push(bannerForEvent(e, context()))
      }
      const race = s.race
      if (race === prev) return
      const c = context()
      push(controlBanner(prev, race, c.t))
      if (isFinalLap(race) && finalFor !== race.race_id) {
        finalFor = race.race_id
        push(finalLapBanner(race, c.t))
      }
      if (race.phase === 'finished' && prev.phase !== 'finished') push(chequeredBanner(race, c))
      if (prev.phase === 'finished' && race.phase !== 'finished') {
        const id = `chequered:${prev.race_id}`
        const at = performance.now()
        setQueue((q) => dismiss(q, id, at))
        setClock(at)
      }
      prev = race
    })
  }, [])

  useEffect(() => {
    const now = performance.now()
    const wait = nextWake(queue, now)
    if (wait === null) return
    const id = setTimeout(() => {
      const at = performance.now()
      setQueue((q) => advance(q, at))
      setClock(at)
    }, wait)
    return () => clearTimeout(id)
  }, [queue, clock])

  if (!queue.active) return null
  return { banner: queue.active.banner, exiting: clock + 2 >= queue.active.exitAt }
}
