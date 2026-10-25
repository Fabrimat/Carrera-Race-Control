import { useEffect, useState } from 'react'
import { useFormat, useT } from '../../i18n/useT'
import { useStore } from '../../lib/store'
import type { CommentaryLine, RaceState } from '../../lib/types'

const GO_HOLD_MS = 1800

/**
 * Big centred start-lights gantry. CU sequence (Status.start): 1 = prepare, 2..6 = lights 1..5,
 * 7 = go, 8/9 = false start. The GO wipe is held a moment after the lights go out.
 */
export function TvStartLights({ race }: { race: RaceState }) {
  const t = useT()
  const [holdGo, setHoldGo] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = useStore.subscribe((s, p) => {
      const now = s.race
      const before = p.race
      const goNow =
        (now.start_light === 7 && before.start_light !== 7) ||
        (before.phase === 'starting' && now.phase === 'running' && before.start_light !== 7)
      if (!goNow) return
      setHoldGo(true)
      clearTimeout(timer)
      timer = setTimeout(() => setHoldGo(false), GO_HOLD_MS)
    })
    return () => {
      unsub()
      clearTimeout(timer)
    }
  }, [])

  const light = race.start_light
  const go = holdGo || light === 7
  const falseStart = light === 8 || light === 9
  const visible = go || falseStart || (race.phase === 'starting' && light > 0)
  if (!visible) return null
  const lit = light >= 2 && light <= 6 ? light - 1 : 0
  return (
    <div className="tv-lights" data-testid="tv-lights" data-go={go} data-false={falseStart} role="status">
      <div className="tv-lights-gantry">
        {!go && (
          <div className="tv-lights-row">
            {[1, 2, 3, 4, 5].map((i) => (
              <span key={i} className="tv-lamp" data-on={falseStart || i <= lit} />
            ))}
          </div>
        )}
        <div className="tv-lights-label" data-testid="tv-lights-label">
          {go ? t('tv.go') : falseStart ? t('tv.false_start') : light === 1 ? t('lights.prepare') : ''}
        </div>
      </div>
    </div>
  )
}

/** Idle screen: animated, logo-free, with the track record when there is one. */
export function TvStandby({ race }: { race: RaceState }) {
  const t = useT()
  const f = useFormat()
  const record = race.track_record
  return (
    <div className="tv-standby" data-testid="tv-standby">
      <div className="tv-standby-inner">
        <div className="tv-standby-title">{t('tv.standby.title')}</div>
        <div className="tv-standby-sub">{t('tv.standby.sub')}</div>
        <div className="tv-standby-record">
          {record ? (
            <>
              <span>{t('tv.standby.record')}</span>
              <b>{f.lap(record.lap_ms)}</b>
              <span>{record.holder_name}</span>
            </>
          ) : (
            <span>{t('tv.standby.no_record')}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Typewriter reveal of `text`; instant when motion is reduced. Restarts when the text changes. */
export function useTypewriter(text: string, reduced: boolean, stepMs = 26): string {
  const [shown, setShown] = useState({ text, n: 0 })
  // Reset while rendering (React's "adjust state on prop change" pattern), not in an effect.
  const n = shown.text === text ? shown.n : 0
  if (shown.text !== text) setShown({ text, n: 0 })
  useEffect(() => {
    if (reduced || n >= text.length) return
    const id = setTimeout(() => setShown({ text, n: n + 2 }), stepMs)
    return () => clearTimeout(id)
  }, [n, text, reduced, stepMs])
  return reduced ? text : text.slice(0, n)
}

/** Latest commentary line as a lower-third caption; hidden while the commentator is muted. */
export function TvCaption({ line, muted, reduced }: { line: CommentaryLine | null; muted: boolean; reduced: boolean }) {
  const t = useT()
  const text = useTypewriter(line?.text ?? '', reduced)
  if (!line || muted) return null
  return (
    <div className="tv-caption" data-testid="tv-commentary">
      <span className="tv-caption-tag">{t('tv.caption')}</span>
      <span key={line.id} className="tv-caption-text" data-priority={line.priority} aria-label={line.text}>
        {text}
      </span>
    </div>
  )
}
