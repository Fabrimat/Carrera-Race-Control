import type { TKey } from '../i18n'

// Keyboard shortcuts: action registry, combo parsing / normalisation and conflict detection.
// Pure (no DOM access, no store): the listener lives in `useShortcuts.ts`, the handlers in
// `shortcutActions.ts`. The combo format is documented in docs/PROTOCOL.md "Keyboard shortcuts".

export type ShortcutGroup = 'race' | 'connection' | 'commentary' | 'views' | 'cars' | 'help'

export interface ShortcutAction {
  id: string
  group: ShortcutGroup
  labelKey: TKey
  /** Default combo, "" when the action ships unbound. */
  combo: string
  /** Fires again while the key is held down (volume, amounts). */
  repeatable?: boolean
  /** Stop / reset / disconnect: the default combo carries a modifier. */
  destructive?: boolean
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['race', 'connection', 'commentary', 'views', 'cars', 'help']

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'race.start', group: 'race', labelKey: 'shortcuts.action.race.start', combo: 'Space' },
  { id: 'race.stop', group: 'race', labelKey: 'shortcuts.action.race.stop', combo: 'Ctrl+Shift+S', destructive: true },
  { id: 'race.reset', group: 'race', labelKey: 'shortcuts.action.race.reset', combo: 'Ctrl+Shift+R', destructive: true },
  { id: 'race.pace_car', group: 'race', labelKey: 'shortcuts.action.race.pace_car', combo: 'P' },
  { id: 'race.mode', group: 'race', labelKey: 'shortcuts.action.race.mode', combo: 'M' },
  { id: 'race.amount_up', group: 'race', labelKey: 'shortcuts.action.race.amount_up', combo: '+', repeatable: true },
  { id: 'race.amount_down', group: 'race', labelKey: 'shortcuts.action.race.amount_down', combo: '-', repeatable: true },
  { id: 'conn.connect', group: 'connection', labelKey: 'shortcuts.action.conn.connect', combo: 'C' },
  { id: 'conn.disconnect', group: 'connection', labelKey: 'shortcuts.action.conn.disconnect', combo: 'Ctrl+Shift+D', destructive: true },
  { id: 'conn.scan', group: 'connection', labelKey: 'shortcuts.action.conn.scan', combo: 'S' },
  { id: 'commentary.mute', group: 'commentary', labelKey: 'shortcuts.action.commentary.mute', combo: 'Shift+M' },
  { id: 'commentary.volume_up', group: 'commentary', labelKey: 'shortcuts.action.commentary.volume_up', combo: 'Shift+ArrowUp', repeatable: true },
  { id: 'commentary.volume_down', group: 'commentary', labelKey: 'shortcuts.action.commentary.volume_down', combo: 'Shift+ArrowDown', repeatable: true },
  { id: 'commentary.effects', group: 'commentary', labelKey: 'shortcuts.action.commentary.effects', combo: 'E' },
  { id: 'commentary.llm', group: 'commentary', labelKey: 'shortcuts.action.commentary.llm', combo: 'L' },
  { id: 'commentary.repeat', group: 'commentary', labelKey: 'shortcuts.action.commentary.repeat', combo: 'R' },
  { id: 'nav.dashboard', group: 'views', labelKey: 'shortcuts.action.nav.dashboard', combo: '1' },
  { id: 'nav.history', group: 'views', labelKey: 'shortcuts.action.nav.history', combo: '2' },
  { id: 'nav.event', group: 'views', labelKey: 'shortcuts.action.nav.event', combo: '3' },
  { id: 'nav.drivers', group: 'views', labelKey: 'shortcuts.action.nav.drivers', combo: '4' },
  { id: 'nav.track', group: 'views', labelKey: 'shortcuts.action.nav.track', combo: '5' },
  { id: 'nav.settings', group: 'views', labelKey: 'shortcuts.action.nav.settings', combo: '6' },
  { id: 'nav.tv', group: 'views', labelKey: 'shortcuts.action.nav.tv', combo: 'T' },
  { id: 'view.fullscreen', group: 'views', labelKey: 'shortcuts.action.view.fullscreen', combo: 'F' },
  { id: 'cars.next', group: 'cars', labelKey: 'shortcuts.action.cars.next', combo: 'J' },
  { id: 'cars.prev', group: 'cars', labelKey: 'shortcuts.action.cars.prev', combo: 'K' },
  { id: 'help.toggle', group: 'help', labelKey: 'shortcuts.action.help.toggle', combo: '?' },
]

export function actionById(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === id)
}

// ------------------------------------------------------------------ combos

/** Keys that are modifiers or produce no usable key on their own. */
const IGNORED_KEYS = new Set([
  'Dead',
  'Unidentified',
  'Process',
  'Control',
  'Alt',
  'AltGraph',
  'Shift',
  'Meta',
  'OS',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Compose',
])

/** Browser-reserved combos that can never be bound (the page would reload, close, ...). */
const RESERVED = new Set(['Ctrl+R', 'Ctrl+W', 'Ctrl+N', 'Ctrl+T', 'F5', 'F11', 'F12'])

export const MAX_COMBO_LENGTH = 40

export interface KeyLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  getModifierState?: (key: string) => boolean
}

function isLetter(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase()
}

function build(ctrl: boolean, alt: boolean, shift: boolean, key: string): string {
  return `${ctrl ? 'Ctrl+' : ''}${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`
}

/**
 * Normalise a `KeyboardEvent` to a combo string, or null when it cannot be a shortcut (modifier
 * only, dead key, Meta, AltGr = Ctrl+Alt). Letters become upper case with an explicit `Shift+`;
 * other printable characters (`?`, `+`, digits) are the produced character with Shift ignored, so
 * the same combo works on IT and US layouts; non-printable keys keep all their modifiers.
 */
export function comboFromEvent(e: KeyLike): string | null {
  const { key } = e
  if (!key || IGNORED_KEYS.has(key) || e.metaKey) return null
  if ((e.ctrlKey && e.altKey) || e.getModifierState?.('AltGraph')) return null
  if (key === ' ') return build(e.ctrlKey, e.altKey, e.shiftKey, 'Space')
  if (isLetter(key)) return build(e.ctrlKey, e.altKey, e.shiftKey, key.toUpperCase())
  if ([...key].length === 1) return build(e.ctrlKey, e.altKey, false, key)
  return build(e.ctrlKey, e.altKey, e.shiftKey, key)
}

/**
 * Parse and canonicalise a stored combo string (`Ctrl+Alt+Shift+<key>`, any modifier order, the
 * key may itself be `+`). Returns null when it is malformed, AltGr, Meta or too long.
 */
export function normalizeCombo(raw: string): string | null {
  if (!raw || raw.length > MAX_COMBO_LENGTH) return null
  let rest = raw
  let ctrl = false
  let alt = false
  let shift = false
  for (;;) {
    const m = /^(Ctrl|Alt|Shift)\+(.+)$/.exec(rest)
    if (!m) break
    if (m[1] === 'Ctrl') ctrl = true
    else if (m[1] === 'Alt') alt = true
    else shift = true
    rest = m[2]
  }
  if (!rest || IGNORED_KEYS.has(rest) || rest.startsWith('Meta')) return null
  if (ctrl && alt) return null
  if (rest.includes('+') && rest !== '+') return null
  if ([...rest].length === 1) {
    if (isLetter(rest)) return build(ctrl, alt, shift, rest.toUpperCase())
    return build(ctrl, alt, false, rest)
  }
  return build(ctrl, alt, shift, rest)
}

export function isReservedCombo(combo: string): boolean {
  return RESERVED.has(combo)
}

/** Why a combo cannot be used: null = fine. */
export function comboProblem(combo: string): 'invalid' | 'reserved' | null {
  const norm = normalizeCombo(combo)
  if (norm === null) return 'invalid'
  if (isReservedCombo(norm)) return 'reserved'
  return null
}

/** Human-readable form of a combo for key caps ("Space" stays, "Ctrl+Shift+R", arrows as symbols). */
export function formatCombo(combo: string): string {
  const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }
  const norm = normalizeCombo(combo) ?? combo
  const m = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(norm)
  if (!m) return norm
  return `${m[1]}${arrows[m[2]] ?? m[2]}`
}

// ------------------------------------------------------------------ bindings

/** action id -> effective combo ("" = disabled). Unknown ids and unusable overrides are dropped. */
export function effectiveBindings(overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of SHORTCUT_ACTIONS) {
    const o = overrides[a.id]
    if (o === '') {
      out[a.id] = ''
    } else if (typeof o === 'string' && comboProblem(o) === null) {
      out[a.id] = normalizeCombo(o) as string
    } else {
      out[a.id] = a.combo
    }
  }
  return out
}

/** The overrides to persist for these bindings: only what differs from the defaults. */
export function overridesFrom(bindings: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of SHORTCUT_ACTIONS) {
    const b = bindings[a.id]
    if (b !== undefined && b !== a.combo) out[a.id] = b
  }
  return out
}

/** combo -> action ids bound to it, only for combos used by more than one action. */
export function findConflicts(bindings: Record<string, string>): Record<string, string[]> {
  const byCombo = new Map<string, string[]>()
  for (const a of SHORTCUT_ACTIONS) {
    const c = bindings[a.id]
    if (!c) continue
    byCombo.set(c, [...(byCombo.get(c) ?? []), a.id])
  }
  const out: Record<string, string[]> = {}
  for (const [c, ids] of byCombo) if (ids.length > 1) out[c] = ids
  return out
}

/** The other actions that already use `combo` (for the warning while rebinding `id`). */
export function conflictsFor(id: string, combo: string, bindings: Record<string, string>): string[] {
  if (!combo) return []
  return SHORTCUT_ACTIONS.filter((a) => a.id !== id && bindings[a.id] === combo).map((a) => a.id)
}

/** combo -> action id for the listener; on a conflict the first action in registry order wins. */
export function comboMap(bindings: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const a of SHORTCUT_ACTIONS) {
    const c = bindings[a.id]
    if (c && !map.has(c)) map.set(c, a.id)
  }
  return map
}
