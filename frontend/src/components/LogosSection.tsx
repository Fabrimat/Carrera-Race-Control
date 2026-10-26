import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { guarded } from '../lib/errors'
import {
  checkLogoFile,
  LOGO_ACCEPT,
  loadLogos,
  MAX_LOGO_NAME,
  nameFromFile,
  readBase64,
  setLogos,
  useLogos,
} from '../lib/logos'
import { useStore } from '../lib/store'
import type { Logo } from '../lib/types'
import { CarLogo } from './CarLogo'

const btn = 'rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm font-bold'

function LogoRow({ logo }: { logo: Logo }) {
  const t = useT()
  const [name, setName] = useState(logo.name)
  const [confirming, setConfirming] = useState(false)
  const replaceInput = useRef<HTMLInputElement>(null)
  const valid = name.trim().length >= 1 && name.length <= MAX_LOGO_NAME

  const check = (file: File): boolean => {
    const problem = checkLogoFile(file)
    if (problem === null) return true
    useStore.getState().pushToast(t(problem === 'image_too_large' ? 'logos.too_large' : 'logos.bad_type'))
    return false
  }

  const rename = async () => {
    if (!valid || name.trim() === logo.name) {
      setName(logo.name)
      return
    }
    const saved = await guarded(() => api.updateLogo(logo.id, { name: name.trim(), image_base64: null }))
    if (saved) setLogos(useLogos.getState().logos.map((l) => (l.id === saved.id ? saved : l)))
  }

  const replace = async (file: File | undefined) => {
    if (!file || !check(file)) return
    const saved = await guarded(async () =>
      api.updateLogo(logo.id, { name: logo.name, image_base64: await readBase64(file) }),
    )
    if (saved) setLogos(useLogos.getState().logos.map((l) => (l.id === saved.id ? saved : l)))
  }

  const remove = async () => {
    const res = await guarded(() => api.deleteLogo(logo.id))
    setConfirming(false)
    if (res) {
      setLogos(res.logos)
      // Cars that used it were cleared server-side: pick the new settings up.
      const fresh = await guarded(() => api.getSettings())
      if (fresh) useStore.getState().setSettings(fresh)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3" data-testid="logo-row">
      <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-line bg-panel-2">
        <CarLogo logoId={logo.id} size={40} />
      </span>
      <input
        className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-3 py-2"
        value={name}
        maxLength={MAX_LOGO_NAME}
        aria-label={t('logos.rename', { name: logo.name })}
        aria-invalid={!valid}
        data-testid="logo-name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') setName(logo.name)
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept={LOGO_ACCEPT}
        className="hidden"
        data-testid="logo-replace-input"
        onChange={(e) => {
          void replace(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {confirming ? (
        <>
          <span className="text-sm text-signal">{t('logos.delete_confirm', { name: logo.name })}</span>
          <button
            type="button"
            data-testid="logo-confirm-delete"
            className={`${btn} border-signal bg-signal/20`}
            onClick={() => void remove()}
          >
            {t('logos.delete_yes')}
          </button>
          <button type="button" className={btn} onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={btn}
            aria-label={t('logos.replace_named', { name: logo.name })}
            onClick={() => replaceInput.current?.click()}
          >
            {t('logos.replace')}
          </button>
          <button
            type="button"
            className={btn}
            data-testid="logo-delete"
            aria-label={t('logos.delete_named', { name: logo.name })}
            onClick={() => setConfirming(true)}
          >
            {t('logos.delete')}
          </button>
        </>
      )}
    </li>
  )
}

/** The brand logo library: upload, rename, replace and delete (cars pick one in CarsSection). */
export function LogosSection() {
  const t = useT()
  const logos = useLogos((s) => s.logos)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadLogos()
  }, [])

  const upload = async (file: File | undefined) => {
    if (!file) return
    const problem = checkLogoFile(file)
    if (problem !== null) {
      useStore.getState().pushToast(t(problem === 'image_too_large' ? 'logos.too_large' : 'logos.bad_type'))
      return
    }
    setBusy(true)
    const created = await guarded(async () =>
      api.createLogo({ name: nameFromFile(file.name), image_base64: await readBase64(file) }),
    )
    setBusy(false)
    if (created) {
      setLogos(
        [...useLogos.getState().logos, created].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
      )
    }
  }

  return (
    <section className="rounded-lg border border-line bg-panel p-4" data-testid="logos-section">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold uppercase tracking-widest text-dim">{t('logos.title')}</h3>
        <input
          ref={fileInput}
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          data-testid="logo-upload-input"
          onChange={(e) => {
            void upload(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className={btn}
          disabled={busy}
          data-testid="logo-upload"
          onClick={() => fileInput.current?.click()}
        >
          {t('logos.upload')}
        </button>
      </div>
      {logos.length === 0 ? (
        <p className="text-sm text-dim">{t('logos.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {logos.map((l) => (
            <LogoRow key={`${l.id}@${l.name}`} logo={l} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-dim">{t('logos.hint')}</p>
    </section>
  )
}
