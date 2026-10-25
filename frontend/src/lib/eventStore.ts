import { create } from 'zustand'
import { api } from './api'
import type { EventProgram, EventState, SessionResult, SessionSpec } from './types'

// Event-mode state owned by the program / session runner UI (separate from the live-state store
// so it never conflicts with the roster / assignment slice).

interface EventUi {
  event: EventState | null
  programs: EventProgram[]
  /** Result to show in the end-of-session modal; null when closed. */
  finished: SessionResult | null
  setEvent: (e: EventState) => void
  setPrograms: (p: EventProgram[]) => void
  showFinished: (r: SessionResult | null) => void
  refresh: () => Promise<void>
}

export const useEventUi = create<EventUi>((set) => ({
  event: null,
  programs: [],
  finished: null,
  setEvent: (event) => set({ event }),
  setPrograms: (programs) => set({ programs }),
  showFinished: (finished) => set({ finished }),
  refresh: async () => {
    const [event, programs] = await Promise.all([api.event(), api.programs()])
    set({ event, programs: programs.programs })
  },
}))

export function activeProgram(event: EventState | null, programs: EventProgram[]): EventProgram | null {
  if (!event?.program_id) return null
  return programs.find((p) => p.id === event.program_id) ?? null
}

export function currentSpec(event: EventState | null, programs: EventProgram[]): SessionSpec | null {
  return activeProgram(event, programs)?.sessions[event?.current_index ?? 0] ?? null
}

/** Classification of the session the current one takes its starting order from, if any. */
export function gridResult(event: EventState | null, spec: SessionSpec | null): SessionResult | null {
  if (!event || !spec?.grid_from) return null
  return event.results.find((r) => r.session_id === spec.grid_from) ?? null
}
