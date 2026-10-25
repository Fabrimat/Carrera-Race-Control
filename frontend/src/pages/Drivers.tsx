import { useState } from 'react'
import { DriverAvatar } from '../components/DriverAvatar'
import { PhotoCapture } from '../components/PhotoCapture'
import { WhoDriving } from '../components/WhoDriving'
import { useT } from '../i18n/useT'
import { api } from '../lib/api'
import { bumpPhoto } from '../lib/drivers'
import { guarded } from '../lib/errors'
import { refreshEventData } from '../lib/eventData'
import type { PreparedPhoto } from '../lib/photo'
import { useStore } from '../lib/store'
import type { Driver } from '../lib/types'

/** `undefined` = photo untouched, `null` = remove it, else a new photo to upload. */
type PhotoEdit = PreparedPhoto | null | undefined

function DriverForm({ driver, onDone }: { driver: Driver | null; onDone: () => void }) {
  const t = useT()
  const [name, setName] = useState(driver?.name ?? '')
  const [nickname, setNickname] = useState(driver?.nickname ?? '')
  const [bio, setBio] = useState(driver?.bio ?? '')
  const [photo, setPhoto] = useState<PhotoEdit>(undefined)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [bust] = useState(() => String(Date.now()))
  const valid = name.trim().length > 0

  const preview =
    photo === undefined ? (driver?.has_photo ? api.driverPhotoUrl(driver.id, bust) : null) : (photo?.dataUrl ?? null)

  const save = async () => {
    setTouched(true)
    if (!valid || saving) return
    setSaving(true)
    const fields = { name: name.trim(), nickname: nickname.trim() || null, bio: bio.trim() }
    let saved = await guarded(() => (driver ? api.saveDriver({ ...driver, ...fields }) : api.createDriver(fields)))
    if (saved && photo !== undefined) {
      const id = saved.id
      const withPhoto = await guarded(() =>
        photo === null
          ? driver?.has_photo
            ? api.deleteDriverPhoto(id)
            : Promise.resolve(saved as Driver)
          : api.setDriverPhoto(id, { image_base64: photo.base64, media_type: 'image/jpeg' }),
      )
      if (withPhoto) {
        saved = withPhoto
        bumpPhoto(id)
      }
    }
    setSaving(false)
    if (saved) {
      await refreshEventData()
      onDone()
    }
  }

  const field = 'min-h-11 rounded-md border border-line bg-panel-2 px-3 py-2 text-base'
  return (
    <form
      data-testid="driver-form"
      className="flex flex-col gap-3 rounded-lg border border-amber bg-panel-2/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone()
      }}
    >
      <label className="flex flex-col gap-1 text-sm text-dim">
        {t('drivers.name')}
        <input
          autoFocus
          value={name}
          maxLength={60}
          aria-invalid={touched && !valid}
          className={`${field} text-ink ${touched && !valid ? 'border-signal' : ''}`}
          onChange={(e) => setName(e.target.value)}
        />
        {touched && !valid && <span className="text-signal">{t('drivers.name_required')}</span>}
      </label>
      <label className="flex flex-col gap-1 text-sm text-dim">
        {t('drivers.nickname')}
        <input value={nickname} maxLength={40} className={`${field} text-ink`} onChange={(e) => setNickname(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-sm text-dim">
        {t('drivers.bio')}
        <textarea value={bio} rows={3} maxLength={500} className={`${field} text-ink`} onChange={(e) => setBio(e.target.value)} />
      </label>
      <div>
        <h4 className="mb-1 text-sm text-dim">{t('drivers.photo')}</h4>
        <PhotoCapture preview={preview} onChange={setPhoto} />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="min-h-11 rounded-md border border-go bg-go/20 px-5 font-bold uppercase tracking-wide disabled:opacity-50"
        >
          {t('drivers.save')}
        </button>
        <button type="button" className="min-h-11 rounded-md border border-line px-5" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

function Roster() {
  const t = useT()
  const drivers = useStore((s) => s.drivers)
  const [editing, setEditing] = useState<Driver | 'new' | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const remove = async (d: Driver) => {
    setConfirming(null)
    const res = await guarded(() => api.deleteDriver(d.id))
    if (res) {
      useStore.getState().setDrivers(res.drivers)
      await refreshEventData()
    }
  }

  const btn = 'min-h-11 rounded-md border border-line bg-panel-2 px-3 text-sm font-bold uppercase tracking-wide'
  return (
    <section aria-label={t('drivers.roster')} className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-lg font-black uppercase tracking-widest">{t('drivers.roster')}</h2>
        <button type="button" data-testid="add-driver" className={`${btn} hover:border-go`} onClick={() => setEditing('new')}>
          + {t('drivers.add')}
        </button>
      </div>
      {editing === 'new' && <DriverForm driver={null} onDone={() => setEditing(null)} />}
      {drivers.length === 0 && editing !== 'new' && <p className="text-dim">{t('drivers.empty')}</p>}
      <ul className="flex flex-col gap-2">
        {drivers.map((d) =>
          editing !== 'new' && editing?.id === d.id ? (
            <li key={d.id}>
              <DriverForm driver={d} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li
              key={d.id}
              data-testid="roster-row"
              className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 p-2"
            >
              <DriverAvatar driver={d} size={48} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-lg font-bold">{d.name}</span>
                {d.nickname && <span className="truncate text-sm text-dim">{d.nickname}</span>}
              </span>
              {confirming === d.id ? (
                <>
                  <span className="text-sm text-signal">{t('drivers.delete_confirm', { name: d.name })}</span>
                  <button
                    type="button"
                    data-testid="confirm-delete"
                    className={`${btn} border-signal bg-signal/20`}
                    onClick={() => void remove(d)}
                  >
                    {t('drivers.delete_yes')}
                  </button>
                  <button type="button" className={btn} onClick={() => setConfirming(null)}>
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={btn}
                    aria-label={t('drivers.edit_named', { name: d.name })}
                    onClick={() => setEditing(d)}
                  >
                    {t('drivers.edit')}
                  </button>
                  <button
                    type="button"
                    className={`${btn} hover:border-signal`}
                    aria-label={t('drivers.delete_named', { name: d.name })}
                    onClick={() => setConfirming(d.id)}
                  >
                    {t('drivers.delete')}
                  </button>
                </>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  )
}

export function Drivers() {
  const t = useT()
  return (
    <div data-testid="drivers-page" className="mx-auto grid max-w-[1600px] gap-6 p-4 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <h1 className="sr-only">{t('drivers.title')}</h1>
      <Roster />
      <WhoDriving />
    </div>
  )
}
