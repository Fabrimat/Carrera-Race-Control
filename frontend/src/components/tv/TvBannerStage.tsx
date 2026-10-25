import { useEffect, useRef } from 'react'
import { useT } from '../../i18n/useT'
import type { Banner, BannerKind } from '../../lib/bannerQueue'
import type { BannerView } from './useBanners'

const GLYPH: Partial<Record<BannerKind, string>> = {
  fastest_lap: 'FL',
  overtake: '▲',
  pit_in: 'PIT',
  pit_out: 'PIT',
  low_fuel: '!',
  control: 'RC',
}

function LowerThird({ banner, exiting }: BannerView) {
  return (
    <div
      className="tv-banner"
      data-testid="tv-banner"
      data-kind={banner.kind}
      data-exiting={exiting}
      role="status"
      style={banner.color ? { ['--car' as string]: banner.color } : undefined}
    >
      <span className="tv-banner-tag" aria-hidden>{GLYPH[banner.kind]}</span>
      <span className="tv-banner-body">
        <span className="tv-banner-title">{banner.title}</span>
        {banner.subtitle && <span className="tv-banner-sub">{banner.subtitle}</span>}
      </span>
    </div>
  )
}

function Results({ banner }: { banner: Banner }) {
  const t = useT()
  return (
    <div className="tv-podium" data-testid="tv-results">
      {(banner.rows ?? []).map((r, i) => (
        <div key={r.pos} className="tv-podium-row" style={{ ['--car' as string]: r.color, ['--i' as string]: i }}>
          <span className="tv-pos">{r.pos}</span>
          <span className="tv-bar" aria-hidden />
          <span className="tv-code">{r.code}</span>
          <span className="tv-podium-name">{r.name}</span>
          <span className="tv-podium-best">
            <small>{t('tv.results.best')}</small>
            {r.best}
          </span>
        </div>
      ))}
    </div>
  )
}

function Card({ banner, exiting }: BannerView) {
  return (
    <div className="tv-card" data-testid="tv-card" data-kind={banner.kind} data-exiting={exiting} role="status">
      <div className="tv-card-title">{banner.title}</div>
      {banner.subtitle && <div className="tv-card-sub">{banner.subtitle}</div>}
      {banner.kind === 'chequered' && <Results banner={banner} />}
    </div>
  )
}

const PALETTE = ['#ffffff', '#ff3b30', '#ffd54a', '#c77dff', '#30d158']

/** Lightweight canvas confetti for the chequered flag. Cancelled on unmount. */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = (canvas.width = Math.floor(canvas.clientWidth * dpr) || 1)
    const h = (canvas.height = Math.floor(canvas.clientHeight * dpr) || 1)
    const parts = Array.from({ length: 140 }, (_, i) => ({
      x: Math.random() * w,
      y: -Math.random() * h * 0.6,
      vx: (Math.random() - 0.5) * 2 * dpr,
      vy: (2 + Math.random() * 4) * dpr,
      size: (6 + Math.random() * 8) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.25,
      color: PALETTE[i % PALETTE.length],
    }))
    let raf = 0
    const frame = () => {
      ctx.clearRect(0, 0, w, h)
      for (const p of parts) {
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vr
        if (p.y > h + p.size) {
          p.y = -p.size
          p.x = Math.random() * w
        }
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
        ctx.restore()
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} className="tv-confetti" data-testid="tv-confetti" aria-hidden />
}

/** Renders the banner currently on air: lower-third strips and centred cards. Never more than one. */
export function TvBannerStage({ view, reduced }: { view: BannerView | null; reduced: boolean }) {
  if (!view) return null
  const { banner } = view
  const chequered = banner.kind === 'chequered'
  return (
    <>
      {banner.layout === 'lower' ? (
        <div className="tv-lower">
          <LowerThird key={banner.id} {...view} />
        </div>
      ) : (
        <div className="tv-center">
          <Card key={banner.id} {...view} />
        </div>
      )}
      {chequered && !reduced && !view.exiting && (
        <>
          <div className="tv-wipe" data-testid="tv-wipe" key={`wipe-${banner.id}`} />
          <Confetti />
        </>
      )}
    </>
  )
}
