import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { TrackMap } from '../components/TrackMap'
import { TvBannerStage } from '../components/tv/TvBannerStage'
import { TvCaption, TvStandby, TvStartLights } from '../components/tv/TvOverlays'
import { Roll, TvTower } from '../components/tv/TvTower'
import { useBanners } from '../components/tv/useBanners'
import { useT } from '../i18n/useT'
import { deriveDriverCodes } from '../lib/driverCodes'
import { formatClock } from '../lib/format'
import { loadEffects, saveEffects, useReducedMotion } from '../lib/motion'
import { useStore } from '../lib/store'
import { useGapMode } from '../lib/tvTiming'
import type { RaceState } from '../lib/types'
import './tv.css'

function leaderLap(race: RaceState): number {
  const leader = race.cars.find((c) => c.position === 1)
  const lap = (leader?.laps ?? 0) + 1
  return race.config.mode === 'laps' ? Math.min(lap, race.config.target_laps) : lap
}

/** Centre of the top bar: lap counter and the race / countdown clock. */
function TopCentre({ race }: { race: RaceState }) {
  const t = useT()
  const live = race.phase !== 'idle'
  const timed = race.config.mode === 'timed' && race.remaining_ms !== null
  const lapText = !live
    ? '–'
    : race.config.mode === 'laps'
      ? t('tv.lap', { lap: leaderLap(race), total: race.config.target_laps })
      : t('tv.lap_free', { lap: leaderLap(race) })
  return (
    <div className="tv-centre">
      <div className="tv-lap" data-testid="tv-lap">
        <Roll text={lapText} />
      </div>
      <div className="tv-clock" data-testid="tv-clock">
        <small>{timed ? t('tv.timed_left') : t('tv.elapsed')}</small>
        {formatClock(timed ? race.remaining_ms : race.race_time_ms)}
      </div>
    </div>
  )
}

/** Time without input after which the on-screen controls fade out. */
export const CONTROLS_HIDE_MS = 3000

/** True after mouse / key / focus activity; false after CONTROLS_HIDE_MS of calm, never while focus is inside `guard`. */
function useActivity(guard: RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(true)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (guard.current?.contains(document.activeElement)) arm()
        else setActive(false)
      }, CONTROLS_HIDE_MS)
    }
    const wake = () => {
      setActive(true)
      arm()
    }
    const events = ['mousemove', 'pointerdown', 'keydown', 'focusin'] as const
    events.forEach((e) => window.addEventListener(e, wake))
    arm()
    return () => {
      events.forEach((e) => window.removeEventListener(e, wake))
      clearTimeout(timer)
    }
  }, [guard])
  return active
}

export function TvMode() {
  const t = useT()
  const race = useStore((s) => s.race)
  const muted = useStore((s) => s.muted)
  const lines = useStore((s) => s.commentary)
  const settingsCars = useStore((s) => s.settings?.cars)
  const latest = lines.length ? lines[lines.length - 1] : null
  const reduced = useReducedMotion()
  const [effects, setEffects] = useState(loadEffects)
  const mode = useGapMode()
  const controlsRef = useRef<HTMLDivElement>(null)
  const active = useActivity(controlsRef)

  // Codes depend on names only, so they stay stable for the whole race.
  const codes = useMemo(
    () =>
      deriveDriverCodes(
        race.cars.map((c) => ({
          address: c.address,
          name: c.name,
          nickname: settingsCars?.find((s) => s.address === c.address)?.nickname ?? null,
        })),
      ),
    [race.cars, settingsCars],
  )
  const banner = useBanners(codes)

  const fullscreen = () => {
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
  }
  const toggleEffects = () => {
    saveEffects(!effects)
    setEffects(!effects)
  }
  const idle = race.phase === 'idle'

  return (
    <div className="tv-root" data-testid="tv-mode" data-motion={reduced ? 'reduced' : 'full'} data-phase={race.phase} data-active={active}>
      <header className="tv-top">
        <div className="tv-top-left">
          <span className="tv-live"><i />{t('tv.live')}</span>
          <span className="tv-mode">{t(`mode.${race.config.mode}`)}</span>
          {race.session && (
            <span className="tv-session" data-testid="tv-session">
              {t('ev.tv_session', {
                name: race.session.name.trim() || t(`ev.kind.${race.session.kind}`),
                n: race.session.index + 1,
                total: race.session.total,
              })}
            </span>
          )}
        </div>
        <TopCentre race={race} />
        <div className="tv-top-right">
          <div className="tv-controls" ref={controlsRef} data-active={active} data-testid="tv-controls">
            <button className="tv-btn" aria-pressed={effects} onClick={toggleEffects} data-testid="tv-effects">
              {t('tv.effects')}
            </button>
            <button className="tv-btn" onClick={fullscreen}>{t('tv.fullscreen')}</button>
            <a className="tv-btn" href="#/">{t('tv.exit')}</a>
          </div>
          <span className="tv-phase" data-phase={race.phase} data-testid="tv-phase">{t(`phase.${race.phase}`)}</span>
        </div>
      </header>

      <main className="tv-main">
        <TvTower race={race} codes={codes} mode={mode} reduced={reduced} />
        <div className="tv-map" aria-label={t('tv.map')}>
          <TrackMap />
        </div>
      </main>

      {idle && <TvStandby race={race} />}
      <TvBannerStage view={banner} reduced={reduced} />
      <TvCaption line={idle ? null : latest} muted={muted} reduced={reduced} />
      <TvStartLights race={race} />
      {effects && <div className="tv-fx" data-testid="tv-fx" aria-hidden />}
    </div>
  )
}
