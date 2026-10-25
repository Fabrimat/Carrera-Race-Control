import type { Lang } from './shared'

const en = {
  appName: 'Carrera Race Control',
  menuFile: 'File',
  menuView: 'View',
  menuWindow: 'Window',
  menuHelp: 'Help',
  openTv: 'Open TV window',
  openTvOn: 'Open TV window on...',
  closeTv: 'Close TV window',
  restartBackend: 'Restart backend',
  openDataFolder: 'Open data folder',
  openLogsFolder: 'Open logs folder',
  quit: 'Quit',
  reload: 'Reload',
  fullscreen: 'Toggle full screen',
  devTools: 'Developer tools',
  displayPrimary: 'primary',
  displayN: 'Display',
  startingTitle: 'Starting...',
  startingText: 'Starting the race server.',
  errorTitle: 'The race server is not running',
  errorText: 'It stopped unexpectedly. Restarting automatically...',
  failedText: 'The race server could not be started.',
  noDisplay: 'No such display.',
  config: 'Configuration...',
  importEnv: 'Import from .env file...',
  configTitle: 'Configuration',
  configIntro:
    'Everything the race server reads from the environment is set here. Empty fields use the default. Secrets are encrypted by Windows, never shown again and only handed to the race server.',
  configSecretSet: 'Configured',
  configSecretUnset: 'Not configured',
  configReplace: 'Type a new key to replace it',
  configClear: 'Remove',
  configReset: 'Reset to default',
  configDefault: 'Default',
  configDefaultNone: 'none',
  configDataDir: 'Data folder',
  configDataDirHelp: 'Managed by the app (database and speech cache).',
  configOpenFolder: 'Open folder',
  configImport: 'Import from .env file...',
  configSave: 'Save and restart server',
  configCancel: 'Close',
  configRestarting: 'Restarting the race server...',
  configRestarted: 'Saved. The race server is running again.',
  configRestartFailed: 'Saved, but the race server did not restart yet. It keeps retrying.',
  configUnavailable: 'Secure storage is not available on this system, so secrets cannot be saved.',
  configInvalid: 'Some values are not valid. Fix the fields marked in red.',
  configWriteFailed: 'Could not save the configuration.',
  importTitle: 'Import from .env file',
  importDone: 'Imported variables: {n}. Secrets were stored encrypted; the file was not kept.',
  importSkipped: 'Skipped (invalid or managed by the app): {list}',
  importNone: 'No known variables found in that file.',
  importFailed: 'Could not import the file.',
} as const

export type Dict = Record<keyof typeof en, string>

const it: Dict = {
  appName: 'Carrera Race Control',
  menuFile: 'File',
  menuView: 'Visualizza',
  menuWindow: 'Finestra',
  menuHelp: 'Aiuto',
  openTv: 'Apri finestra TV',
  openTvOn: 'Apri finestra TV su...',
  closeTv: 'Chiudi finestra TV',
  restartBackend: 'Riavvia il server',
  openDataFolder: 'Apri cartella dati',
  openLogsFolder: 'Apri cartella log',
  quit: 'Esci',
  reload: 'Ricarica',
  fullscreen: 'Schermo intero',
  devTools: 'Strumenti sviluppatore',
  displayPrimary: 'principale',
  displayN: 'Schermo',
  startingTitle: 'Avvio in corso...',
  startingText: 'Avvio del server di gara.',
  errorTitle: 'Il server di gara non è attivo',
  errorText: 'Si è fermato in modo imprevisto. Riavvio automatico...',
  failedText: 'Impossibile avviare il server di gara.',
  noDisplay: 'Schermo non trovato.',
  config: 'Configurazione...',
  importEnv: 'Importa da file .env...',
  configTitle: 'Configurazione',
  configIntro:
    'Qui si imposta tutto ciò che il server di gara legge dall’ambiente. I campi vuoti usano il valore predefinito. I segreti sono cifrati da Windows, non vengono più mostrati e sono passati solo al server di gara.',
  configSecretSet: 'Configurata',
  configSecretUnset: 'Non configurata',
  configReplace: 'Scrivi una nuova chiave per sostituirla',
  configClear: 'Rimuovi',
  configReset: 'Ripristina predefinito',
  configDefault: 'Predefinito',
  configDefaultNone: 'nessuno',
  configDataDir: 'Cartella dati',
  configDataDirHelp: 'Gestita dall’app (database e cache vocale).',
  configOpenFolder: 'Apri cartella',
  configImport: 'Importa da file .env...',
  configSave: 'Salva e riavvia il server',
  configCancel: 'Chiudi',
  configRestarting: 'Riavvio del server di gara...',
  configRestarted: 'Salvato. Il server di gara è di nuovo attivo.',
  configRestartFailed: 'Salvato, ma il server di gara non è ancora ripartito. Continua a riprovare.',
  configUnavailable: 'L’archivio sicuro non è disponibile su questo sistema, quindi i segreti non possono essere salvati.',
  configInvalid: 'Alcuni valori non sono validi. Correggi i campi in rosso.',
  configWriteFailed: 'Impossibile salvare la configurazione.',
  importTitle: 'Importa da file .env',
  importDone: 'Variabili importate: {n}. I segreti sono stati salvati cifrati; il file non è stato conservato.',
  importSkipped: 'Ignorate (non valide o gestite dall’app): {list}',
  importNone: 'Nessuna variabile nota trovata in quel file.',
  importFailed: 'Impossibile importare il file.',
}

const dicts: Record<Lang, Dict> = { en, it }

let current: Lang = 'en'

export function langFromLocale(locale: string): Lang {
  return locale.toLowerCase().startsWith('it') ? 'it' : 'en'
}

export function setLang(lang: Lang): void {
  current = lang
}

export function getLang(): Lang {
  return current
}

export function t(key: keyof Dict): string {
  return dicts[current][key]
}

export function dict(): Dict {
  return dicts[current]
}
