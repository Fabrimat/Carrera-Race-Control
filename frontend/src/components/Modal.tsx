import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  label: string
  onClose: () => void
  children: ReactNode
  /** Tailwind max-width class of the panel. */
  width?: string
}

/** Minimal accessible dialog: Esc and a click on the backdrop close it; focus moves inside. */
export function Modal({ label, onClose, children, width = 'max-w-3xl' }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && !el.contains(document.activeElement)) el.focus()
  }, [])
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`flex max-h-full w-full ${width} flex-col overflow-y-auto rounded-xl border border-line bg-panel p-4 shadow-2xl outline-none`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        {children}
      </div>
    </div>
  )
}
