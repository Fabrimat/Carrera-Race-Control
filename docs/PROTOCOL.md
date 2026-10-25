# Backend ⇄ frontend protocol

Source of truth for JSON shapes: `backend/app/race/models.py` (pydantic, field
names go over the wire unchanged, datetimes are ISO 8601 strings, times are
integer milliseconds). The frontend mirrors them in `frontend/src/lib/types.ts`.

Backend listens on `http://127.0.0.1:8000`. In dev, Vite (port 5173) proxies
`/api` and `/ws` to it.

## REST

All bodies are JSON. Errors: non-2xx with `{"detail": "<human readable message>"}`.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/state` | – | `Snapshot` |
| GET | `/api/track/scan` | – | `{"devices": [{"address": str, "name": str \| null, "kind": "ble" \| "serial"}]}` |
| POST | `/api/connect` | `{"mode": "simulator"\|"ble"\|"serial", "address": str \| null}` | `ConnectionInfo` |
| POST | `/api/disconnect` | – | `ConnectionInfo` |
| POST | `/api/race/start` | `RaceConfig` (optional, defaults to settings.race) | `RaceState` |
| POST | `/api/race/stop` | – | `RaceState` |
| POST | `/api/race/reset` | – | `RaceState` |
| POST | `/api/race/pace-car` | – | `RaceState` |
| GET | `/api/settings` | – | `SettingsResponse` |
| PUT | `/api/settings` | `Settings` | `SettingsResponse` |
| GET | `/api/races` | – | `{"races": RaceSummary[]}` newest first |
| GET | `/api/races/{id}` | – | `RaceDetail` |
| GET | `/api/races/{id}/export?format=csv\|json` | – | file download |
| GET | `/api/commentary/{line_id}/audio` | – | `audio/mpeg` stream (404 if none) |
| POST | `/api/commentary/mute` | `{"muted": bool}` | `{"muted": bool}` |

Shapes not defined in models.py:

```ts
ConnectionInfo = {
  status: "disconnected" | "connecting" | "connected" | "error",
  mode: "simulator" | "ble" | "serial",
  address: string | null,
  error: string | null,          // English, for logs/tooltips, e.g. "Control Unit busy: close the Carrera app"
  error_code: "busy" | "not_found" | "permission" | "bluetooth_off" | "timeout" | "unknown" | null,
                                 // stable code the UI translates (TrackError.code)
}
Snapshot = {
  connection: ConnectionInfo,
  race: RaceState,
  commentary: CommentaryLine[],  // last 50, oldest first
  muted: boolean,
}
SettingsResponse = Settings & {
  keys: { elevenlabs: boolean, anthropic: boolean },  // configured or not; never the values
}
RaceSummary = {
  id: number, started_at: string, finished_at: string | null,
  mode: RaceMode, winner_name: string | null, laps: number, best_lap_ms: number | null,
}
RaceDetail = RaceSummary & {
  config: RaceConfig,
  results: CarState[],                // final standings, by position
  laps: Lap[],                        // every lap, chronological
}
```

## Internationalisation

User-facing text exists in English (`en`) and Italian (`it`). The backend never
sends UI strings: it sends codes (`error_code`, event `type`, enums) and the
frontend translates them with its own dictionaries (`frontend/src/i18n/`).
`Settings.ui_language` selects the UI language; `Settings.commentary.language`
selects the commentator's language independently. REST `detail` messages are
English and meant for logs; the UI shows a translated message keyed on HTTP
status / known codes, falling back to `detail`. Commentary text is produced
in the selected language by the backend (`templates_en.py`, `templates_it.py`).

## WebSocket `/ws`

Server → client only (commands go through REST). Every message is
`{"type": <string>, "data": <payload>}`.

| type | data | when |
|---|---|---|
| `snapshot` | `Snapshot` | immediately on connect, and after reconnect |
| `state` | `RaceState` | whenever race state changes, throttled to max 10/s |
| `connection` | `ConnectionInfo` | on every connection status change |
| `event` | `RaceEvent` (discriminated by `type`) | every domain event |
| `commentary` | `CommentaryLine` | each line the director decides to speak/show |
| `commentary_stop` | `{"id": str}` | a higher-priority line interrupts the one playing |
| `muted` | `{"muted": bool}` | mute toggled |

The client reconnects with backoff (1s, 2s, 4s, max 10s) and relies on the
`snapshot` to resync. Audio: when a `commentary` line has `audio_url`, the
browser plays it (HTMLAudioElement routed through a Web Audio GainNode for
volume) unless muted or audio output is set to `local`. Only one line plays at
a time; `commentary_stop` stops it.
