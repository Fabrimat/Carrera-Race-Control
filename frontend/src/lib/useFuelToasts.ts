import { useEffect } from 'react'
import { useT } from '../i18n/useT'
import { useStore } from './store'

/**
 * Toast for each `pit_missed` event (a mandatory stop was skipped; the penalty is already in the
 * order). Events present at mount are marked as seen, so opening the page never replays history.
 */
export function useFuelToasts() {
  const t = useT()
  useEffect(() => {
    const seen = new WeakSet<object>(useStore.getState().events)
    return useStore.subscribe((s) => {
      for (const e of s.events) {
        if (seen.has(e)) continue
        seen.add(e)
        if (e.type !== 'pit_missed') continue
        const car = s.race.cars.find((c) => c.address === e.address)
        s.pushToast(
          t('fuel.toast_pit_missed', {
            name: car ? car.driver_name || car.name : `#${e.address + 1}`,
            stops: e.stops,
            required: e.required,
            seconds: Math.round(e.penalty_ms / 1000),
          }),
          'info',
        )
      }
    })
  }, [t])
}
