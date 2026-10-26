import type { MouseEvent } from 'react'
import { useT } from '../../i18n/useT'
import type { CalibrationPair } from '../../lib/camera/calibration'
import type { PathModel } from '../../lib/camera/projection'
import { nearestS, pointAt, tangentAt, type Pt } from '../../lib/geometry'

interface Props {
  path: PathModel
  aspect: number
  pairs: CalibrationPair[]
  /** Waiting for the layout half of a pair. */
  active: boolean
  /** A point of the path, in normalised layout coordinates (x / aspect, y). */
  onPick: (p: Pt) => void
}

const PAD = 0.08

/** The current layout; a click picks the nearest point of the track line. */
export function LayoutPointMap({ path, aspect, pairs, active, onPick }: Props) {
  const t = useT()
  const d = path.points.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + ' Z'
  const [sx, sy] = pointAt(path.points, 0, path.cum)
  const [tx, ty] = tangentAt(path.points, 0, path.cum)

  const pick = (p: Pt) => {
    const s = nearestS(path.points, p, path.cum)
    const q = pointAt(path.points, s, path.cum)
    onPick([q[0] / aspect, q[1]])
  }

  const click = (e: MouseEvent<SVGSVGElement>) => {
    if (!active) return
    const svg = e.currentTarget
    const ctm = svg.getScreenCTM?.()
    if (ctm && typeof svg.createSVGPoint === 'function') {
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const q = pt.matrixTransform(ctm.inverse())
      pick([q.x, q.y])
      return
    }
    // Fallback (no SVG geometry): proportional mapping of the bounding box.
    const r = svg.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    pick([-PAD + ((e.clientX - r.left) / r.width) * (aspect + 2 * PAD), -PAD + ((e.clientY - r.top) / r.height) * (1 + 2 * PAD)])
  }

  return (
    <svg
      viewBox={`${-PAD} ${-PAD} ${aspect + 2 * PAD} ${1 + 2 * PAD}`}
      className={`w-full rounded-md border bg-track ${active ? 'cursor-crosshair border-go' : 'border-line'}`}
      role="img"
      aria-label={t('camera.layout_map')}
      data-testid="camera-layout-map"
      data-active={active ? 'true' : 'false'}
      onClick={click}
    >
      <path d={d} fill="none" stroke="#2a323b" strokeWidth={0.05} strokeLinejoin="round" />
      <path d={d} fill="none" stroke="#3b4652" strokeWidth={0.004} strokeDasharray="0.02 0.02" />
      <line
        x1={sx - ty * 0.04}
        y1={sy + tx * 0.04}
        x2={sx + ty * 0.04}
        y2={sy - tx * 0.04}
        stroke="#e8ecef"
        strokeWidth={0.012}
        strokeDasharray="0.012 0.012"
      />
      {pairs.map((p, i) => (
        <g key={i} transform={`translate(${p.layout[0] * aspect} ${p.layout[1]})`} data-testid="camera-layout-point">
          <circle r={0.03} fill={i === 0 ? '#e8ecef' : '#ffb000'} stroke="#000" strokeWidth={0.006} />
          <text fontSize={0.034} fontWeight={800} textAnchor="middle" dominantBaseline="central" fill="#000">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  )
}
