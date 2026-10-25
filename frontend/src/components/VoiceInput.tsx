import { useEffect, useRef, useState } from 'react'
import { useLanguage, useT } from '../i18n/useT'
import { api } from '../lib/api'
import { guarded } from '../lib/errors'
import { useStore } from '../lib/store'
import { bareMime, blobToBase64, MAX_RECORD_S, pickMime } from '../lib/voice'

type Phase = 'idle' | 'recording' | 'transcribing'

/** Mic button: records up to 10 s, sends it to the backend and reports the text and the guess. */
export function VoiceInput({ onTranscript }: { onTranscript: (text: string, nameGuess: string | null) => void }) {
  const t = useT()
  const language = useLanguage()
  const [phase, setPhase] = useState<Phase>('idle')
  const [left, setLeft] = useState(MAX_RECORD_S)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const alive = useRef(true)

  const release = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((tr) => tr.stop())
    stream.current = null
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (recorder.current && recorder.current.state !== 'inactive') {
        recorder.current.onstop = null
        recorder.current.stop()
      }
      release()
    }
  }, [])

  const stop = () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
  }

  const start = async () => {
    const mime = pickMime()
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      useStore.getState().pushToast(t('voice.unsupported'))
      return
    }
    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      useStore.getState().pushToast(t('voice.mic_error'))
      return
    }
    if (!alive.current) {
      media.getTracks().forEach((tr) => tr.stop())
      return
    }
    stream.current = media
    const chunks: Blob[] = []
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(media, { mimeType: mime })
    } catch {
      release()
      useStore.getState().pushToast(t('voice.unsupported'))
      return
    }
    recorder.current = rec
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = async () => {
      release()
      if (!alive.current) return
      setPhase('transcribing')
      const blob = new Blob(chunks, { type: mime })
      const res = await guarded(async () =>
        api.transcribe({
          audio_base64: await blobToBase64(blob),
          media_type: bareMime(mime),
          language,
        }),
      )
      if (!alive.current) return
      setPhase('idle')
      if (res) onTranscript(res.text, res.name_guess || null)
    }
    setLeft(MAX_RECORD_S)
    setPhase('recording')
    try {
      rec.start()
    } catch {
      release()
      setPhase('idle')
      useStore.getState().pushToast(t('voice.unsupported'))
      return
    }
    const began = Date.now()
    timer.current = setInterval(() => {
      const remaining = MAX_RECORD_S - Math.floor((Date.now() - began) / 1000)
      setLeft(Math.max(0, remaining))
      if (remaining <= 0) stop()
    }, 250)
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="voice-button"
        disabled={phase === 'transcribing'}
        aria-pressed={phase === 'recording'}
        className={`min-h-12 rounded-md border px-4 py-2 text-base font-bold uppercase tracking-wide ${
          phase === 'recording' ? 'border-signal bg-signal text-white' : 'border-line bg-panel-2 hover:border-amber'
        } disabled:opacity-50`}
        onClick={() => (phase === 'recording' ? stop() : void start())}
      >
        {phase === 'recording'
          ? `■ ${t('voice.recording', { seconds: left })}`
          : phase === 'transcribing'
            ? t('voice.transcribing')
            : `● ${t('voice.mic')}`}
      </button>
      <p className="text-xs text-dim">{t('voice.privacy')}</p>
    </div>
  )
}
