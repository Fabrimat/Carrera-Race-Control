import { contextBridge, ipcRenderer } from 'electron'
import type {
  ConfigImportResult,
  ConfigSaveRequest,
  ConfigSaveResult,
  ConfigWindowState,
  RestartState,
} from './shared'

// Preload of the desktop-owned configuration window only (never attached to app or TV windows).
contextBridge.exposeInMainWorld('configApi', {
  load: (): Promise<ConfigWindowState | null> => ipcRenderer.invoke('config:get'),
  save: (req: ConfigSaveRequest): Promise<ConfigSaveResult> => ipcRenderer.invoke('config:save', req),
  close: (): Promise<void> => ipcRenderer.invoke('config:close'),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke('config:open-data'),
  importEnv: (): Promise<ConfigImportResult> => ipcRenderer.invoke('config:import'),
  onRestartState: (cb: (state: RestartState) => void): void => {
    ipcRenderer.on('config:restart-state', (_e, state: RestartState) => cb(state))
  },
})
