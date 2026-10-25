/**
 * Types and constants shared by the main process, the preloads and (as types only) the
 * renderers. This file must stay free of runtime imports: sandboxed preloads cannot require
 * anything except `electron`.
 */

export type Lang = 'en' | 'it'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  /** Friendly, localized label, e.g. "Display 2 (HP E24) 1920x1080". */
  label: string
  primary: boolean
  bounds: Bounds
  /** True for the display the TV window uses (or would use) by default. */
  selected: boolean
}

import type { FieldType, PlainEnv, SecretEnv } from './config-schema'

export interface OpenTvResult {
  ok: boolean
  displayId?: number
  error?: string
}

/** What a page can learn about the configuration: non-secret values, booleans for secrets. */
export interface ConfigStatus {
  encryptionAvailable: boolean
  /** Stored non-secret values ('' = not set, the default applies). */
  values: Record<PlainEnv, string>
  /** Secrets: true when stored. The values never leave the main process. */
  secrets: Record<SecretEnv, boolean>
  /** Managed by the app, read-only. */
  dataDir: string
}

export interface ConfigFieldView {
  env: string
  type: FieldType
  label: string
  help: string
  default: string
  enumValues?: readonly string[]
  min?: number
  max?: number
  /** Secrets: stored or not. Non-secrets: value !== ''. */
  configured: boolean
  /** Non-secrets only. */
  value?: string
}

/** Payload of the configuration window (desktop-owned page). Secret values are never included. */
export interface ConfigWindowState {
  lang: Lang
  encryptionAvailable: boolean
  dataDir: string
  strings: Record<string, string>
  groups: Array<{ id: string; title: string; fields: ConfigFieldView[] }>
}

export interface ConfigSaveRequest {
  /** Non-secret variable -> value. Empty = not set (default). Unknown names are ignored. */
  values: Record<string, string>
  /** Secrets typed in the window: new value. Missing or empty = keep what is stored. */
  secrets: Record<string, string>
  /** Secrets to delete. */
  clear: string[]
}

export interface ConfigSaveResult {
  ok: boolean
  error?: 'encryption_unavailable' | 'invalid' | 'write_failed' | 'forbidden'
  errors?: Array<{ env: string; message: string }>
}

export interface ConfigImportResult {
  ok: boolean
  canceled?: boolean
  imported?: number
  skipped?: string[]
  error?: string
}

export type RestartState = 'restarting' | 'ready' | 'failed'
