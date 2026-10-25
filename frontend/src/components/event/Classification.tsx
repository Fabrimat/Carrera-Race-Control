import { useT } from '../../i18n/useT'
import { useFormat } from '../../i18n/useT'
import type { ClassificationRow, SessionKind } from '../../lib/types'

/** Session classification: position, driver, laps, best lap and penalty. */
export function Classification({ rows, kind }: { rows: ClassificationRow[]; kind: SessionKind }) {
  const t = useT()
  const f = useFormat()
  const hasPenalty = rows.some((r) => r.penalty_ms > 0)
  return (
    <table className="w-full text-left" data-testid="classification">
      <thead className="text-xs uppercase tracking-widest text-dim">
        <tr>
          <th className="py-1 pr-2">{t('ev.pos')}</th>
          <th className="py-1 pr-2">{t('ev.driver')}</th>
          <th className="py-1 pr-2 text-right">{t('leaderboard.laps')}</th>
          <th className="py-1 pr-2 text-right">{t('tv.results.best')}</th>
          {hasPenalty && <th className="py-1 text-right">{t('ev.penalty')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.address} className="border-t border-line">
            <td className="py-1 pr-2 font-black num">{kind === 'qualifying' && r.position === 1 ? 'P1 ★' : r.position}</td>
            <td className="py-1 pr-2">{r.name}</td>
            <td className="py-1 pr-2 text-right num">{r.laps}</td>
            <td className="py-1 pr-2 text-right num">{f.lap(r.best_lap_ms)}</td>
            {hasPenalty && (
              <td className="py-1 text-right num text-signal">{r.penalty_ms > 0 ? `+${r.penalty_ms / 1000}s` : ''}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
