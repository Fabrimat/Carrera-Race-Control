import { useFormat, useT } from '../i18n/useT'
import { formatDateTime } from '../lib/format'
import { useStore } from '../lib/store'

/** The record of the current layout; flashes gold when a `track_record` event arrives. */
export function TrackRecordPanel() {
  const t = useT()
  const f = useFormat()
  const record = useStore((s) => s.race.track_record)
  const layout = useStore((s) => s.settings?.track.layout)
  // Re-keying on the latest track_record event restarts the one-shot CSS animation.
  const flashKey = useStore((s) => [...s.events].reverse().find((e) => e.type === 'track_record')?.at ?? '')
  return (
    <section
      key={flashKey}
      data-testid="track-record"
      aria-label={t('record.title')}
      className={`flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-gold/60 bg-panel p-3 ${flashKey ? 'record-flash' : ''}`}
    >
      <h2 className="text-sm font-bold uppercase tracking-widest text-gold">{t('record.title')}</h2>
      {record ? (
        <>
          <span className="num text-3xl font-bold text-gold" data-testid="track-record-time">
            {f.lap(record.lap_ms)}
          </span>
          <span>
            {t('record.holder', { name: record.holder_name, date: formatDateTime(record.set_at, f.lang) })}
          </span>
          <span className="text-sm text-dim">{t('record.layout', { layout: record.layout })}</span>
        </>
      ) : (
        <span className="text-dim">
          {t('record.none')}
          {layout ? ` (${t('record.layout', { layout })})` : ''}
        </span>
      )}
    </section>
  )
}
