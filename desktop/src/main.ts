import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  dialog,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { BackendSidecar } from './backend'
import { dict, getLang, langFromLocale, setLang, t } from './i18n'
import { GROUPS, FIELDS, isSecret, type FieldSpec } from './config-schema'
import { dataDir, getConfigStatus, importDotenv, saveConfig } from './config'
import type {
  ConfigImportResult,
  ConfigSaveRequest,
  ConfigSaveResult,
  ConfigWindowState,
  RestartState,
} from './shared'
import { TvWindowManager } from './tv'

// Test/isolation hook: a separate profile (own single-instance lock, keys and data).
if (process.env.CARRERA_USER_DATA) app.setPath('userData', process.env.CARRERA_USER_DATA)

const sidecar = new BackendSidecar()
let mainWindow: BrowserWindow | null = null
let configWindow: BrowserWindow | null = null
let quitting = false

const PRELOAD = path.join(__dirname, 'preload.js')
const CONFIG_PRELOAD = path.join(__dirname, 'config-preload.js')
const ASSETS = path.join(__dirname, 'assets')

const WEB_PREFS = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
} as const

function appUrl(): string | null {
  return sidecar.state === 'ready' ? sidecar.origin : null
}

const tv = new TvWindowManager(appUrl, PRELOAD, (win, input) => handleShortcut(win, input))

function isTvShortcut(input: Electron.Input): 'toggle' | 'close' | null {
  if (!input.control || !input.shift || input.alt || input.meta) return null
  const key = input.key.toLowerCase()
  if (key === 't') return 'toggle'
  if (key === 'w') return 'close'
  return null
}

/** Ctrl+Shift+T opens the TV window (or closes it if open), Ctrl+Shift+W closes it. */
function handleShortcut(_win: BrowserWindow, input: Electron.Input): boolean {
  const which = isTvShortcut(input)
  if (!which) return false
  if (which === 'close' || tv.isOpen()) tv.close()
  else tv.open()
  return true
}

function statusPage(state: 'starting' | 'error' | 'failed', detail?: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  void mainWindow.loadFile(path.join(ASSETS, 'status.html'), {
    query: { state, lang: getLang(), detail: detail ?? '' },
  })
}

function isAppOrigin(url: string): boolean {
  try {
    return new URL(url).origin === sidecar.origin
  } catch {
    return false
  }
}

function hardenWebContents(wc: Electron.WebContents, allowFile: boolean): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (isAppOrigin(url) || (allowFile && url.startsWith('file:'))) return
    event.preventDefault()
  })
}

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d10',
    title: t('appName'),
    webPreferences: { ...WEB_PREFS, preload: PRELOAD },
  })
  mainWindow = win
  hardenWebContents(win.webContents, false) // loadFile(status.html) is main-initiated
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && handleShortcut(win, input)) event.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('closed', () => {
    mainWindow = null
    // Closing the main window ends the app (and with it the TV window and the backend).
    app.quit()
  })
  statusPage('starting')
}

function openConfigWindow(): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 760,
    height: 780,
    parent: mainWindow ?? undefined,
    title: t('configTitle'),
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    webPreferences: { ...WEB_PREFS, preload: CONFIG_PRELOAD },
  })
  configWindow = win
  win.setMenuBarVisibility(false)
  hardenWebContents(win.webContents, true)
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => {
    if (configWindow === win) configWindow = null
  })
  void win.loadFile(path.join(ASSETS, 'config.html'))
}

function notifyRestart(state: RestartState): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.webContents.send('config:restart-state', state)
  }
}

async function importFromEnvFile(): Promise<ConfigImportResult> {
  const parent = configWindow && !configWindow.isDestroyed() ? configWindow : (mainWindow ?? undefined)
  const opts: Electron.OpenDialogOptions = {
    title: t('importTitle'),
    properties: ['openFile'],
    filters: [{ name: '.env', extensions: ['env', '*'] }],
  }
  const picked = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
  let text: string
  try {
    text = fs.readFileSync(picked.filePaths[0], 'utf8')
  } catch {
    return { ok: false, error: t('importFailed') }
  }
  const outcome = importDotenv(text, getLang())
  if (!outcome.result.ok) return { ok: false, error: t('importFailed') }
  if (outcome.imported > 0) {
    notifyRestart('restarting')
    void sidecar.restart()
  }
  return { ok: true, imported: outcome.imported, skipped: outcome.skipped }
}

async function importMenu(): Promise<void> {
  const res = await importFromEnvFile()
  if (res.canceled) return
  const lines = res.ok
    ? [
        (res.imported ? t('importDone') : t('importNone')).replace('{n}', String(res.imported ?? 0)),
        ...(res.skipped?.length ? [t('importSkipped').replace('{list}', res.skipped.join(', '))] : []),
      ]
    : [res.error ?? t('importFailed')]
  await dialog.showMessageBox({ type: res.ok ? 'info' : 'error', title: t('importTitle'), message: lines.join(String.fromCharCode(10)) })
}

function buildMenu(): void {
  const displays = tv.listDisplays()
  const template: MenuItemConstructorOptions[] = [
    {
      label: t('menuFile'),
      submenu: [
        { label: t('config'), click: () => openConfigWindow() },
        { label: t('importEnv'), click: () => void importMenu() },
        { label: t('restartBackend'), click: () => void sidecar.restart() },
        { type: 'separator' },
        { label: t('openDataFolder'), click: () => void shell.openPath(sidecar.dataDir()) },
        { label: t('openLogsFolder'), click: () => void shell.openPath(sidecar.logsDir()) },
        { type: 'separator' },
        { label: t('quit'), role: 'quit' },
      ],
    },
    {
      label: t('menuView'),
      submenu: [
        { label: t('reload'), role: 'reload' },
        { label: t('fullscreen'), role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ label: t('devTools'), role: 'toggleDevTools' } as const]),
      ],
    },
    {
      label: t('menuWindow'),
      submenu: [
        {
          label: t('openTv'),
          accelerator: 'CommandOrControl+Shift+T',
          registerAccelerator: false, // handled in before-input-event so it also works in the TV window
          click: () => (tv.isOpen() ? tv.close() : void tv.open()),
        },
        {
          label: t('openTvOn'),
          submenu: displays.map((d) => ({
            label: d.label,
            type: 'radio' as const,
            checked: d.selected,
            click: () => void tv.open(d.id),
          })),
        },
        {
          label: t('closeTv'),
          accelerator: 'CommandOrControl+Shift+W',
          registerAccelerator: false,
          click: () => tv.close(),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Only pages served by our own backend (or the desktop-owned windows) may use the IPC. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  return isAppOrigin(url)
}

function fromConfigWindow(event: IpcMainInvokeEvent): boolean {
  return (
    configWindow !== null &&
    !configWindow.isDestroyed() &&
    event.sender === configWindow.webContents &&
    (event.senderFrame?.url ?? '').startsWith('file:')
  )
}

function configState(): ConfigWindowState {
  const lang = getLang()
  const status = getConfigStatus()
  const secrets = status.secrets as Record<string, boolean>
  const values = status.values as Record<string, string>
  const view = (f: FieldSpec) => ({
    env: f.env,
    type: f.type,
    label: f.label[lang],
    help: f.help[lang],
    default: f.default,
    ...(f.enumValues ? { enumValues: f.enumValues } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    configured: isSecret(f) ? Boolean(secrets[f.env]) : Boolean(values[f.env]),
    ...(isSecret(f) ? {} : { value: values[f.env] ?? '' }),
  })
  return {
    lang,
    encryptionAvailable: status.encryptionAvailable,
    dataDir: status.dataDir,
    strings: { ...dict() },
    groups: GROUPS.map((g) => ({
      id: g.id,
      title: g.title[lang],
      fields: (FIELDS as readonly FieldSpec[]).filter((f) => f.group === g.id).map(view),
    })).filter((g) => g.fields.length > 0),
  }
}

function registerIpc(): void {
  ipcMain.handle('desktop:open-tv', (e, displayId?: unknown) => {
    if (!fromApp(e)) return { ok: false, error: 'forbidden' }
    return tv.open(typeof displayId === 'number' ? displayId : undefined)
  })
  ipcMain.handle('desktop:list-displays', (e) => (fromApp(e) ? tv.listDisplays() : []))
  ipcMain.handle('desktop:close-tv', (e) => {
    if (fromApp(e)) tv.close()
  })
  ipcMain.handle('desktop:open-config', (e) => {
    if (fromApp(e)) openConfigWindow()
  })
  ipcMain.handle('desktop:get-config-status', (e) => (fromApp(e) ? getConfigStatus() : null))

  ipcMain.handle('config:get', (e): ConfigWindowState | null => (fromConfigWindow(e) ? configState() : null))
  ipcMain.handle('config:save', (e, req: ConfigSaveRequest): ConfigSaveResult => {
    if (!fromConfigWindow(e)) return { ok: false, error: 'forbidden' }
    const result = saveConfig(req, getLang())
    if (result.ok) {
      notifyRestart('restarting')
      void sidecar.restart()
    }
    return result
  })
  ipcMain.handle('config:close', (e) => {
    if (fromConfigWindow(e)) configWindow?.close()
  })
  ipcMain.handle('config:open-data', (e) => {
    if (fromConfigWindow(e)) void shell.openPath(dataDir())
  })
  ipcMain.handle('config:import', (e) => (fromConfigWindow(e) ? importFromEnvFile() : { ok: false }))
}

async function syncLanguageFromApp(): Promise<void> {
  try {
    const res = await fetch(`${sidecar.origin}/api/settings`, { signal: AbortSignal.timeout(3000) })
    const body = (await res.json()) as {
      ui_language?: string
      settings?: { ui_language?: string }
    }
    const lang = body.ui_language ?? body.settings?.ui_language
    if (lang === 'it' || lang === 'en') {
      setLang(lang)
      buildMenu()
    }
  } catch {
    // keep the OS locale
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    setLang(langFromLocale(app.getLocale()))
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    tv.init()
    registerIpc()
    buildMenu()
    screen.on('display-added', buildMenu)
    screen.on('display-removed', buildMenu)
    createMainWindow()

    let lastPort = 0
    sidecar.on('ready', (port: number) => {
      notifyRestart('ready')
      buildMenu()
      if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(`${sidecar.origin}/`)
      if (lastPort !== 0) tv.reload() // the server restarted: reload to reconnect cleanly
      lastPort = port
      void syncLanguageFromApp()
    })
    sidecar.on('down', (reason: string) => {
      notifyRestart('failed')
      statusPage('error', reason)
    })
    sidecar.start()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    if (process.env.CARRERA_DEBUG) console.log('before-quit: stopping backend')
    void sidecar.stop().finally(() => {
      if (process.env.CARRERA_DEBUG) console.log('backend stopped, exiting')
      app.exit(0)
    })
  })
}
