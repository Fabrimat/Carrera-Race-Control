import { useEffect, useLayoutEffect, useState } from 'react'

/**
 * Responsive layout classes, defined once and shared by the dashboard and TV mode.
 *
 * `useLayoutSync()` (mounted once in App) writes the class to `<html data-layout>` and the UI
 * scale to the root font size; CSS (index.css custom variants, tv.css) keys on that attribute,
 * components read the same value through `useLayout()`.
 *
 * The 1200 px full-viewport grid (1366x768, 1920x1080) is the `desktop` class and is still
 * driven by the `min-[1200px]` utilities of the dashboard, so it is unchanged.
 */
export type LayoutClass = 'phone' | 'tablet-portrait' | 'tablet-landscape' | 'desktop' | 'ultrawide' | 'uhd'

/** Below this shortest side the device is a phone (pit wall). */
export const PHONE_MAX_SHORT_SIDE = 600
/** From this width the dashboard is the full-viewport grid (matches `min-[1200px]` in Dashboard). */
export const DESKTOP_MIN_WIDTH = 1200
/** Aspect ratio (w / h) from which a wide screen counts as ultrawide (21:9 is 2.33, 2:1 is 2). */
export const ULTRAWIDE_MIN_ASPECT = 2.2
/** Width below which the header nav collapses into a menu (matches `min-[900px]` in Header). */
export const NAV_COLLAPSE_BELOW = 900
/** Height thresholds for scaling the whole UI on big screens (rem based). */
export const UHD_SCALE_STEPS: readonly { minHeight: number; scale: number }[] = [
  { minHeight: 1800, scale: 1.5 }, // 3840x2160
  { minHeight: 1250, scale: 1.25 }, // 2560x1440 (a maximised browser has ~1300 px)
]

/** Root font-size multiplier: 1 up to 1080p, larger on 1440p / 4K so the panels do not look tiny. */
export function uiScale(width: number, height: number): number {
  if (width < DESKTOP_MIN_WIDTH) return 1
  return UHD_SCALE_STEPS.find((s) => height >= s.minHeight)?.scale ?? 1
}

export function classifyLayout(width: number, height: number): LayoutClass {
  if (Math.min(width, height) < PHONE_MAX_SHORT_SIDE) return 'phone'
  if (width < DESKTOP_MIN_WIDTH) return height > width ? 'tablet-portrait' : 'tablet-landscape'
  if (width / height >= ULTRAWIDE_MIN_ASPECT) return 'ultrawide'
  return uiScale(width, height) > 1 ? 'uhd' : 'desktop'
}

/** Touch-first classes: bigger hit targets, collapsible panels. */
export function isTouchLayout(l: LayoutClass): boolean {
  return l === 'phone' || l === 'tablet-portrait' || l === 'tablet-landscape'
}

export function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const on = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return size
}

export function useLayout(): LayoutClass {
  const { width, height } = useViewport()
  return classifyLayout(width, height)
}

/** Mirror the layout class and UI scale onto <html> (once, from App). */
export function useLayoutSync(): void {
  const { width, height } = useViewport()
  const layout = classifyLayout(width, height)
  const scale = uiScale(width, height)
  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset.layout = layout
    root.style.fontSize = scale === 1 ? '' : `${16 * scale}px`
  }, [layout, scale])
}
