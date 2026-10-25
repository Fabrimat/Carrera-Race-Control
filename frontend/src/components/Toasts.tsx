import { useT } from '../i18n/useT'
import { useStore } from '../lib/store'

export function Toasts() {
  const t = useT()
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-w-md flex-col gap-2" aria-live="polite">
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-3 rounded-md border px-4 py-3 shadow-lg ${
            x.kind === 'error' ? 'border-signal bg-[#2a1210]' : 'border-line bg-panel-2'
          }`}
        >
          <span className="flex-1">{x.message}</span>
          <button className="text-dim" aria-label={t('common.dismiss')} onClick={() => dismiss(x.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
