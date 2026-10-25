import { useSyncExternalStore } from 'react'
import { useT } from '../i18n/useT'
import { audioPlayer } from '../lib/audio'

/** Small hint shown while the browser has the AudioContext suspended (autoplay policy). */
export function AudioHint() {
  const t = useT()
  const suspended = useSyncExternalStore(
    (cb) => audioPlayer.subscribe(cb),
    () => audioPlayer.suspended,
  )
  if (!suspended) return null
  return (
    <button
      className="rounded-md border border-amber px-3 py-1 text-sm text-amber"
      onClick={() => void audioPlayer.unlock()}
    >
      {t('audio.enable')}
    </button>
  )
}
