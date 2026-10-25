/**
 * Type declaration for the bridge the Electron preload exposes to the web app.
 *
 * Copy or reference this file from the frontend (e.g. `frontend/src/carrera-desktop.d.ts`)
 * and guard every use with `window.carreraDesktop?.isDesktop`: in a normal browser the object
 * does not exist.
 *
 *   {window.carreraDesktop?.isDesktop && (
 *     <button onClick={() => void window.carreraDesktop!.openTvWindow()}>{t('openTvWindow')}</button>
 *   )}
 */

export {}

declare global {
  interface CarreraDisplayInfo {
    /** Electron display id, pass it to openTvWindow(). */
    id: number
    /** Friendly label in the desktop shell's language, e.g. "Display 2 - HP E24 1920x1080". */
    label: string
    primary: boolean
    bounds: { x: number; y: number; width: number; height: number }
    /** The display the TV window uses (or will use) by default. */
    selected: boolean
  }

  interface CarreraOpenTvResult {
    ok: boolean
    displayId?: number
    /** 'backend_not_ready' | 'no_such_display' | 'forbidden' */
    error?: string
  }

  /**
   * Configuration as the page may see it. Non-secret variables are returned with their value
   * ('' = not set, the default applies); secrets (`*_API_KEY`) are booleans only: their values
   * never leave the desktop app. The field table lives in desktop/src/config-schema.ts.
   */
  interface CarreraConfigStatus {
    /** False when the OS secure storage is unavailable: secrets cannot be saved. */
    encryptionAvailable: boolean
    values: {
      ELEVENLABS_VOICE_ID: string
      ELEVENLABS_MODEL_ID: string
      ANTHROPIC_MODEL: string
      ANTHROPIC_VISION_MODEL: string
      OPENAI_MODEL: string
      OPENAI_VISION_MODEL: string
      OPENAI_VISION_REASONING: string
      TRACK_MODE: string
      TRACK_ADDRESS: string
      SIM_CARS: string
      SIM_TIME_SCALE: string
      SIM_CHECK_LANES: string
      REPLAY_FILE: string
      COMMENTARY_LANG: string
      ALLOWED_HOSTS: string
      CORS_ORIGINS: string
    }
    secrets: {
      ELEVENLABS_API_KEY: boolean
      ANTHROPIC_API_KEY: boolean
      OPENAI_API_KEY: boolean
    }
    /** Read-only, managed by the app. */
    dataDir: string
  }

  interface CarreraDesktop {
    isDesktop: true
    /**
     * Opens the TV window (`/#/tv`, fullscreen, frameless) on the given display, or on the
     * remembered / default display (first non-primary, else primary) when omitted. A given id
     * is remembered. Only one TV window exists: calling again moves it.
     */
    openTvWindow(displayId?: number): Promise<CarreraOpenTvResult>
    /** Displays with friendly labels, for a chooser. */
    listDisplays(): Promise<CarreraDisplayInfo[]>
    closeTvWindow(): Promise<void>
    /** Opens the desktop Configuration window (keys, models, track, simulator, network...). Takes no values: they are typed there, not in the page. */
    openConfig(): Promise<void>
    /** Alias of openConfig(). */
    setKeys(): Promise<void>
    /** Null if the caller is not the app page. */
    getConfigStatus(): Promise<CarreraConfigStatus | null>
  }

  interface Window {
    carreraDesktop?: CarreraDesktop
  }
}
