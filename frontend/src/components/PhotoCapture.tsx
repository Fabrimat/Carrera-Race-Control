import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/useT'
import { AVATAR_OPTS, PhotoError, prepareImage, type PreparedPhoto } from '../lib/photo'
import { useStore } from '../lib/store'

interface Props {
  /** Current preview (data URL of a new photo, or the stored photo URL). */
  preview: string | null
  onChange: (photo: PreparedPhoto | null) => void
}

/** Webcam capture or file upload for a driver photo (downscaled JPEG, display only). */
export function PhotoCapture({ preview, onChange }: Props) {
  const t = useT()
  const [live, setLive] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const stopCamera = () => {
    stream.current?.getTracks().forEach((tr) => tr.stop())
    stream.current = null
    setLive(false)
  }
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stream.current?.getTracks().forEach((tr) => tr.stop())
    }
  }, [])

  const toast = (m: string) => useStore.getState().pushToast(m)

  const prepare = async (blob: Blob) => {
    try {
      onChange(await prepareImage(blob, AVATAR_OPTS))
    } catch (e) {
      toast(e instanceof PhotoError && e.code === 'image_too_large' ? t('drivers.photo_too_large') : t('drivers.photo_invalid'))
    }
  }

  const openCamera = async () => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
      if (!alive.current) {
        media.getTracks().forEach((tr) => tr.stop())
        return
      }
      stream.current = media
      setLive(true)
    } catch {
      toast(t('drivers.photo_camera_error'))
    }
  }

  // Attach the stream once the <video> is mounted.
  useEffect(() => {
    if (live && video.current && stream.current) {
      video.current.srcObject = stream.current
      void video.current.play?.()?.catch?.(() => undefined)
    }
  }, [live])

  const capture = () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d')?.drawImage(v, 0, 0)
    canvas.toBlob(
      (b) => {
        stopCamera()
        if (b) void prepare(b)
      },
      'image/jpeg',
      0.9,
    )
  }

  const btn = 'min-h-11 rounded-md border border-line bg-panel-2 px-3 py-1 text-sm font-bold uppercase tracking-wide hover:border-amber'
  return (
    <div className="flex flex-col gap-2" data-testid="photo-capture">
      {live ? (
        <>
          <video ref={video} muted playsInline className="max-h-64 w-full rounded-md border border-line bg-black object-contain" />
          <div className="flex gap-2">
            <button type="button" className={btn} data-testid="photo-shoot" onClick={capture}>
              {t('drivers.photo_capture')}
            </button>
            <button type="button" className={btn} onClick={stopCamera}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          {preview && (
            <img
              src={preview}
              alt={t('drivers.photo_preview')}
              className="h-32 w-32 rounded-full border border-line object-cover"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={() => void openCamera()}>
              {t('drivers.photo_camera')}
            </button>
            <button type="button" className={btn} onClick={() => file.current?.click()}>
              {t('drivers.photo_upload')}
            </button>
            {preview && (
              <button type="button" className={btn} onClick={() => onChange(null)}>
                {t('drivers.photo_remove')}
              </button>
            )}
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              data-testid="photo-file"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void prepare(f)
              }}
            />
          </div>
        </>
      )}
      <p className="text-xs text-dim">{t('drivers.photo_note')}</p>
    </div>
  )
}
