/** Three-character timing-tower codes derived from the car name or nickname. */

export interface CodeSource {
  address: number
  name: string
  nickname: string | null
}

const clean = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()

/** Ordered candidate codes for one car; the first one still free wins. */
function candidates(label: string, address: number): string[] {
  const text = clean(label)
  const letters = text.replace(/[^A-Z]/g, '')
  const trailing = /(\d{1,2})\s*$/.exec(text)?.[1]
  const out: string[] = []
  if (trailing && letters.length >= 2) out.push(`${letters.slice(0, 2)}${trailing.slice(-1)}`)
  if (letters.length >= 3) {
    out.push(letters.slice(0, 3))
    const consonants = letters.slice(1).replace(/[AEIOU]/g, '')
    if (consonants.length >= 2) out.push(letters[0] + consonants.slice(0, 2))
    out.push(letters[0] + letters.slice(-2))
    for (let i = 3; i < letters.length; i++) out.push(letters.slice(0, 2) + letters[i])
  }
  const stem = (letters + 'XXX').slice(0, 2)
  for (let n = 1; n <= 9; n++) out.push(`${stem}${n}`)
  out.push(`P${String((address + 1) % 100).padStart(2, '0')}`)
  return out
}

/**
 * Unique 3-character codes for a race. Cars are processed in address order so the result
 * does not depend on the input order, and a code never changes mid-race.
 */
export function deriveDriverCodes(cars: CodeSource[]): Map<number, string> {
  const used = new Set<string>()
  const result = new Map<number, string>()
  for (const c of [...cars].sort((a, b) => a.address - b.address)) {
    const label = (c.nickname?.trim() || c.name || '').trim()
    let code = candidates(label, c.address).find((k) => !used.has(k))
    for (let n = 0; !code; n++) {
      const k = `Z${String(n).padStart(2, '0')}`
      if (!used.has(k)) code = k
    }
    used.add(code)
    result.set(c.address, code)
  }
  return result
}
