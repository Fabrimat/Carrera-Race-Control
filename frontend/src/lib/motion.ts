import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'
const EFFECTS_KEY = 'carrera.tv.effects'

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

/** True when the OS asks for reduced motion: animations fall back to plain fades. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const mq = query()
    if (!mq) return
    const on = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

export function loadEffects(): boolean {
  try {
    return localStorage.getItem(EFFECTS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveEffects(on: boolean): void {
  try {
    localStorage.setItem(EFFECTS_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable */
  }
}
