import { useId, useState, type ChangeEvent } from 'react'
import { useT } from '../../i18n/useT'
import { api } from '../../lib/api'
import { prepareImage, type PreparedPhoto } from '../../lib/photo'
import { photoErrorMessage } from '../../lib/trackErrors'
import type { Language, LayoutDraft } from '../../lib/types'

interface Props {
  name: string
  language: Language
  onDraft: (draft: LayoutDraft, photo: PreparedPhoto) => void
}

type Phase = 'idle' | 'preparing' | 'analysing'

/** Photo -> draft layout. The privacy notice is always visible, before any upload. */
export function PhotoImport({ name, language, onDraft }: Props) {
  const t = useT()
  const id = useId()
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow picking the same photo again
    if (!file) return
    setError(null)
    try {
      setPhase('preparing')
      const photo = await prepareImage(file)
      setPhase('analysing')
      const draft = await api.layoutFromPhoto({
        image_base64: photo.base64,
        media_type: 'image/jpeg',
        name,
        language,
      })
      onDraft(draft, photo)
    } catch (err) {
      setError(photoErrorMessage(err, t))
    } finally {
      setPhase('idle')
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4" aria-labelledby={`${id}-t`}>
      <h3 id={`${id}-t`} className="text-sm font-bold uppercase tracking-widest text-dim">
        {t('editor.photo_title')}
      </h3>
      <p data-testid="photo-notice" className="rounded-md border border-amber/50 bg-amber/10 p-3 text-sm text-amber">
        {t('editor.photo_notice')}
      </p>
      <label
        className={`inline-flex min-h-12 cursor-pointer items-center justify-center rounded-md bg-signal px-4 py-3 font-bold uppercase tracking-wide text-white ${
          phase !== 'idle' ? 'pointer-events-none opacity-50' : ''
        }`}
      >
        {t('editor.photo_choose')}
        <input
          data-testid="photo-input"
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          disabled={phase !== 'idle'}
          onChange={(e) => void pick(e)}
        />
      </label>
      {phase !== 'idle' && (
        <p role="status" className="text-sm text-dim">
          {phase === 'preparing' ? t('editor.photo_working') : t('editor.photo_analysing')}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-signal/15 p-3 text-sm text-signal">
          {error}
        </p>
      )}
    </section>
  )
}
