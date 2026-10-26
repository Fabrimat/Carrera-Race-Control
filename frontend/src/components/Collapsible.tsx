import { useState, type ReactNode } from 'react'
import { useT } from '../i18n/useT'
import { isTouchLayout, useLayout } from '../lib/layout'

/**
 * Collapsible panel for touch layouts (phones and tablets): a 44 px header button shows or
 * hides the content. On desktop, ultrawide and 4K layouts it renders the children untouched.
 */
export function Collapsible({
  title,
  defaultOpen = true,
  testId,
  children,
}: {
  title: string
  defaultOpen?: boolean
  testId?: string
  children: ReactNode
}) {
  const t = useT()
  const layout = useLayout()
  const [open, setOpen] = useState(defaultOpen)
  if (!isTouchLayout(layout)) return <>{children}</>
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={t(open ? 'layout.collapse' : 'layout.expand', { title })}
        className="flex min-h-11 w-full items-center justify-between rounded-lg border border-line bg-panel px-3 text-left text-sm font-bold uppercase tracking-widest text-dim hover:text-ink"
        onClick={() => setOpen(!open)}
      >
        <span>{title}</span>
        <span aria-hidden className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          ▸
        </span>
      </button>
      {open && children}
    </div>
  )
}
