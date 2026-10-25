import { audioPlayer } from './audio'
import type { SfxName } from './sfxTriggers'
import { useStore } from './store'

// Synthesised sound effects (Web Audio API, no audio files). They share the AudioContext of the
// commentary player but run through their own gain node, so the two volumes stay independent.

const PREFS_KEY = 'carrera.sfx'
const DUCK = 0.35 // effects gain factor while a commentary line is being spoken

export interface SfxPrefs {
  enabled: boolean
  volume: number
}

export function loadSfxPrefs(): SfxPrefs {
  const prefs: SfxPrefs = { enabled: true, volume: 0.5 }
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const j = JSON.parse(raw) as Partial<SfxPrefs>
      if (typeof j.enabled === 'boolean') prefs.enabled = j.enabled
      if (typeof j.volume === 'number' && Number.isFinite(j.volume)) {
        prefs.volume = Math.min(1, Math.max(0, j.volume))
      }
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return prefs
}

function savePrefs(p: SfxPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable */
  }
}

let prefs = loadSfxPrefs()
let master: GainNode | null = null
let masterCtx: AudioContext | null = null

export function getSfxPrefs(): SfxPrefs {
  return prefs
}

export function setSfxEnabled(enabled: boolean): void {
  prefs = { ...prefs, enabled }
  savePrefs(prefs)
}

export function setSfxVolume(volume: number): void {
  prefs = { ...prefs, volume }
  savePrefs(prefs)
}

interface Note {
  freq: number
  at: number // seconds after the sound starts
  dur: number
  type?: OscillatorType
  peak?: number
}

const SOUNDS: Record<SfxName, Note[]> = {
  light: [{ freq: 520, at: 0, dur: 0.14, type: 'square', peak: 0.18 }],
  go: [{ freq: 1040, at: 0, dur: 0.4, type: 'square', peak: 0.2 }],
  best_lap: [
    { freq: 880, at: 0, dur: 0.18, type: 'sine' },
    { freq: 1320, at: 0.12, dur: 0.45, type: 'sine' },
  ],
  track_record: [
    { freq: 523.25, at: 0, dur: 0.16, type: 'triangle' },
    { freq: 659.25, at: 0.14, dur: 0.16, type: 'triangle' },
    { freq: 783.99, at: 0.28, dur: 0.16, type: 'triangle' },
    { freq: 1046.5, at: 0.42, dur: 0.7, type: 'triangle' },
    { freq: 523.25, at: 0.42, dur: 0.7, type: 'sine', peak: 0.12 },
    { freq: 783.99, at: 0.42, dur: 0.7, type: 'sine', peak: 0.12 },
  ],
  finish: [
    { freq: 392, at: 0, dur: 0.15, type: 'triangle' },
    { freq: 523.25, at: 0.15, dur: 0.15, type: 'triangle' },
    { freq: 659.25, at: 0.3, dur: 0.15, type: 'triangle' },
    { freq: 783.99, at: 0.45, dur: 0.5, type: 'triangle' },
  ],
  pit: [{ freq: 300, at: 0, dur: 0.06, type: 'sine', peak: 0.12 }],
}

function masterGain(ctx: AudioContext): GainNode {
  if (!master || masterCtx !== ctx) {
    master = ctx.createGain()
    master.connect(ctx.destination)
    masterCtx = ctx
  }
  return master
}

/** Play a named effect. No-op when disabled, globally muted, or audio is not unlocked yet. */
export function playSfx(name: SfxName): void {
  if (!prefs.enabled || prefs.volume <= 0 || useStore.getState().muted) return
  const ctx = audioPlayer.context()
  // Skip while the browser still blocks audio: queued sounds would otherwise burst out later.
  if (!ctx || ctx.state !== 'running') return
  const out = masterGain(ctx)
  out.gain.value = prefs.volume * (audioPlayer.speaking ? DUCK : 1)
  const t0 = ctx.currentTime
  for (const n of SOUNDS[name]) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = n.type ?? 'sine'
    osc.frequency.value = n.freq
    const start = t0 + n.at
    const peak = n.peak ?? 0.22
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(peak, start + 0.01)
    env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)
    osc.connect(env)
    env.connect(out)
    osc.start(start)
    osc.stop(start + n.dur + 0.02)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
  }
}
