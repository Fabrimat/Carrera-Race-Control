import { api } from './api'
import { audioPlayer, loadVolume, saveVolume } from './audio'
import { openTvWindow } from './desktop'
import { guarded } from './errors'
import { adjustRaceAmount, cycleRaceMode, isRaceActive, startRace } from './raceActions'
import { saveSettings } from './settingsSave'
import { getSfxPrefs, setSfxEnabled } from './sfx'
import { useStore, tNow } from './store'

// Handlers of the keyboard shortcut actions. They reuse the same API calls and store actions as
// the buttons they mirror, and respect the same enabled / disabled conditions.

/** Fired on `window` after a shortcut changed a locally stored preference (volume, effects). */
export const PREFS_EVENT = 'carrera:prefs'

/**
 * Fired on `window` by the scan shortcut. The connection bar answers by setting `detail.handled`
 * and scanning into its own device list; without one (other pages) the action scans by itself.
 */
export const SCAN_EVENT = 'carrera:scan'

const VOLUME_STEP = 0.1

const unlock = () => void audioPlayer.unlock()

function go(hash: string): void {
  window.location.hash = hash
}

/** Move focus along the leaderboard rows' name controls (so F2 renames the focused car). */
export function focusCar(direction: 1 | -1): void {
  const controls = [...document.querySelectorAll<HTMLElement>('[data-testid="leaderboard-row"] [data-testid="rename-button"]')]
  if (controls.length === 0) return
  const active = document.activeElement
  const at = controls.findIndex((c) => c === active || c.contains(active))
  const next =
    at === -1
      ? direction === 1
        ? 0
        : controls.length - 1
      : (at + direction + controls.length) % controls.length
  controls[next].focus()
}

async function connect(): Promise<void> {
  const s = useStore.getState()
  const conn = s.connection
  if (conn.status === 'connected' || conn.status === 'connecting') return
  const mode = s.settings?.track.mode ?? conn.mode
  const address = mode === 'simulator' ? null : (s.settings?.track.address ?? conn.address)
  if (mode !== 'simulator' && !address) return
  unlock()
  const res = await guarded(() => api.connect(mode, address))
  if (res) useStore.getState().setConnection(res)
}

async function disconnect(): Promise<void> {
  if (useStore.getState().connection.status !== 'connected') return
  const res = await guarded(() => api.disconnect())
  if (res) useStore.getState().setConnection(res)
}

async function scan(): Promise<void> {
  const detail = { handled: false }
  window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail }))
  if (detail.handled) return
  const s = useStore.getState()
  if (s.connection.status === 'connected' || s.connection.status === 'connecting') return
  if ((s.settings?.track.mode ?? s.connection.mode) === 'simulator') return
  const res = await guarded(() => api.scan())
  if (!res) return
  s.pushToast(tNow('shortcuts.scan_result', { count: res.devices.length }), 'info')
}

async function toggleMute(): Promise<void> {
  unlock()
  const res = await guarded(() => api.mute(!useStore.getState().muted))
  if (res) {
    useStore.getState().setMuted(res.muted)
    audioPlayer.setMuted(res.muted)
  }
}

function changeVolume(direction: 1 | -1): void {
  const v = Math.min(1, Math.max(0, Math.round((loadVolume() + direction * VOLUME_STEP) * 100) / 100))
  audioPlayer.setVolume(v)
  saveVolume(v)
  window.dispatchEvent(new Event(PREFS_EVENT))
}

function toggleEffects(): void {
  unlock()
  setSfxEnabled(!getSfxPrefs().enabled)
  window.dispatchEvent(new Event(PREFS_EVENT))
}

async function toggleLlm(): Promise<void> {
  await guarded(() =>
    saveSettings((s) => ({ ...s, commentary: { ...s.commentary, llm_enabled: !s.commentary.llm_enabled } })),
  )
}

function repeatLastLine(): void {
  const { commentary, muted } = useStore.getState()
  const line = [...commentary].reverse().find((l) => l.audio_url)
  if (!line || muted) return
  unlock()
  audioPlayer.play(line)
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    /* fullscreen refused (not allowed in this context): nothing to do */
  }
}

function openTv(): void {
  if (window.carreraDesktop?.isDesktop) openTvWindow()
  else go('#/tv')
}

const RUN: Record<string, () => void | Promise<void>> = {
  'race.start': () => {
    const race = useStore.getState().race
    if (isRaceActive(race)) return
    unlock()
    return guarded(() => startRace()).then(() => undefined)
  },
  'race.stop': () => {
    if (!isRaceActive(useStore.getState().race)) return
    return guarded(() => api.stopRace()).then(() => undefined)
  },
  'race.reset': () => guarded(() => api.resetRace()).then(() => undefined),
  'race.pace_car': () => {
    const phase = useStore.getState().race.phase
    if (phase !== 'running' && phase !== 'paused') return
    return guarded(() => api.paceCar()).then(() => undefined)
  },
  'race.mode': cycleRaceMode,
  'race.amount_up': () => adjustRaceAmount(1),
  'race.amount_down': () => adjustRaceAmount(-1),
  'conn.connect': connect,
  'conn.disconnect': disconnect,
  'conn.scan': scan,
  'commentary.mute': toggleMute,
  'commentary.volume_up': () => changeVolume(1),
  'commentary.volume_down': () => changeVolume(-1),
  'commentary.effects': toggleEffects,
  'commentary.llm': toggleLlm,
  'commentary.repeat': repeatLastLine,
  'nav.dashboard': () => go('#/'),
  'nav.history': () => go('#/history'),
  'nav.event': () => go('#/event'),
  'nav.drivers': () => go('#/drivers'),
  'nav.track': () => go('#/track'),
  'nav.settings': () => go('#/settings'),
  'nav.tv': openTv,
  'view.fullscreen': toggleFullscreen,
  'cars.next': () => focusCar(1),
  'cars.prev': () => focusCar(-1),
  'help.toggle': () => useStore.getState().setHelpOpen(!useStore.getState().helpOpen),
}

/** Run an action by id; unknown ids do nothing. */
export function runShortcutAction(id: string): void | Promise<void> {
  return RUN[id]?.()
}
