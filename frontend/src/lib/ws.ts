import { audioPlayer } from './audio'
import { playSfx } from './sfx'
import { sfxForMessage } from './sfxTriggers'
import { useStore } from './store'
import type { WsMessage } from './types'

const BACKOFF_MS = [1000, 2000, 4000, 10000]

/** Route a parsed server message into the store (and the audio player). */
export function dispatchMessage(msg: WsMessage): void {
  // Sound effects are decided against the state from before the message was applied.
  const sounds = sfxForMessage(useStore.getState().race, msg)
  useStore.getState().applyMessage(msg)
  sounds.forEach((n) => playSfx(n))
  switch (msg.type) {
    case 'snapshot':
      audioPlayer.setMuted(msg.data.muted)
      break
    case 'muted':
      audioPlayer.setMuted(msg.data.muted)
      break
    case 'commentary':
      if (!useStore.getState().muted) audioPlayer.play(msg.data)
      break
    case 'commentary_stop':
      audioPlayer.stop(msg.data.id)
      break
    default:
      break
  }
}

export class WsClient {
  private socket: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  start(): void {
    this.closed = false
    this.open()
  }

  stop(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    const s = this.socket
    this.socket = null
    s?.close()
  }

  private url(): string {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${window.location.host}/ws`
  }

  private open(): void {
    const { setWs } = useStore.getState()
    setWs('connecting')
    const ws = new WebSocket(this.url())
    this.socket = ws
    ws.onopen = () => {
      this.attempt = 0
      setWs('open')
    }
    ws.onmessage = (ev) => {
      try {
        dispatchMessage(JSON.parse(ev.data as string) as WsMessage)
      } catch {
        /* ignore malformed message */
      }
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      this.socket = null
      setWs('offline')
      if (this.closed) return
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
      this.attempt += 1
      this.timer = setTimeout(() => this.open(), delay)
    }
    ws.onerror = () => ws.close()
  }
}

export const wsClient = new WsClient()
