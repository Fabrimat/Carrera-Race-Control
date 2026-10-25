import { useEffect, useState } from 'react'

export type Route =
  | { name: 'dashboard' }
  | { name: 'history' }
  | { name: 'history-detail'; id: number }
  | { name: 'settings' }
  | { name: 'tv' }
  | { name: 'drivers' }
  | { name: 'track'; layout: string | null }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '')
  if (path === '/history') return { name: 'history' }
  const m = /^\/history\/(\d+)$/.exec(path)
  if (m) return { name: 'history-detail', id: Number(m[1]) }
  if (path === '/settings') return { name: 'settings' }
  if (path === '/tv') return { name: 'tv' }
  if (path === '/drivers') return { name: 'drivers' }
  if (path === '/track') return { name: 'track', layout: null }
  const tm = /^\/track\/(.+)$/.exec(path)
  if (tm) {
    try {
      return { name: 'track', layout: decodeURIComponent(tm[1]) }
    } catch {
      return { name: 'track', layout: null }
    }
  }
  return { name: 'dashboard' }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return parseHash(hash)
}
