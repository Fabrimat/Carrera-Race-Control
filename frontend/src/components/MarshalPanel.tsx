import { useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { guarded } from '../lib/errors'
import { formatElapsed, incidentPlace, openIncidents } from '../lib/incidents'
import { useStore } from '../lib/store'

/**
 * Marshal call: an overlay that appears while any car has an open incident (so it never
 * takes room from the 16:9 grid). One row per car with the place, the time off and a big
 * "Back on track" button.
 */
export function MarshalPanel() {
  const t = useT()
  const race = useStore((s) => s.race)
  const [busy, setBusy] = useState<number | null>(null)
  const open = openIncidents(race.cars)

  if (open.length === 0) return null

  const back = async (address: number) => {
    setBusy(address)
    await guarded(() => api.clearIncident(address))
    setBusy(null)
  }

  return (
    <section
      aria-label={t('incident.marshal_title')}
      data-testid="marshal-panel"
      className="absolute bottom-3 left-3 z-30 flex max-h-[60%] w-[26rem] max-w-[calc(100%-1.5rem)] flex-col gap-2 overflow-auto rounded-lg border-2 border-gold bg-panel p-3 shadow-2xl shadow-black/60"
    >
      <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-gold">
        <span aria-hidden className="inline-block h-3 w-3 rotate-45 bg-gold" />
        {t('incident.marshal_title')}
      </h2>
      {open.map((c) => {
        const inc = c.incident!
        const name = c.driver_name || c.name
        return (
          <div
            key={c.address}
            data-testid="marshal-row"
            data-addr={c.address}
            className="flex items-center gap-3 rounded-md border border-line bg-panel-2 p-2"
            style={{ borderLeft: `8px solid ${c.color}` }}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-bold leading-tight">{name}</div>
              <div className="truncate text-sm text-dim">{incidentPlace(inc, race.num_sectors, t)}</div>
              <div className="num text-sm text-gold" data-testid="marshal-elapsed">
                {t('incident.off_for', { time: formatElapsed(race.race_time_ms - inc.started_race_ms) })}
              </div>
            </div>
            <button
              type="button"
              data-testid="marshal-back"
              aria-label={t('incident.back_aria', { name })}
              disabled={busy === c.address}
              className="min-h-14 shrink-0 rounded-md bg-go px-4 text-lg font-black uppercase leading-tight text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
              onClick={() => void back(c.address)}
            >
              {t('incident.back')}
            </button>
          </div>
        )
      })}
    </section>
  )
}
