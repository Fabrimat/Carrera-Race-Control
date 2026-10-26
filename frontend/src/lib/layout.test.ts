import { describe, expect, it } from 'vitest'
import dashboardSource from '../pages/Dashboard.tsx?raw'
import { classifyLayout, DESKTOP_MIN_WIDTH, isTouchLayout, uiScale } from './layout'

describe('classifyLayout', () => {
  it.each([
    [390, 844, 'phone'],
    [844, 390, 'phone'], // phone in landscape
    [768, 1024, 'tablet-portrait'],
    [1024, 768, 'tablet-landscape'],
    [1180, 820, 'tablet-landscape'],
    [1366, 768, 'desktop'],
    [1920, 1080, 'desktop'],
    [1280, 720, 'desktop'],
    [2560, 1080, 'ultrawide'],
    [3440, 1440, 'ultrawide'],
    [2560, 1440, 'uhd'],
    [3840, 2160, 'uhd'],
    [5120, 2160, 'ultrawide'],
  ] as const)('%ix%i is %s', (w, h, cls) => {
    expect(classifyLayout(w, h)).toBe(cls)
  })

  it('keeps 1366x768 and 1920x1080 unscaled', () => {
    expect(uiScale(1366, 768)).toBe(1)
    expect(uiScale(1920, 1080)).toBe(1)
    expect(uiScale(2560, 1080)).toBe(1)
  })

  it('scales 1440p and 4K', () => {
    expect(uiScale(2560, 1440)).toBe(1.25)
    expect(uiScale(2560, 1300)).toBe(1.25) // maximised browser on a 1440p screen
    expect(uiScale(2560, 1249)).toBe(1)
    expect(uiScale(3840, 2160)).toBe(1.5)
    expect(uiScale(1024, 2000)).toBe(1) // never scales below the desktop width
  })

  it('treats phones and tablets as touch layouts', () => {
    expect(isTouchLayout('phone')).toBe(true)
    expect(isTouchLayout('tablet-portrait')).toBe(true)
    expect(isTouchLayout('tablet-landscape')).toBe(true)
    expect(isTouchLayout('desktop')).toBe(false)
    expect(isTouchLayout('ultrawide')).toBe(false)
  })

  it('stays in sync with the 1200 px grid breakpoint used by the dashboard', () => {
    expect(dashboardSource).toContain(`min-[${DESKTOP_MIN_WIDTH}px]:grid`)
  })
})
