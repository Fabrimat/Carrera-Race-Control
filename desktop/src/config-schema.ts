/**
 * Declarative table of every backend setting the desktop app can configure (the variables of
 * `.env.example` / `AppConfig`). To expose a new variable, add ONE line to FIELDS. The form,
 * validation, storage, spawn env and the `.env` import are all driven by this table, and
 * `npm run check:env` fails when `.env.example` or `AppConfig` has a variable missing here.
 *
 * Pure module (no electron imports): shared by the main process, the preload (types only)
 * and the check script. Validation here mirrors the pydantic rules of backend/app/config.py.
 */

export type Lang = 'en' | 'it'
type Text = { en: string; it: string }

export type GroupId = 'keys' | 'voice' | 'track' | 'simulator' | 'commentary' | 'network' | 'advanced'

export type FieldType = 'secret' | 'text' | 'enum' | 'int' | 'float' | 'list' | 'path'
export type ListItemKind = 'host' | 'origin' | 'fraction'

export interface FieldSpec {
  /** Environment variable name; also the id used everywhere. */
  env: string
  group: GroupId
  type: FieldType
  /** Stored encrypted, never sent to a renderer. Implied by type 'secret'. */
  secret?: boolean
  /** Shown when the field is empty. Display only: an empty field sets no variable. */
  default: string
  enumValues?: readonly string[]
  /** int/float bounds. */
  min?: number
  max?: number
  /** float: value must be > min (pydantic `gt`) instead of >= min. */
  exclusiveMin?: boolean
  /** list: how each item is validated, and the maximum number of items. */
  itemKind?: ListItemKind
  maxItems?: number
  /** path: the file must exist when set. */
  mustExist?: boolean
  label: Text
  help: Text
}

export const GROUPS: ReadonlyArray<{ id: GroupId; title: Text }> = [
  { id: 'keys', title: { en: 'API keys', it: 'Chiavi API' } },
  { id: 'voice', title: { en: 'Voice and models', it: 'Voce e modelli' } },
  { id: 'track', title: { en: 'Track', it: 'Pista' } },
  { id: 'simulator', title: { en: 'Simulator', it: 'Simulatore' } },
  { id: 'commentary', title: { en: 'Commentary', it: 'Commento' } },
  { id: 'network', title: { en: 'Network', it: 'Rete' } },
  { id: 'advanced', title: { en: 'Advanced', it: 'Avanzate' } },
]

const t = (en: string, it: string): Text => ({ en, it })

export const FIELDS = [
  // --- API keys
  { env: 'ELEVENLABS_API_KEY', group: 'keys', type: 'secret', default: '', label: t('ElevenLabs API key', 'Chiave API ElevenLabs'), help: t('Spoken commentary. Without it the commentary is text only.', 'Commento parlato. Senza chiave il commento è solo testo.') },
  { env: 'ANTHROPIC_API_KEY', group: 'keys', type: 'secret', default: '', label: t('Anthropic API key', 'Chiave API Anthropic'), help: t('AI-written commentary lines and track photo recognition.', 'Frasi di commento scritte dall’IA e riconoscimento della pista da foto.') },
  { env: 'OPENAI_API_KEY', group: 'keys', type: 'secret', default: '', label: t('OpenAI API key', 'Chiave API OpenAI'), help: t('OpenAI provider.', 'Provider OpenAI.') },
  // --- Voice and models
  { env: 'ELEVENLABS_VOICE_ID', group: 'voice', type: 'text', default: '', label: t('ElevenLabs voice id', 'ID voce ElevenLabs'), help: t('Default voice (can be changed in the app settings).', 'Voce predefinita (modificabile nelle impostazioni dell’app).') },
  { env: 'ELEVENLABS_MODEL_ID', group: 'voice', type: 'text', default: 'eleven_flash_v2_5', label: t('ElevenLabs model', 'Modello ElevenLabs'), help: t('Text to speech model; the default has the lowest latency.', 'Modello di sintesi vocale; quello predefinito ha la latenza minore.') },
  { env: 'ANTHROPIC_MODEL', group: 'voice', type: 'text', default: 'claude-haiku-5-5', label: t('Anthropic model', 'Modello Anthropic'), help: t('Model that writes the commentary lines.', 'Modello che scrive le frasi di commento.') },
  { env: 'ANTHROPIC_VISION_MODEL', group: 'voice', type: 'text', default: 'claude-opus-5-5', label: t('Anthropic vision model', 'Modello Anthropic per le immagini'), help: t('Turns a photo of the track into a map.', 'Trasforma la foto della pista in una mappa.') },
  { env: 'OPENAI_MODEL', group: 'voice', type: 'text', default: 'gpt-5.4-mini', label: t('OpenAI model', 'Modello OpenAI'), help: t('Model that writes the commentary lines (OpenAI provider).', 'Modello che scrive le frasi di commento (provider OpenAI).') },
  { env: 'OPENAI_VISION_MODEL', group: 'voice', type: 'text', default: 'gpt-5.4', label: t('OpenAI vision model', 'Modello OpenAI per le immagini'), help: t('Turns a photo of the track into a map (OpenAI provider).', 'Trasforma la foto della pista in una mappa (provider OpenAI).') },
  { env: 'OPENAI_VISION_REASONING', group: 'voice', type: 'enum', enumValues: ['none', 'minimal', 'low', 'medium', 'high'], default: 'low', label: t('OpenAI vision reasoning effort', 'Impegno di ragionamento OpenAI (immagini)'), help: t('Reasoning effort of the photo-to-map call.', 'Impegno di ragionamento della chiamata foto-mappa.') },
  // --- Track
  { env: 'TRACK_MODE', group: 'track', type: 'enum', enumValues: ['simulator', 'ble', 'serial'], default: 'simulator', label: t('Connection mode', 'Modalità di connessione'), help: t('Leave empty to keep the mode last used in the app. Only the simulator connects automatically.', 'Lascia vuoto per mantenere l’ultima modalità usata. Solo il simulatore si connette da solo.') },
  { env: 'TRACK_ADDRESS', group: 'track', type: 'text', default: '', label: t('Track address', 'Indirizzo della pista'), help: t('BLE address (AA:BB:CC:DD:EE:FF) or serial port (COM3).', 'Indirizzo BLE (AA:BB:CC:DD:EE:FF) o porta seriale (COM3).') },
  // --- Simulator
  { env: 'SIM_CARS', group: 'simulator', type: 'int', min: 1, max: 6, default: '4', label: t('Simulated cars', 'Auto simulate'), help: t('From 1 to 6.', 'Da 1 a 6.') },
  { env: 'SIM_TIME_SCALE', group: 'simulator', type: 'float', min: 0, exclusiveMin: true, default: '1.0', label: t('Simulator speed', 'Velocità del simulatore'), help: t('1.0 is real time; 20 makes a 3 lap race last a few seconds.', '1.0 è tempo reale; 20 fa durare pochi secondi una gara di 3 giri.') },
  { env: 'SIM_CHECK_LANES', group: 'simulator', type: 'list', itemKind: 'fraction', maxItems: 2, default: '', label: t('Simulated Check Lanes', 'Check Lane simulate'), help: t('Up to two lap fractions between 0 and 1, comma separated, for example 0.33,0.66. Empty means none.', 'Fino a due frazioni di giro tra 0 e 1, separate da virgola, per esempio 0.33,0.66. Vuoto significa nessuna.') },
  { env: 'REPLAY_FILE', group: 'simulator', type: 'path', mustExist: true, default: '', label: t('Replay file', 'File da riprodurre'), help: t('Replay a recorded JSONL session instead of the simulator.', 'Riproduce una sessione JSONL registrata al posto del simulatore.') },
  // --- Commentary
  { env: 'COMMENTARY_LANG', group: 'commentary', type: 'enum', enumValues: ['it', 'en'], default: 'it', label: t('Default commentary language', 'Lingua predefinita del commento'), help: t('Only used the first time; afterwards change it in the app settings.', 'Usata solo la prima volta; poi si cambia nelle impostazioni dell’app.') },
  // --- Network
  { env: 'ALLOWED_HOSTS', group: 'network', type: 'list', itemKind: 'host', default: '127.0.0.1,localhost', label: t('Allowed host names', 'Nomi host consentiti'), help: t('Comma separated. 127.0.0.1 and localhost are always allowed by the desktop app.', 'Separati da virgola. 127.0.0.1 e localhost sono sempre consentiti dall’app desktop.') },
  { env: 'CORS_ORIGINS', group: 'network', type: 'list', itemKind: 'origin', default: 'http://localhost:5173,http://127.0.0.1:5173', label: t('Allowed origins (CORS)', 'Origini consentite (CORS)'), help: t('Comma separated. The app’s own address is always allowed.', 'Separate da virgola. L’indirizzo dell’app è sempre consentito.') },
] as const satisfies readonly FieldSpec[]

/** Variables the app manages itself: shown read-only, never stored, never imported. */
export const MANAGED_ENV = ['DATA_DIR'] as const

export type FieldEnv = (typeof FIELDS)[number]['env']
export type SecretEnv = Extract<(typeof FIELDS)[number], { type: 'secret' }>['env']
export type PlainEnv = Exclude<FieldEnv, SecretEnv>

export function allFields(): readonly FieldSpec[] {
  return FIELDS
}

export function findField(env: string): FieldSpec | undefined {
  return (FIELDS as readonly FieldSpec[]).find((f) => f.env === env)
}

export function isSecret(f: FieldSpec): boolean {
  return f.type === 'secret' || f.secret === true
}

export interface ValidationError {
  code: 'bad_chars' | 'too_long' | 'not_int' | 'not_number' | 'range' | 'enum' | 'item' | 'count' | 'missing_file'
  detail?: string
}

const MESSAGES: Record<ValidationError['code'], Text> = {
  bad_chars: t('Contains characters that are not allowed.', 'Contiene caratteri non consentiti.'),
  too_long: t('Too long.', 'Troppo lungo.'),
  not_int: t('Must be a whole number.', 'Deve essere un numero intero.'),
  not_number: t('Must be a number.', 'Deve essere un numero.'),
  range: t('Out of range', 'Fuori intervallo'),
  enum: t('Must be one of', 'Deve essere uno tra'),
  item: t('Invalid entry', 'Voce non valida'),
  count: t('Too many entries', 'Troppe voci'),
  missing_file: t('File not found.', 'File non trovato.'),
}

export function errorMessage(e: ValidationError, lang: Lang): string {
  const base = MESSAGES[e.code][lang]
  return e.detail ? `${base}: ${e.detail}` : base
}

const HOST_RE = /^[A-Za-z0-9.*_-]+$|^\[[0-9A-Fa-f:]+\]$/

function validateItem(kind: ListItemKind, item: string): boolean {
  if (kind === 'host') return HOST_RE.test(item)
  if (kind === 'origin') {
    try {
      const u = new URL(item)
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== '' && u.origin !== 'null'
    } catch {
      return false
    }
  }
  const n = Number(item)
  return Number.isFinite(n) && n > 0 && n < 1
}

/** Validates a trimmed, non-empty value. Empty values mean "default" and are always valid. */
export function validateValue(f: FieldSpec, value: string): ValidationError | null {
  if (value === '') return null
  if (/[\r\n\0]/.test(value)) return { code: 'bad_chars' }
  if (value.length > 1000) return { code: 'too_long' }
  switch (f.type) {
    case 'secret':
      return value.length > 512 ? { code: 'too_long' } : null
    case 'text':
    case 'path':
      return null
    case 'enum':
      return f.enumValues?.includes(value) ? null : { code: 'enum', detail: (f.enumValues ?? []).join(', ') }
    case 'int': {
      if (!/^[+-]?\d+$/.test(value)) return { code: 'not_int' }
      const n = Number(value)
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
        return { code: 'range', detail: `${f.min} - ${f.max}` }
      }
      return null
    }
    case 'float': {
      const n = Number(value)
      if (!Number.isFinite(n) || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return { code: 'not_number' }
      if (f.min !== undefined && (f.exclusiveMin ? n <= f.min : n < f.min)) {
        return { code: 'range', detail: `${f.exclusiveMin ? '>' : '>='} ${f.min}` }
      }
      if (f.max !== undefined && n > f.max) return { code: 'range', detail: `<= ${f.max}` }
      return null
    }
    case 'list': {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean)
      if (f.maxItems !== undefined && items.length > f.maxItems) return { code: 'count', detail: String(f.maxItems) }
      const bad = items.find((i) => !validateItem(f.itemKind ?? 'host', i))
      return bad === undefined ? null : { code: 'item', detail: bad }
    }
  }
}

/** Normalises a list value the way the backend splits it (trim, drop empties). */
export function normaliseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}
