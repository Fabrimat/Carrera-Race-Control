import { BrowserWindow, screen, type Display } from 'electron'
import { dict } from './i18n'
import { loadPrefs, savePrefs } from './prefs'
import type { DisplayInfo, OpenTvResult } from './shared'

/** Hides the mouse cursor after 3 s without movement. Static, desktop-owned script. */
const HIDE_CURSOR_JS = `(() => {
  if (window.__carreraCursor) return;
  window.__carreraCursor = true;
  let timer;
  const show = () => { document.documentElement.style.cursor = ''; clearTimeout(timer); timer = setTimeout(() => { document.documentElement.style.cursor = 'none'; }, 3000); };
  window.addEventListener('mousemove', show, { passive: true });
  show();
})();`

function displayLabel(d: Display, index: number): string {
  const t = dict()
  const parts = [`${t.displayN} ${index + 1}`]
  const primary = screen.getPrimaryDisplay().id === d.id
  if (primary) parts[0] += ` (${t.displayPrimary})`
  const name = d.label && d.label.trim() ? ` - ${d.label.trim()}` : ''
  return `${parts[0]}${name} ${d.size.width}x${d.size.height}`
}

/** Owns the single TV window and the remembered display choice. */
export class TvWindowManager {
  private win: BrowserWindow | null = null
  private displayId: number | null = null

  constructor(
    private readonly getUrl: () => string | null,
    private readonly preload: string,
    private readonly onShortcut: (win: BrowserWindow, input: Electron.Input) => boolean,
  ) {}

  /** Call once the app is ready (the screen module is not usable before). */
  init(): void {
    screen.on('display-removed', (_e, removed) => this.onDisplayRemoved(removed))
  }

  isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** The display used when none is requested: remembered, else first non-primary, else primary. */
  defaultDisplay(): Display {
    const displays = screen.getAllDisplays()
    const prefs = loadPrefs()
    const byId = displays.find((d) => d.id === prefs.tvDisplayId)
    if (byId) return byId
    const b = prefs.tvDisplayBounds
    if (b) {
      const byBounds = displays.find(
        (d) => d.bounds.x === b.x && d.bounds.y === b.y && d.bounds.width === b.width && d.bounds.height === b.height,
      )
      if (byBounds) return byBounds
    }
    const primary = screen.getPrimaryDisplay()
    return displays.find((d) => d.id !== primary.id) ?? primary
  }

  listDisplays(): DisplayInfo[] {
    const selected = (this.displayId ?? this.defaultDisplay().id)
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: displayLabel(d, i),
      primary: d.id === primary,
      bounds: { ...d.bounds },
      selected: d.id === selected,
    }))
  }

  open(displayId?: number): OpenTvResult {
    const url = this.getUrl()
    if (!url) return { ok: false, error: 'backend_not_ready' }
    let display: Display
    if (displayId === undefined) {
      display = this.displayId !== null && this.isOpen()
        ? (screen.getAllDisplays().find((d) => d.id === this.displayId) ?? this.defaultDisplay())
        : this.defaultDisplay()
    } else {
      const found = screen.getAllDisplays().find((d) => d.id === displayId)
      if (!found) return { ok: false, error: 'no_such_display' }
      display = found
      savePrefs({ tvDisplayId: found.id, tvDisplayBounds: { ...found.bounds } })
    }
    this.displayId = display.id

    if (this.isOpen()) {
      this.moveTo(display)
      this.win?.focus()
      return { ok: true, displayId: display.id }
    }

    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      fullscreen: false,
      backgroundColor: '#000000',
      title: 'Carrera TV',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    this.win = win
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // The TV page only ever shows the sidecar's own UI: block navigation anywhere else.
    const appOrigin = new URL(url).origin
    win.webContents.on('will-navigate', (event, target) => {
      let origin = ''
      try {
        origin = new URL(target).origin
      } catch {
        /* unparsable: block */
      }
      if (origin !== appOrigin) event.preventDefault()
    })
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape' && win.isFullScreen()) {
        win.setFullScreen(false)
        event.preventDefault()
      } else if (this.onShortcut(win, input)) {
        event.preventDefault()
      }
    })
    win.webContents.on('did-finish-load', () => {
      void win.webContents.executeJavaScript(HIDE_CURSOR_JS).catch(() => undefined)
    })
    win.once('ready-to-show', () => {
      win.show()
      win.setFullScreen(true)
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    void win.loadURL(`${url}#/tv`)
    return { ok: true, displayId: display.id }
  }

  close(): void {
    if (this.isOpen()) this.win?.close()
  }

  /** Reload after the backend came back on another port. */
  reload(): void {
    const url = this.getUrl()
    if (this.isOpen() && url) void this.win?.loadURL(`${url}#/tv`)
  }

  private moveTo(display: Display): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.setFullScreen(false)
    win.setBounds(display.bounds)
    win.setFullScreen(true)
  }

  private onDisplayRemoved(removed: Display): void {
    if (!this.isOpen() || this.displayId !== removed.id) return
    const primary = screen.getPrimaryDisplay()
    this.displayId = primary.id
    this.moveTo(primary)
  }
}
