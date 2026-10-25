import { contextBridge, ipcRenderer } from 'electron'
import type { ConfigStatus, DisplayInfo, OpenTvResult } from './shared'

// Sandboxed preload: only `electron` may be required at runtime (types are erased).
const openConfig = (): Promise<void> => ipcRenderer.invoke('desktop:open-config')

const api = {
  isDesktop: true as const,
  openTvWindow: (displayId?: number): Promise<OpenTvResult> =>
    ipcRenderer.invoke('desktop:open-tv', typeof displayId === 'number' ? displayId : undefined),
  listDisplays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('desktop:list-displays'),
  closeTvWindow: (): Promise<void> => ipcRenderer.invoke('desktop:close-tv'),
  /** Opens the desktop-owned Configuration window. Takes no values: they are typed there. */
  openConfig,
  /** Same as openConfig (kept for the original name). */
  setKeys: openConfig,
  /** Non-secret values plus booleans for secrets. Secret values never reach the page. */
  getConfigStatus: (): Promise<ConfigStatus | null> => ipcRenderer.invoke('desktop:get-config-status'),
}

contextBridge.exposeInMainWorld('carreraDesktop', api)
