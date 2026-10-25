import { api } from './api'
import { useStore } from './store'

/** Reload the roster and the event state (assignments, armed driver) into the store. */
export async function refreshEventData(): Promise<void> {
  try {
    const [d, e] = await Promise.all([api.drivers(), api.event()])
    useStore.getState().setDrivers(d.drivers)
    useStore.getState().setEventState(e)
  } catch {
    // offline: keep what we have; the next focus or reconnect retries
  }
}
