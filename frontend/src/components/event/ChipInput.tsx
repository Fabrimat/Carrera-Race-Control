import { useState } from 'react'
import { useT } from '../../i18n/useT'
import { addChip } from '../../lib/program'

/** A list of short strings edited as chips: Enter (or the add button) adds, the x removes. */
export function ChipInput({
  label,
  values,
  max,
  onChange,
  testId,
}: {
  label: string
  values: string[]
  max: number
  onChange: (v: string[]) => void
  testId: string
}) {
  const t = useT()
  const [text, setText] = useState('')
  const add = () => {
    onChange(addChip(values, text, max))
    setText('')
  }
  return (
    <div className="flex flex-col gap-1 text-xs uppercase tracking-widest text-dim" data-testid={testId}>
      <span>{label}</span>
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-panel-2 p-2">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-track px-3 py-1 text-sm normal-case tracking-normal text-ink"
          >
            {v}
            <button
              type="button"
              className="text-dim hover:text-signal"
              aria-label={t('ev.chip_remove', { value: v })}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="min-w-32 flex-1 bg-transparent text-sm normal-case tracking-normal text-ink outline-none"
          value={text}
          disabled={values.length >= max}
          aria-label={label}
          placeholder={t('ev.chip_placeholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          className="rounded-md border border-line px-2 py-1 text-xs font-bold hover:border-amber disabled:opacity-35"
          disabled={!text.trim() || values.length >= max}
          onClick={add}
        >
          {t('ev.chip_add')}
        </button>
      </div>
    </div>
  )
}
