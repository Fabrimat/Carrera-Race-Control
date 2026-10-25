import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useFormat, useT } from '../i18n/useT'
import type { Series } from '../lib/series'

/** Recharts line chart. Lazy-loaded through LazyLapChart so recharts stays out of the main chunk. */
export default function LapChart({ series, height = 280 }: { series: Series[]; height?: number }) {
  const t = useT()
  const f = useFormat()
  const maxLap = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.lap)))
  const rows = Array.from({ length: maxLap }, (_, i) => {
    const row: Record<string, number> = { lap: i + 1 }
    for (const s of series) {
      const p = s.points.find((q) => q.lap === i + 1)
      if (p) row[`c${s.address}`] = p.ms
    }
    return row
  })
  if (maxLap === 0) {
    return <p className="p-6 text-dim">{t('chart.empty')}</p>
  }
  return (
    <div style={{ width: '100%', height }} data-testid="lap-chart">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="#2a323b" strokeDasharray="3 3" />
          <XAxis dataKey="lap" stroke="#8a96a3" label={{ value: t('chart.lap'), position: 'insideBottomRight', offset: -2, fill: '#8a96a3' }} />
          <YAxis
            stroke="#8a96a3"
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => f.lap(v)}
            width={64}
          />
          <Tooltip
            contentStyle={{ background: '#14181d', border: '1px solid #2a323b' }}
            formatter={(v) => f.lap(Number(v))}
            labelFormatter={(l) => `${t('chart.lap')} ${l}`}
          />
          <Legend />
          {series.map((s) => (
            <Line
              key={s.address}
              type="monotone"
              dataKey={`c${s.address}`}
              name={s.name}
              stroke={s.color}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
