import { describe, expect, it } from 'vitest'
import { dictionaries } from '../i18n'
import {
  comboFromEvent,
  comboMap,
  comboProblem,
  conflictsFor,
  effectiveBindings,
  findConflicts,
  formatCombo,
  normalizeCombo,
  overridesFrom,
  SHORTCUT_ACTIONS,
  type KeyLike,
} from './shortcuts'

const ev = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

describe('comboFromEvent', () => {
  it('upper-cases letters and makes Shift explicit', () => {
    expect(comboFromEvent(ev('p'))).toBe('P')
    expect(comboFromEvent(ev('P', { shiftKey: true }))).toBe('Shift+P')
    expect(comboFromEvent(ev('R', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+R')
    expect(comboFromEvent(ev('r', { ctrlKey: true }))).toBe('Ctrl+R')
  })

  it('ignores Shift on other printable characters (IT and US layouts)', () => {
    // IT layout: "+" is its own key, "?" is Shift+apostrophe; US layout: "+" is Shift+"=".
    expect(comboFromEvent(ev('+'))).toBe('+')
    expect(comboFromEvent(ev('+', { shiftKey: true }))).toBe('+')
    expect(comboFromEvent(ev('?', { shiftKey: true }))).toBe('?')
    expect(comboFromEvent(ev('?'))).toBe('?')
    expect(comboFromEvent(ev('-'))).toBe('-')
    expect(comboFromEvent(ev('1'))).toBe('1')
  })

  it('keeps all modifiers on non-printable keys and names Space', () => {
    expect(comboFromEvent(ev(' '))).toBe('Space')
    expect(comboFromEvent(ev('ArrowUp', { shiftKey: true }))).toBe('Shift+ArrowUp')
    expect(comboFromEvent(ev('F2'))).toBe('F2')
    expect(comboFromEvent(ev('Escape'))).toBe('Escape')
    expect(comboFromEvent(ev('Enter', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Enter')
  })

  it('rejects dead keys, modifier-only presses, Meta and AltGr', () => {
    for (const key of ['Dead', 'Unidentified', 'Process', 'Shift', 'Control', 'Alt', 'AltGraph', 'Meta']) {
      expect(comboFromEvent(ev(key))).toBeNull()
    }
    expect(comboFromEvent(ev('p', { metaKey: true }))).toBeNull()
    // AltGr is reported as Ctrl+Alt on Windows.
    expect(comboFromEvent(ev('€', { ctrlKey: true, altKey: true }))).toBeNull()
    expect(comboFromEvent({ ...ev('@'), getModifierState: (k) => k === 'AltGraph' })).toBeNull()
  })
})

describe('normalizeCombo and problems', () => {
  it('canonicalises stored combos, including the "+" key', () => {
    expect(normalizeCombo('shift+p')).toBeNull() // modifiers are case-sensitive
    expect(normalizeCombo('Shift+p')).toBe('Shift+P')
    expect(normalizeCombo('Shift+Ctrl+R')).toBe('Ctrl+Shift+R')
    expect(normalizeCombo('+')).toBe('+')
    expect(normalizeCombo('Ctrl++')).toBe('Ctrl++')
    expect(normalizeCombo('Shift+?')).toBe('?')
    expect(normalizeCombo('Space')).toBe('Space')
  })

  it('rejects malformed, AltGr and over-long combos', () => {
    for (const bad of ['', 'Ctrl+', 'Ctrl+Alt+X', 'Shift', 'A+B', 'x'.repeat(41)]) {
      expect(normalizeCombo(bad)).toBeNull()
    }
  })

  it('flags browser-reserved combos', () => {
    for (const c of ['Ctrl+R', 'Ctrl+W', 'Ctrl+N', 'Ctrl+T', 'F5', 'F11', 'F12']) {
      expect(comboProblem(c)).toBe('reserved')
    }
    expect(comboProblem('Ctrl+Shift+R')).toBeNull()
    expect(comboProblem('Ctrl+Alt+R')).toBe('invalid')
  })

  it('formats key caps', () => {
    expect(formatCombo('Shift+ArrowUp')).toBe('Shift+↑')
    expect(formatCombo('Ctrl+Shift+R')).toBe('Ctrl+Shift+R')
  })
})

describe('registry and bindings', () => {
  it('has unique ids, valid unique defaults, destructive actions behind a modifier', () => {
    const ids = SHORTCUT_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of SHORTCUT_ACTIONS) {
      expect(a.combo === '' || comboProblem(a.combo) === null).toBe(true)
      if (a.destructive) expect(/^(Ctrl|Alt)\+/.test(a.combo)).toBe(true)
    }
    expect(findConflicts(effectiveBindings())).toEqual({})
  })

  it('has a label in every language for every action', () => {
    for (const dict of Object.values(dictionaries)) {
      for (const a of SHORTCUT_ACTIONS) expect(dict[a.labelKey as keyof typeof dict]).toBeTruthy()
    }
  })

  it('applies overrides, "" disables, bad overrides fall back to the default', () => {
    const b = effectiveBindings({ 'race.pace_car': 'Shift+X', 'race.mode': '', 'race.reset': 'Ctrl+R', zzz: 'Q' })
    expect(b['race.pace_car']).toBe('Shift+X')
    expect(b['race.mode']).toBe('')
    expect(b['race.reset']).toBe('Ctrl+Shift+R') // reserved override ignored
    expect(b.zzz).toBeUndefined()
  })

  it('detects conflicts and lets the first action win', () => {
    const b = effectiveBindings({ 'race.mode': 'P' })
    expect(findConflicts(b)).toEqual({ P: ['race.pace_car', 'race.mode'] })
    expect(conflictsFor('race.mode', 'P', b)).toEqual(['race.pace_car'])
    expect(conflictsFor('race.mode', '', b)).toEqual([])
    expect(comboMap(b).get('P')).toBe('race.pace_car')
  })

  it('persists only the differences from the defaults', () => {
    const b = effectiveBindings({ 'race.mode': '', 'race.pace_car': 'Shift+X' })
    expect(overridesFrom(b)).toEqual({ 'race.mode': '', 'race.pace_car': 'Shift+X' })
    expect(overridesFrom(effectiveBindings())).toEqual({})
  })
})
