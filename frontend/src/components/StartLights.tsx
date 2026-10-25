import { useT } from '../i18n/useT'

/**
 * CU start sequence (Status.start): 1 = prepare, 2..6 = lights 1..5 on,
 * 7 = go (green), 8/9 = false start, 0 = lights off.
 */
export function StartLights({ light, big = false }: { light: number; big?: boolean }) {
  const t = useT()
  const lit = light >= 2 && light <= 6 ? light - 1 : 0
  const go = light === 7
  const falseStart = light === 8 || light === 9
  const size = big ? 'h-20 w-20' : 'h-8 w-8'
  return (
    <div className="flex flex-col items-center gap-2" data-testid="start-lights" data-light={light}>
      <div className="flex gap-3 rounded-xl border border-line bg-black px-4 py-3">
        {[1, 2, 3, 4, 5].map((i) => {
          const on = go ? true : falseStart ? true : i <= lit
          const color = go ? 'bg-go shadow-[0_0_30px_#30d158]' : 'bg-signal shadow-[0_0_30px_#ff3b30]'
          return (
            <span
              key={i}
              className={`${size} rounded-full ${on ? color : 'bg-[#2a1210]'} ${
                falseStart ? 'animate-pulse' : ''
              }`}
            />
          )
        })}
      </div>
      <span className="text-sm uppercase tracking-widest text-dim">
        {falseStart
          ? t('lights.false_start')
          : go
            ? t('lights.go')
            : light === 1
              ? t('lights.prepare')
              : lit > 0
                ? t('lights.sequence')
                : ''}
      </span>
    </div>
  )
}
