import type { CommentaryContext, EventProgram, SessionKind, SessionSpec } from './types'

// Pure helpers for the program editor (no React): creation, reordering, validation.

export const MAX_SESSIONS = 20
export const MAX_SPONSORS = 10
export const MAX_AVOID_WORDS = 50

export type ProgramIssue =
  | { code: 'name_required' }
  | { code: 'no_sessions' }
  | { code: 'too_many_sessions' }
  | { code: 'duplicate_session_id'; session: string }
  | { code: 'grid_from_invalid'; session: string }
  | { code: 'laps_invalid'; session: string }
  | { code: 'duration_invalid'; session: string }
  | { code: 'penalty_invalid'; session: string }

export const emptyCommentary: CommentaryContext = {
  event_name: '',
  location: '',
  sponsors: [],
  tone: 'enthusiastic',
  notes: '',
  avoid_words: [],
}

/** Slug-like id (`[a-z0-9-]`, max 40) derived from a name, made unique against `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'item'
  if (!used.has(slug)) return slug
  for (let n = 2; ; n++) {
    const id = `${slug}-${n}`
    if (!used.has(id)) return id
  }
}

/** Qualifying always runs timed (the backend forces it too). */
export function normaliseSession(s: SessionSpec): SessionSpec {
  return s.kind === 'qualifying' ? { ...s, mode: 'timed' } : s
}

export function newSession(kind: SessionKind, existing: SessionSpec[]): SessionSpec {
  return normaliseSession({
    id: uniqueId(kind, existing.map((s) => s.id)),
    kind,
    name: '',
    mode: kind === 'race' ? 'laps' : 'timed',
    target_laps: 10,
    duration_s: kind === 'race' ? 600 : 300,
    false_start: { action: 'warn', penalty_s: 5 },
    grid_from: null,
    incidents: null,
    pits: null,
  })
}

export function newProgram(name: string, taken: Iterable<string>): EventProgram {
  return {
    id: uniqueId(name, taken),
    name,
    sessions: [newSession('practice', [])],
    commentary: { ...emptyCommentary },
    updated_at: new Date().toISOString(),
  }
}

export function duplicateProgram(p: EventProgram, name: string, taken: Iterable<string>): EventProgram {
  return {
    ...structuredClone(p),
    id: uniqueId(name, taken),
    name,
    updated_at: new Date().toISOString(),
  }
}

/** Fix `grid_from` references that no longer point at an earlier session. */
export function cleanGrid(sessions: SessionSpec[]): SessionSpec[] {
  return sessions.map((s, i) =>
    s.grid_from && !sessions.slice(0, i).some((e) => e.id === s.grid_from) ? { ...s, grid_from: null } : s,
  )
}

/** Move the session at `index` by `delta` places; out-of-range moves are ignored. */
export function moveSession(sessions: SessionSpec[], index: number, delta: -1 | 1): SessionSpec[] {
  const to = index + delta
  if (index < 0 || index >= sessions.length || to < 0 || to >= sessions.length) return sessions
  const next = [...sessions]
  ;[next[index], next[to]] = [next[to], next[index]]
  return cleanGrid(next)
}

export function removeSession(sessions: SessionSpec[], index: number): SessionSpec[] {
  return cleanGrid(sessions.filter((_, i) => i !== index))
}

export function addSession(sessions: SessionSpec[], kind: SessionKind): SessionSpec[] {
  return [...sessions, newSession(kind, sessions)]
}

/** Earlier sessions a session may take its grid from. */
export function gridChoices(sessions: SessionSpec[], index: number): SessionSpec[] {
  return sessions.slice(0, index)
}

/** Client-side mirror of the backend program rules; empty list = valid. */
export function validateProgram(p: EventProgram): ProgramIssue[] {
  const issues: ProgramIssue[] = []
  if (p.name.trim().length < 1) issues.push({ code: 'name_required' })
  if (p.sessions.length < 1) issues.push({ code: 'no_sessions' })
  if (p.sessions.length > MAX_SESSIONS) issues.push({ code: 'too_many_sessions' })
  const seen = new Set<string>()
  p.sessions.forEach((s, i) => {
    if (seen.has(s.id)) issues.push({ code: 'duplicate_session_id', session: s.id })
    seen.add(s.id)
    if (s.grid_from && !p.sessions.slice(0, i).some((e) => e.id === s.grid_from)) {
      issues.push({ code: 'grid_from_invalid', session: s.id })
    }
    const mode = s.kind === 'qualifying' ? 'timed' : s.mode
    if (mode === 'laps' && !(Number.isInteger(s.target_laps) && s.target_laps >= 1 && s.target_laps <= 999)) {
      issues.push({ code: 'laps_invalid', session: s.id })
    }
    if (mode === 'timed' && !(Number.isInteger(s.duration_s) && s.duration_s >= 10 && s.duration_s <= 86400)) {
      issues.push({ code: 'duration_invalid', session: s.id })
    }
    const pen = s.false_start.penalty_s
    if (!(Number.isInteger(pen) && pen >= 0 && pen <= 120)) issues.push({ code: 'penalty_invalid', session: s.id })
  })
  return issues
}

/** Add a chip: trimmed, non-empty, case-insensitive unique, within `max`. */
export function addChip(list: string[], value: string, max: number): string[] {
  const v = value.trim()
  if (!v || list.length >= max || list.some((x) => x.toLowerCase() === v.toLowerCase())) return list
  return [...list, v]
}

/** Program as sent to the backend: qualifying forced to timed, dangling grids cleared. */
export function prepareForSave(p: EventProgram): EventProgram {
  return { ...p, name: p.name.trim(), sessions: cleanGrid(p.sessions.map(normaliseSession)) }
}
