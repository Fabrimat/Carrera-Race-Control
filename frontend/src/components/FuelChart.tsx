import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useT } from '../i18n/useT'
import type { CarState } from '../lib/types'

/** Rows for the chart: lap n holds each car's fuel level at the end of that lap (fuel_laps[n - 1]). */
export function fuelRows(cars: CarState[]): Record<string, number>[] {
  const maxLap = Math.max(0, ...cars.map((c) => c.fuel_laps.length))
  return Array.from({ length: maxLap }, (_, i) => {
    const row: Record<string, number> = { lap: i + 1 }
    for (const c of cars) {
      const level = c.fuel_laps[i]
      if (level !== null && level !== undefined) row[`c${c.address}`] = level
    }
    return row
  })
}

/** Fuel level over laps, one line per car. Lazy-loaded through LazyFuelChart (recharts chunk). */
export default function FuelChart({ cars, height = 280 }: { cars: CarState[]; height?: number | string }) {
  const t = useT()
  const rows = fuelRows(cars)
  if (rows.length === 0) return <p className="p-6 text-dim">{t('fuel.chart.empty')}</p>
  return (
    <div style={{ width: '100%', height }} data-testid="fuel-chart">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#2a323b" strokeDasharray="3 3" />
          <XAxis dataKey="lap" stroke="#8a96a3" label={{ value: t('chart.lap'), position: 'insideBottomRight', offset: -2, fill: '#8a96a3' }} />
          <YAxis stroke="#8a96a3" domain={[0, 15]} ticks={[0, 3, 6, 9, 12, 15]} width={32} />
          <Tooltip
            contentStyle={{ background: '#14181d', border: '1px solid #2a323b' }}
            labelFormatter={(l) => `${t('chart.lap')} ${l}`}
            formatter={(v) => `${v}/15`}
          />
          <Legend />
          {cars.map((c) => (
            <Line
              key={c.address}
              type="stepAfter"
              dataKey={`c${c.address}`}
              name={c.driver_name || c.name}
              stroke={c.color}
              strokeWidth={2.5}
              dot={{ r: 2.5 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
