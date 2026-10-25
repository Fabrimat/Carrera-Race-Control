import { useEffect, useState } from 'react'

export type Route =
  | { name: 'dashboard' }
  | { name: 'history' }
  | { name: 'history-detail'; id: number }
  | { name: 'settings' }
  | { name: 'tv' }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '')
  if (path === '/history') return { name: 'history' }
  const m = /^\/history\/(\d+)$/.exec(path)
  if (m) return { name: 'history-detail', id: Number(m[1]) }
  if (path === '/settings') return { name: 'settings' }
  if (path === '/tv') return { name: 'tv' }
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
