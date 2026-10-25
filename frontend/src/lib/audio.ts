import type { CommentaryLine } from './types'

const VOLUME_KEY = 'carrera.volume'

export function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    const v = Number(raw)
    if (raw !== null && Number.isFinite(v)) return Math.min(1, Math.max(0, v))
  } catch {
    /* storage unavailable */
  }
  return 0.8
}

export function saveVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(v))
  } catch {
    /* storage unavailable */
  }
}

interface Playing {
  id: string
  el: HTMLAudioElement
  src: MediaElementAudioSourceNode
}

/**
 * Plays commentary audio one line at a time:
 * HTMLAudioElement -> MediaElementSource -> GainNode -> destination.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private current: Playing | null = null
  private volume = loadVolume()
  private muted = false
  private listeners = new Set<() => void>()

  /** True while the AudioContext exists but the browser has not allowed audio yet. */
  get suspended(): boolean {
    return this.ctx !== null && this.ctx.state !== 'running'
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (typeof AudioContext === 'undefined') return null
    const ctx = new AudioContext()
    this.ctx = ctx
    this.gain = ctx.createGain()
    this.gain.gain.value = this.muted ? 0 : this.volume
    this.gain.connect(ctx.destination)
    ctx.addEventListener('statechange', () => this.emit())
    this.emit()
    return ctx
  }

  /** Call from a user gesture to satisfy the autoplay policy. */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext()
    if (ctx && ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch {
        /* still blocked */
      }
    }
    this.emit()
  }

  setVolume(v: number): void {
    this.volume = v
    if (this.gain && !this.muted) this.gain.gain.value = v
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume
    if (muted) this.stop()
  }

  play(line: CommentaryLine): void {
    if (!line.audio_url || this.muted) return
    const ctx = this.ensureContext()
    if (!ctx || !this.gain) return
    this.stop()
    const el = new Audio(line.audio_url)
    const src = ctx.createMediaElementSource(el)
    src.connect(this.gain)
    const cur: Playing = { id: line.id, el, src }
    this.current = cur
    const cleanup = () => {
      if (this.current === cur) this.current = null
      src.disconnect()
    }
    el.addEventListener('ended', cleanup)
    el.addEventListener('error', cleanup)
    void ctx
      .resume()
      .catch(() => undefined)
      .then(() => el.play())
      .catch(() => {
        // Autoplay blocked or stream failed: the hint tells the user to click.
        cleanup()
        this.emit()
      })
  }

  /** Stop the current line; when `id` is given only if it is that line. */
  stop(id?: string): void {
    const cur = this.current
    if (!cur || (id !== undefined && cur.id !== id)) return
    this.current = null
    cur.el.pause()
    cur.el.removeAttribute('src')
    cur.src.disconnect()
  }
}

export const audioPlayer = new AudioPlayer()
