import { describe, expect, it } from 'vitest'
import {
  addChip,
  addSession,
  duplicateProgram,
  moveSession,
  newProgram,
  newSession,
  prepareForSave,
  removeSession,
  uniqueId,
  validateProgram,
} from './program'
import type { EventProgram, SessionSpec } from './types'

const prog = (sessions: SessionSpec[]): EventProgram => ({ ...newProgram('Test', []), sessions })
const three = (): SessionSpec[] => {
  let s: SessionSpec[] = []
  s = addSession(s, 'practice')
  s = addSession(s, 'qualifying')
  s = addSession(s, 'race')
  return s
}

describe('program helpers', () => {
  it('makes unique slug ids', () => {
    expect(uniqueId('Gran Premio È Così!', [])).toBe('gran-premio-e-cosi')
    expect(uniqueId('race', ['race', 'race-2'])).toBe('race-3')
    expect(uniqueId('!!!', [])).toBe('item')
  })

  it('forces qualifying to timed', () => {
    expect(newSession('qualifying', []).mode).toBe('timed')
    const q = { ...newSession('race', []), kind: 'qualifying' as const, mode: 'laps' as const }
    expect(prepareForSave(prog([q])).sessions[0].mode).toBe('timed')
  })

  it('reorders sessions and clears a grid_from that no longer points back', () => {
    let s = three()
    s[2] = { ...s[2], grid_from: s[1].id }
    const ids = s.map((x) => x.id)
    s = moveSession(s, 2, -1) // race now before qualifying
    expect(s.map((x) => x.id)).toEqual([ids[0], ids[2], ids[1]])
    expect(s[1].grid_from).toBeNull()
    expect(moveSession(s, 0, -1)).toBe(s)
    expect(moveSession(s, 2, 1)).toBe(s)
  })

  it('removing a session clears grids that referenced it', () => {
    let s = three()
    s[2] = { ...s[2], grid_from: s[1].id }
    s = removeSession(s, 1)
    expect(s).toHaveLength(2)
    expect(s[1].grid_from).toBeNull()
  })

  it('validates a program', () => {
    expect(validateProgram(prog(three()))).toEqual([])
    expect(validateProgram({ ...prog(three()), name: '  ' }).map((i) => i.code)).toEqual(['name_required'])
    expect(validateProgram(prog([])).map((i) => i.code)).toEqual(['no_sessions'])
    const s = three()
    const dup = [s[0], { ...s[1], id: s[0].id }]
    expect(validateProgram(prog(dup)).map((i) => i.code)).toContain('duplicate_session_id')
    const bad = [{ ...s[0], grid_from: s[0].id }] // refers to itself, not an earlier session
    expect(validateProgram(prog(bad)).map((i) => i.code)).toContain('grid_from_invalid')
    const laps = [{ ...s[2], mode: 'laps' as const, target_laps: 0 }]
    expect(validateProgram(prog(laps)).map((i) => i.code)).toContain('laps_invalid')
    const dur = [{ ...s[1], duration_s: 5 }]
    expect(validateProgram(prog(dur)).map((i) => i.code)).toContain('duration_invalid')
    const pen = [{ ...s[2], false_start: { action: 'penalty' as const, penalty_s: 500 } }]
    expect(validateProgram(prog(pen)).map((i) => i.code)).toContain('penalty_invalid')
  })

  it('duplicates with a fresh id', () => {
    const p = prog(three())
    const d = duplicateProgram(p, 'Test (copy)', [p.id])
    expect(d.id).not.toBe(p.id)
    expect(d.sessions).toEqual(p.sessions)
    expect(d.sessions).not.toBe(p.sessions)
  })

  it('adds chips trimmed, unique and bounded', () => {
    expect(addChip([], '  Acme ', 3)).toEqual(['Acme'])
    expect(addChip(['Acme'], 'acme', 3)).toEqual(['Acme'])
    expect(addChip(['a', 'b'], 'c', 2)).toEqual(['a', 'b'])
    expect(addChip([], '   ', 3)).toEqual([])
  })
})
