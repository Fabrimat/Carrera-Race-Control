import { lazy, Suspense } from 'react'
import { useT } from '../i18n/useT'
import type { CarState } from '../lib/types'

const FuelChart = lazy(() => import('./FuelChart'))

export function LazyFuelChart({ cars, height }: { cars: CarState[]; height?: number | string }) {
  const t = useT()
  return (
    <Suspense fallback={<p className="p-6 text-dim">{t('common.loading')}</p>}>
      <FuelChart cars={cars} height={height} />
    </Suspense>
  )
}
