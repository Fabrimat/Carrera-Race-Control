import { useState } from 'react'
import { api } from '../lib/api'
import { initials, photoVersion } from '../lib/drivers'
import type { Driver } from '../lib/types'

/** Round photo of a driver, or their initials when there is no photo (display only). */
export function DriverAvatar({
  driver,
  size = 40,
  color,
}: {
  driver: Pick<Driver, 'id' | 'name' | 'has_photo'>
  size?: number
  color?: string
}) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size, fontSize: size * 0.4 }
  if (driver.has_photo && !failed) {
    return (
      <img
        src={api.driverPhotoUrl(driver.id, photoVersion(driver.id))}
        alt=""
        data-testid="driver-photo"
        style={style}
        className="shrink-0 rounded-full border border-line object-cover"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span
      aria-hidden
      data-testid="driver-initials"
      style={{ ...style, background: color ?? undefined }}
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-panel-2 font-black text-ink"
    >
      {initials(driver.name)}
    </span>
  )
}
