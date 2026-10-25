import { useEffect, useState } from 'react'
import { useFormat, useT } from '../i18n/useT'
import { api } from '../lib/api'
import { apiErrorMessage } from '../lib/errors'
import { formatDateTime } from '../lib/format'
import { LapChart, seriesFromLaps } from '../components/LapChart'
import { useStore } from '../lib/store'
import type { RaceDetail, RaceSummary } from '../lib/types'

type Loaded<T> = { data: T | null; error: string | null; loading: boolean }

function useLoad<T>(fn: () => Promise<T>, key: string | number): Loaded<T> {
  const t = useT()
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true })
  useEffect(() => {
    let live = true
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e) => live && setState({ data: null, error: apiErrorMessage(e, t), loading: false }),
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, t])
  return state
}

export function History() {
  const t = useT()
  const f = useFormat()
  const { data, error, loading } = useLoad(async () => (await api.races()).races, 'list')
  const rows: RaceSummary[] = data ?? []
  return (
    <div className="mx-auto max-w-[1100px] p-4">
      <h2 className="mb-4 text-2xl font-black uppercase tracking-widest">{t('history.title')}</h2>
      {loading && <p className="text-dim">{t('common.loading')}</p>}
      {error && <p role="alert" className="text-signal">{error}</p>}
      {!loading && !error && rows.length === 0 && <p className="text-dim">{t('history.empty')}</p>}
      {rows.length > 0 && (
        <table className="w-full text-left" data-testid="history-table">
          <thead className="text-xs uppercase tracking-widest text-dim">
            <tr>
              <th className="p-2">{t('history.date')}</th>
              <th className="p-2">{t('history.mode')}</th>
              <th className="p-2">{t('history.winner')}</th>
              <th className="p-2 text-right">{t('history.laps')}</th>
              <th className="p-2 text-right">{t('history.best')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line hover:bg-panel">
                <td className="p-2">
                  <a className="underline" href={`#/history/${r.id}`}>
                    {formatDateTime(r.started_at, f.lang)}
                  </a>
                </td>
                <td className="p-2">{t(`mode.${r.mode}`)}</td>
                <td className="p-2">{r.winner_name ?? '–'}</td>
                <td className="num p-2 text-right">{r.laps}</td>
                <td className="num p-2 text-right">{f.lap(r.best_lap_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function HistoryDetail({ id }: { id: number }) {
  const t = useT()
  const f = useFormat()
  const language = useStore((s) => s.language)
  const { data, error, loading } = useLoad<RaceDetail>(() => api.race(id), id)
  return (
    <div className="mx-auto max-w-[1100px] p-4">
      <a href="#/history" className="text-sm text-dim underline">← {t('history.back')}</a>
      {loading && <p className="mt-4 text-dim">{t('common.loading')}</p>}
      {error && <p role="alert" className="mt-4 text-signal">{error}</p>}
      {data && (
        <>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-black uppercase tracking-widest">
                {t('history.race_title', { id: data.id })}
              </h2>
              <p className="text-dim">
                {formatDateTime(data.started_at, language)} · {t(`mode.${data.mode}`)}
              </p>
            </div>
            <div className="flex gap-2">
              <a className="rounded-md bg-panel-2 px-4 py-2 font-bold" href={api.exportUrl(data.id, 'csv')} download>
                {t('history.export_csv')}
              </a>
              <a className="rounded-md bg-panel-2 px-4 py-2 font-bold" href={api.exportUrl(data.id, 'json')} download>
                {t('history.export_json')}
              </a>
            </div>
          </div>
          <table className="mt-4 w-full text-left" data-testid="results-table">
            <thead className="text-xs uppercase tracking-widest text-dim">
              <tr>
                <th className="p-2">{t('leaderboard.pos')}</th>
                <th className="p-2">{t('leaderboard.driver')}</th>
                <th className="p-2 text-right">{t('leaderboard.laps')}</th>
                <th className="p-2 text-right">{t('leaderboard.best')}</th>
                <th className="p-2 text-right">{t('history.avg')}</th>
                <th className="p-2 text-right">{t('history.pit_stops')}</th>
              </tr>
            </thead>
            <tbody>
              {data.results.map((c) => (
                <tr key={c.address} className="border-t border-line">
                  <td className="num p-2">{c.position ?? '–'}</td>
                  <td className="p-2">
                    <span className="mr-2 inline-block h-3 w-3 rounded-full" style={{ background: c.color }} />
                    {c.name}
                  </td>
                  <td className="num p-2 text-right">{c.laps}</td>
                  <td className="num p-2 text-right">{f.lap(c.best_lap_ms)}</td>
                  <td className="num p-2 text-right">{f.lap(c.avg_lap_ms)}</td>
                  <td className="num p-2 text-right">{c.pit_stops}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-widest text-dim">{t('chart.title')}</h3>
          <LapChart series={seriesFromLaps(data.laps, data.results)} />
        </>
      )}
    </div>
  )
}
