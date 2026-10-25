import { useEffect, useRef, useState } from 'react'
import { useFormat, useT } from '../../i18n/useT'
import { api } from '../../lib/api'
import { advance, dismiss, emptyQueue, enqueue, nextWake, type Banner, type QueueState } from '../../lib/bannerQueue'
import {
  bannerForEvent,
  chequeredBanner,
  controlBanner,
  finalLapBanner,
  isFinalLap,
  sessionResultBanner,
  type BannerContext,
} from '../../lib/tvBanners'
import { useStore } from '../../lib/store'

export interface BannerView {
  banner: Banner
  exiting: boolean
}

/**
 * Turns the live store (domain events and race-state transitions) into queued broadcast banners
 * and tracks which one is on screen. Existing events are marked as seen on mount, so opening
 * the TV window never replays history.
 */
export function useBanners(codes: Map<number, string>): BannerView | null {
  const t = useT()
  const f = useFormat()
  const [queue, setQueue] = useState<QueueState>(emptyQueue)
  // `clock` is the time of the last timer wake-up; it drives the exiting flag.
  const [clock, setClock] = useState(0)
  const ctx = useRef<BannerContext | null>(null)
  useEffect(() => {
    ctx.current = { cars: useStore.getState().race.cars, codes, t, lap: f.lap }
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
    let sessionBannerId: string | null = null
    if (prev.phase === 'finished') push(chequeredBanner(prev, context()))

    return useStore.subscribe((s) => {
      for (const e of s.events) {
        if (seen.has(e)) continue
        seen.add(e)
        push(bannerForEvent(e, context()))
        if (e.type === 'session_finished') {
          const sid = e.session_id
          api.event().then((ev) => {
            const result = ev.results.find((r) => r.session_id === sid)
            if (!result) return
            const c = context()
            const info = useStore.getState().race.session
            const title = info?.name.trim() || c.t(`ev.kind.${result.kind}`)
            const banner = sessionResultBanner(result, title, c)
            const at = performance.now()
            // The session card replaces the plain chequered podium of the same race.
            setQueue((q) => dismiss(q, `chequered:${useStore.getState().race.race_id}`, at))
            sessionBannerId = banner.id
            setQueue((q) => enqueue(q, banner, at))
            setClock(at)
          }, () => undefined)
        }
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
        if (sessionBannerId) setQueue((q) => dismiss(q, sessionBannerId as string, at))
        sessionBannerId = null
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
