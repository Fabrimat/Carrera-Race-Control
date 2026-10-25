import { lazy, Suspense } from 'react'
import { useT } from '../i18n/useT'
import type { Series } from '../lib/series'

const LapChart = lazy(() => import('./LapChart'))

export function LazyLapChart({ series, height }: { series: Series[]; height?: number }) {
  const t = useT()
  return (
    <Suspense fallback={<p className="p-6 text-dim">{t('common.loading')}</p>}>
      <LapChart series={series} height={height} />
    </Suspense>
  )
}
