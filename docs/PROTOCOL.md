# Backend ⇄ frontend protocol

Source of truth for JSON shapes: `backend/app/race/models.py` (pydantic, field
names go over the wire unchanged, datetimes are ISO 8601 strings, times are
integer milliseconds). The frontend mirrors them in `frontend/src/lib/types.ts`.

Backend listens on `http://127.0.0.1:8000`. In dev, Vite (port 5173) proxies
`/api` and `/ws` to it.

## REST

All bodies are JSON. Errors: non-2xx with `{"detail": "<English message>", "code": "<code>"}`.
`detail` is a string (for request validation errors, code `invalid_request`, it is
FastAPI's list of problems); `code` is stable and translated by the UI (see "Error codes").

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
| GET | `/api/records` | – | `{"records": TrackRecordInfo[]}` one per layout, by layout name |
| DELETE | `/api/records/{layout}` | – | `{"records": TrackRecordInfo[]}` after removing that layout's record (404 `record_not_found` if none) |

Track records: the all-time best *valid* lap per `settings.track.layout`. The
controller compares every valid `LapCompleted` with the stored record; when it
is beaten it saves the new record and emits a `track_record` event (after the
`lap_completed` / `best_lap` events of the same crossing). `RaceState.track_record`
always carries the record of the current layout.

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
RaceDetail = Omit<RaceSummary, "laps"> & {   // `laps` is the lap list here, not the count
  config: RaceConfig,
  results: CarState[],                // final standings, by position
  laps: Lap[],                        // every lap, chronological
}
```

## Error codes

| code | HTTP | when |
|---|---|---|
| `not_connected` | 409 | race / pace-car command without a connected track |
| `address_required` | 422 | `POST /api/connect` in `ble`/`serial` mode without an address |
| `connect_failed` | 503 | connecting failed for an unclassified reason |
| `connect_cancelled` | 409 | a pending connect was aborted by `POST /api/disconnect` |
| `busy`, `not_found`, `permission`, `bluetooth_off`, `timeout` | 409 (`busy`) / 503 | connecting failed; the track's `TrackError.code`, same values as `ConnectionInfo.error_code` |
| `start_failed` | 503 | the CU did not accept the start command (the race is not started) |
| `pace_car_failed` | 503 | the CU did not accept the pace car command |
| `settings_invalid` | 422 | `PUT /api/settings`: more than 8 cars, duplicate addresses, name > 40 chars, color not `#RRGGBB` |
| `layout_invalid` | 422 | `PUT /api/layouts/{name}`: name differs from the URL, points outside 0..1, repeated consecutive points, path length <= 0.5, duplicate sensor numbers, sensors less than 0.01 of the lap apart or from the line |
| `race_not_found` | 404 | unknown race id (detail / export) |
| `record_not_found` | 404 | `DELETE /api/records/{layout}` for a layout without a record |
| `audio_not_found` | 404 | no audio for that commentary line |
| `layout_not_found` | 404 | unknown layout name (`GET` / `DELETE /api/layouts/{name}`) |
| `llm_unavailable` | 503 | `POST /api/layouts/from-photo`: no Anthropic key, the key / vision model was rejected (HTTP 401, 403, 404), or Anthropic is unreachable, slow (45 s timeout), throttling (429) or failing (5xx): not the photo's fault, try again later |
| `photo_unrecognised` | 422 | `from-photo`: no closed track found, unusable or too coarse reply, or the API rejected the request (other 4xx) |
| `photo_busy` | 429 | `from-photo`: another photo conversion is already running (one at a time); retry shortly |
| `image_too_large` | 413 | `from-photo`: image larger than 8 MB (decoded) |
| `invalid_image` | 422 | `from-photo`: not base64, or not JPEG / PNG / WebP (magic bytes checked) |
| `invalid_request` | 422 | the request body / query does not match the schema |
| `forbidden_origin` | 403 | cross-origin state-changing request (see "Security") |

The UI looks up `error.<code>` (then `connError.<code>`) and falls back to `detail`.

## Security

The API is unauthenticated and meant for `127.0.0.1`. POST/PUT/PATCH/DELETE requests are
refused with 403 (`forbidden_origin`) when `Origin` is present and is neither the server's
own origin nor in `CORS_ORIGINS` (default: the Vite dev server), or when
`Sec-Fetch-Site: cross-site`. `/ws` closes the handshake (1008) for such origins. Requests
without `Origin` (curl, scripts) are allowed. Only `Host` names in `ALLOWED_HOSTS` are
answered (400 otherwise).

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

## Sectors and track map

### Sectors (Check Lane sensors)

The CU reports Check Lane crossings as `Timer.sector` 2 or 3 (1 = start/finish).
Sector *i* is the stretch that ends at the *i*-th sensor in driving order (with both
Check Lanes: S1 line→2, S2 2→3, S3 3→line). `RaceState.num_sectors` = 1 + Check Lanes
declared in the current layout or seen during the race. The engine emits a
`sector_completed` event per finished sector (`personal_best` / `overall_best` flags);
`CarState.current_sectors`, `last_sectors`, `best_sectors` and `RaceState.best_sectors`
carry the splits. Without Check Lanes nothing changes (`num_sectors` = 1).

### Coordinates

`TrackLayout.points` are normalised 0..1 in both axes; `aspect` = width/height. Every
fraction `s` along the lap (sensors, `pit_s`, `TrackPosition`) is measured by path
length in display space: the points scaled to `(x * aspect, y)`. Frontend code must
scale the points first and then use the geometry helpers on the scaled points.

### Live position estimate

Every car has `last_crossing` (sensor + race time) and `segment_estimates` (learned
expected ms per stretch, key `"a>b"`). When the current layout has a map, the backend
also fills `CarState.track_pos` (see `TrackPosition` in models.py) and the browser
animates the dot between `s_from` and `s_to` with its own clock, re-synchronised on
every `state` message (`RaceState.race_time_ms` at send time). The dot never passes the
next sensor before the CU reports it; `confidence: "stale"` (overdue by a wide margin)
is shown dimmed. Cars in the pit are drawn at `pit_s`. If a car's last sensor is a Check
Lane the layout does not declare, the position falls back to its last start/finish
crossing (`total_time_ms`) and the next declared sensor, or a full lap.

### REST

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/layouts` | – | `{"layouts": TrackLayout[]}` by name |
| GET | `/api/layouts/{name}` | – | `TrackLayout` (404 `layout_not_found`) |
| PUT | `/api/layouts/{name}` | `TrackLayout` (name must match) | `TrackLayout` (422 `settings_invalid` on bad geometry) |
| DELETE | `/api/layouts/{name}` | – | `{"layouts": TrackLayout[]}` (404 `layout_not_found`) |
| POST | `/api/layouts/from-photo` | `{"image_base64": str, "media_type": "image/jpeg"\|"image/png"\|"image/webp", "name": str, "language": "en"\|"it"}` | `LayoutDraft` (not saved) |

`from-photo` sends the image to the Anthropic API (vision model, `ANTHROPIC_VISION_MODEL`),
which returns the centre line in driving order. Errors: `llm_unavailable` (no key or
disabled), `image_too_large` (> 8 MB decoded), `invalid_image`, `photo_unrecognised`
(no closed track found). The UI warns that the photo is sent to Anthropic and always
opens the draft in the editor for correction before saving.
