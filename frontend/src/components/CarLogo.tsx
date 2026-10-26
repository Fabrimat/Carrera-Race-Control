import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ensureLogo, useLogos } from '../lib/logos'

/**
 * A car's brand logo as a plain `<img>` (never inlined, so an SVG cannot run anything).
 * Renders nothing when the car has no logo, the library does not know it or the image fails.
 */
export function CarLogo({
  logoId,
  size = 24,
  className = '',
}: {
  logoId: string | null | undefined
  size?: number | string
  className?: string
}) {
  const logo = useLogos((s) => (logoId ? s.logos.find((l) => l.id === logoId) : undefined))
  // The failure is remembered per image version, so a replaced image gets another chance.
  const [failedKey, setFailedKey] = useState<string | null>(null)
  useEffect(() => {
    if (logoId && !logo) ensureLogo(logoId)
  }, [logoId, logo])
  if (!logoId || !logo) return null
  const key = `${logo.id}@${logo.updated_at}`
  if (failedKey === key) return null
  return (
    <img
      src={api.logoUrl(logo.id, logo.updated_at)}
      alt={logo.name}
      title={logo.name}
      data-testid="car-logo"
      style={{ height: size, width: size }}
      className={`shrink-0 object-contain ${className}`}
      onError={() => setFailedKey(key)}
    />
  )
}
