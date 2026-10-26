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
  keys: { elevenlabs: boolean, anthropic: boolean, openai: boolean },  // configured or not; never the values
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
| `llm_unavailable` | 503 | `POST /api/layouts/from-photo` / `POST /api/event/transcribe`: no key for the selected provider, the key / vision model was rejected (HTTP 401, 403, 404), or the provider is unreachable, slow (45 s timeout), throttling (429) or failing (5xx): not the photo's fault, try again later |
| `photo_unrecognised` | 422 | `from-photo`: no closed track found, unusable or too coarse reply, or the API rejected the request (other 4xx) |
| `photo_busy` | 429 | `from-photo`: another photo conversion is already running (one at a time); retry shortly |
| `image_too_large` | 413 | `from-photo`: image larger than 8 MB (decoded); driver photo larger than 2 MB; logo larger than 512 KB |
| `invalid_image` | 422 | `from-photo` / driver photo / logo: not base64, or not JPEG / PNG / WebP (magic bytes checked); for logos also a rejected SVG |
| `transcription_failed` | 422 | `POST /api/event/transcribe`: the provider rejected the audio (other 4xx) or returned no text |
| `import_invalid` | 422 | `POST /api/import`: the bundle is not valid (wrong format, invalid section content); `detail` lists the problems |
| `import_unsupported` | 422 | `POST /api/import`: the bundle `version` is newer than this app supports |
| `logo_not_found` | 404 | unknown logo id |
| `incident_not_found` | 404 | `POST /api/race/incidents/{address}/clear` for a car without an open incident |
| `race_not_running` | 409 | incident report / clear while the race is not RUNNING or PAUSED |
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
selects the commentator's language independently.
`Settings.commentary.llm_provider` (`"anthropic"` default, or `"openai"`) selects which LLM
writes the commentary lines and reads track photos; a fresh settings database picks the
provider whose key exists, preferring Anthropic. REST `detail` messages are
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

`from-photo` sends the image to the selected AI provider (`Settings.commentary.llm_provider`;
Anthropic with `ANTHROPIC_VISION_MODEL`, or OpenAI with `OPENAI_VISION_MODEL` when its key is
configured; if OpenAI is selected without its key, Anthropic is used when its key exists and
the draft `notes` say so, otherwise `llm_unavailable` names OpenAI),
which returns the centre line in driving order. Providers may retain API inputs for a limited
period for abuse monitoring (OpenAI about 30 days, unless zero data retention applies); the UI
notice says so. Errors: `llm_unavailable` (no key or
disabled), `image_too_large` (> 8 MB decoded), `invalid_image`, `photo_unrecognised`
(no closed track found). The UI warns that the photo is sent to the AI provider and always
opens the draft in the editor for correction before saving.

## Event mode

Separates **cars** (controller/car: `CarConfig`, colour, logo, nickname) from **drivers**
(people: `Driver`, a reusable roster). Each session assigns drivers to controller
addresses; `CarState.driver_id` / `driver_name` carry the assignment and every UI shows
`driver_name` when set (else the car's name/nickname). All shapes are in
`backend/app/race/models.py` ("event mode" section).

### Drivers and assignment

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/drivers` | – | `{"drivers": Driver[]}` by name |
| POST | `/api/drivers` | `{"name", "nickname"?, "bio"?}` | `Driver` (id generated) |
| PUT | `/api/drivers/{id}` | `Driver` | `Driver` |
| DELETE | `/api/drivers/{id}` | – | `{"drivers": Driver[]}` (also removes its assignments) |
| PUT | `/api/drivers/{id}/photo` | `{"image_base64", "media_type"}` (≤ 2 MB, jpeg/png/webp) | `Driver` (`has_photo` true) |
| GET | `/api/drivers/{id}/photo` | – | the image (404 if none) |
| DELETE | `/api/drivers/{id}/photo` | – | `Driver` |
| GET | `/api/event/assignments` | – | `{"assignments": {address: driver_id}}` |
| PUT | `/api/event/assignments` | `{"assignments": {address: driver_id \| null}}` | same; merges (only the given addresses change, `null` clears), emits `driver_assigned` (method `manual`). A crossing assignment also removes that driver from any other car. |
| POST | `/api/event/assign-next-crossing` | `{"driver_id"}` | `{"armed": true}` — the next car to cross the start/finish line (while no race is running) gets this driver; emits `driver_assigned` (method `crossing`). One armed driver at a time; `DELETE` same path cancels. Times out after 60 s. |
| POST | `/api/event/transcribe` | `{"audio_base64", "media_type", "language"}` (≤ 2 MB) | `{"text", "name_guess"}` speech-to-text of a spoken name (ElevenLabs STT, or OpenAI if that is the selected provider); errors `llm_unavailable` / `transcription_failed` |

Assignment keys must be addresses 0..5 and existing driver ids (else 422). The armed
driver and its expiry are in `EventState.armed_driver_id` / `armed_until`; arming is
rejected (409 `busy`) while a race is starting, running or paused. The assignment happens
in the controller on a start/finish `Timer` while the phase is idle or finished.

Photos: the type is checked by magic bytes (not only `media_type`), decoded size ≤ 2 MB;
driver ids are generated by the backend (`^[a-z0-9][a-z0-9-]{0,39}$`, the photo file
name) and `PUT /api/drivers/{id}` ignores a different id in the body. Photos are served
with an ETag. Speech-to-text: ElevenLabs Scribe, or OpenAI `gpt-4o-transcribe` when OpenAI
is the selected provider; accepts `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/wav`
(≤ ~15 s); `name_guess` is the id of the roster driver whose name or nickname best
matches the text (similarity ≥ 0.6), else `null`. The UI says the audio is sent to the
provider.

Assignments persist until changed; "new session, same drivers" is one click in the UI.
Driver photos are stored in `DATA_DIR/avatars/` and shown in the TV graphics; there is
no face recognition.

### Event program and sessions

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/programs` | – | `{"programs": EventProgram[]}` |
| PUT | `/api/programs/{id}` | `EventProgram` | `EventProgram` |
| DELETE | `/api/programs/{id}` | – | `{"programs": EventProgram[]}` |
| GET | `/api/event` | – | `EventState` |
| POST | `/api/event/start` | `{"program_id"}` | `EventState` (index 0, results cleared, assignments kept) |
| POST | `/api/event/next` | – | `EventState` (advance to the next session; `/api/race/start` then runs it with its spec) |
| POST | `/api/event/stop` | – | `EventState` (program_id null; results kept until next start) |

While an event is active, `POST /api/race/start` without a body uses the current
`SessionSpec` (mode, laps/duration) and `RaceState.session` is set. When the race
finishes, the classification (laps desc, then total time **including `penalty_ms`**;
qualifying: best valid lap asc) is stored as a `SessionResult`, `session_finished` is
emitted, and the UI offers "next session". `grid_from` shows that session's
classification as the starting order (slot cars have no physical grid; it is shown in
the UI/TV and to the commentator).

`POST /api/event/start` and `/api/event/next` immediately apply the current
`SessionSpec` to the race config, so a START pressed on the Control Unit also runs it.
Qualifying sessions run as `timed` (`duration_s`) and are ranked by best valid lap
(cars without one last); the leaderboard, `race_finished` winner, commentary ("pole")
and the stored result all use that order. In every kind, `penalty_ms` is part of the
ranking (laps desc, then `total_time_ms + penalty_ms`), so the live leaderboard, the
winner and the `SessionResult` agree. A re-run of a session replaces its result.
`grid_from` is display-only and is also given to the commentator ("starts from P2").

False start (`Status.start` 8/9 while starting): the CU itself aborts the sequence,
whatever the rule; it does not say which car jumped. The app infers it: a start/finish
crossing while the countdown shows lights 2..6 marks that car as the candidate (crossings
at light 1 are cars being placed and are ignored). The rule only governs the accounting:
`ignore` (nothing), `warn` (`false_start` event + banner + commentary), `penalty` (adds
`penalty_s` to the candidate, `warn` if there is none), `restart` (the app presses START
again once to rerun the sequence).

`EventProgram.commentary` (event name, location, sponsors, tone, notes, words to avoid)
and the drivers' `bio` are added to the AI commentator's facts; the prompt keeps the
"use only the given facts" rule and the tone selects the style.

### Export / import

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/export` | `{"sections": ["settings","drivers","programs","layouts","records"]}` | `ExportBundle` as a `.json` download (`carrera-rms-<date>.json`) |
| POST | `/api/import` | `{"bundle": ExportBundle, "mode": "merge"\|"replace", "dry_run": bool}` | `{"report": {section: {"added": n, "updated": n, "removed": n}}, "applied": bool}` |

Bundles never contain API keys or driver photos (`has_photo` is imported as false).
Dry run and real import use the same code path inside one SQLite transaction, rolled
back on a dry run, so the report matches what would happen. Imported settings and layouts
pass the same validation as their own endpoints; importing `track` settings never
connects. `records` merge keeps the faster lap; `replace` of drivers also removes
assignments to removed drivers. Unknown future `version` → 422 `import_unsupported`;
invalid content → 422 `import_invalid` with details. `merge` upserts by id/name;
`replace` replaces each included section. The UI always shows the dry-run report before
applying. The desktop app's configuration window has its own export of non-secret
desktop settings.

## Roadmap wave 1

Logos, incidents, fuel strategy and keyboard shortcuts (docs/ROADMAP.md 1–3, 6). Shapes are
in `models.py` ("Roadmap wave 1" fields of `CarConfig`, `CarState`, `RaceConfig`,
`SessionSpec`, `Settings`, plus `Logo`, `Incident`, `FuelStrategy`, `IncidentRules`,
`PitRules` and the events `incident_started`, `incident_cleared`, `pit_missed`). All new
fields have defaults, so older settings, programs and export bundles still load.

### Logos

A library of brand logos; a car points at one with `CarConfig.logo_id` (several cars may
share a logo). The engine copies it to `CarState.logo_id`. Files live in
`DATA_DIR/logos/<id>.<ext>`, metadata (incl. `media_type`) in the store (schema v5, table
`logos`).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/logos` | – | `{"logos": Logo[]}` by name |
| POST | `/api/logos` | `{"name": str, "image_base64": str}` | `Logo` (201) |
| PUT | `/api/logos/{id}` | `{"name": str, "image_base64": str \| null}` | `Logo` (rename, and replace the image when given) |
| GET | `/api/logos/{id}/image` | – | the image, `ETag` + `Cache-Control: no-cache`, 304 on `If-None-Match` |
| DELETE | `/api/logos/{id}` | – | `{"logos": Logo[]}`; cars using it get `logo_id = null` (settings saved) |

- Ids: generated from the name like driver ids (`^[a-z0-9][a-z0-9-]{0,39}$`, unique); any
  other id in a path is `logo_not_found` (no path traversal). A row whose file is missing
  on disk is also `logo_not_found` for the image.
- Images: decoded ≤ 512 KB (`image_too_large`, 413); PNG / JPEG / WebP by magic bytes; or
  SVG, which must be UTF-8 (optional BOM; NUL bytes or another prolog `encoding` are
  `invalid_image`), checked on the parsed tree (stdlib `xml.etree`, no new dependency; the
  parser also refuses any doctype): reject any
  `<!DOCTYPE` / `<!ENTITY` before parsing; root element must be `svg`; reject elements whose
  local name is `script` or `foreignObject`; attributes whose local name starts with `on`;
  any attribute value whose stripped, lower-cased text starts with `javascript:`;
  `href` / `xlink:href` not starting with `#` or `data:image/`; `<style>` text containing
  `@import`, a backslash (CSS escape) or `url(` with a non-`#`/non-`data:` target. Anything else: `invalid_image`
  (422).
- Every image response carries `X-Content-Type-Options: nosniff`; SVG responses (only
  them) also `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`. The API is same-origin with the app, so this CSP (plus showing logos only
  through `<img>`) is the real defence; the tree checks are defence in depth.
- `PUT /api/settings` with a `logo_id` that does not exist: `settings_invalid` (422).
- Export bundles carry `CarConfig.logo_id` but never the images (like photos). On import,
  `logo_id`s that do not exist locally are set to null (so settings stay saveable).
- Logos appear in the leaderboard, TV tower and race history, not on the map dots.
- History results of races saved before this wave lack the new `CarState` fields
  (`logo_id`, `incident*`, `fuel_*`): the UI treats them as null / 0 / [].

### Incidents

**Detection.** Each engine tick while the phase is RUNNING (also while finishing), for
every car that has crossed the line, is not in the pit and not finished, with no open
incident: its *expected time* is `segment_estimates["a>b"]` for the stretch from its
`last_crossing.sensor` to the next sensor in driving order (with no Check Lanes: the
same kind of estimate for the whole lap, `segment_estimates["1>1"]`, an EWMA that ignores a
lap longer than 1.8x the estimate or with a pit stop, so an incident lap does not inflate
the next threshold). No expected time yet → never flagged. Its *watch anchor* is the latest
of: its last counted crossing, its pit exit, the last PAUSED→RUNNING resume, the last
CU resync. A car is **probably off** when `race_now - anchor > overdue_factor × expected`.
After a marshal clear the car is not watched again until its next counted crossing. A
counted crossing is one that updates `last_crossing` (not a double trigger ignored by
`min_lap_ms` / sensor debounce, not an impossible split). If in the same tick *every*
watched car is overdue and at least two cars are watched (a deliberate halt or a CU
hiccup), none is flagged; a sole watched car (solo practice) that is overdue is flagged. Nothing is
detected while PAUSED or STARTING. `position.py`'s `stale` is a display hint (it may borrow
other cars' estimates) and can disagree with incidents.

**Opening.** The engine sets `CarState.incident` (`started_race_ms` = race time of the
detecting tick, or of the marshal report), increments `incidents`, adds
`IncidentRules.penalty_s × 1000` to `penalty_ms` (for both `overdue` and `marshal`
incidents, also with `detect: false`) and emits `incident_started`. `from_sensor` /
`to_sensor` come from the engine's sensor order (1 = line); the controller fills
`Incident.s` (and the event's `s`) with the midpoint of that stretch on the current layout
(wrapping through the line), null without a layout. Rules are `self.config.incidents` in the
engine: the controller already puts `SessionSpec.incidents` (or `settings.race.incidents`)
there for event sessions, and `settings.race` otherwise; no session-rule plumbing is
needed. `detect: false` disables detection only. One open incident per car.

**Clearing.** On the car's next counted crossing (`by: "crossing"`; the crossing still
counts normally), on the marshal's button (`by: "marshal"`), or when the race finishes or
is stopped (`by: "race_end"`, emitted before `race_finished` in the same batch).
`lost_ms` = race time between start and clear, added to `incident_lost_ms`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/race/incidents/{address}` | – | `RaceState` (marshal reports the car off: `source: "marshal"`) |
| POST | `/api/race/incidents/{address}/clear` | – | `RaceState` (marshal: back on track) |

Errors: `race_not_running` (409) unless the phase is RUNNING or PAUSED; `incident_not_found`
(404) clearing a car without an open incident, or an address with no car; reporting a car
that already has one is a no-op returning the state.

**Auto pace car** (`auto_pace_car: true`). Toggling the pace car pauses the engine (phase
PAUSED). When the first incident opens while RUNNING, the controller toggles the CU pace
car once and remembers that it owns it. When the last open incident clears (the phase is
then PAUSED by us), it toggles it back. It also recalls its own pace car when the race
finishes, is stopped or reset. A manual `POST /api/race/pace-car` while ours is out hands
ownership to the user (we stop tracking it). Ownership resets on prepare/reset. A failed
toggle is logged, not raised. Known limit: the CU status has no pace-car flag, so pressing
the pace-car button on the CU itself desyncs this tracking. Not yet verified on the real
CU.

**Simulator.** The simulator gets a deslot model (rarely, a car stops 10–25 s at a point in
a stretch, then continues) and a deterministic method to make a given car deslot, for tests
and demos.

Commentary: `incident_started` is high priority ("Rossi is off at the hairpin!" — use the
driver name, the count when > 1), `incident_cleared` normal. Results (`RaceDetail.results`)
keep `incidents` and `incident_lost_ms`.

### Fuel strategy

Only when the CU is in fuel mode (`RaceState.fuel_mode`); otherwise `fuel_strategy` is
null and `fuel_laps` empty (also if fuel mode turns off mid-race). Levels are the CU's
0..15, so the rate is measured per **stint** (the laps since the race start or the last
pit exit):
- `fuel_laps[i]` = level at the end of lap `i + 1` (`len(fuel_laps) == laps`), null when the
  level was unknown.
- `per_lap = (level at stint start − level now) / laps in the stint`, once the stint has
  ≥ 2 laps and ≥ 1 level drop; until then the previous stint's rate is kept (null in the
  first stint).
- `laps_left = fuel / per_lap` (null if `per_lap` is null or 0).
- `laps_to_go`: LAPS mode, leader-based: `RaceState.remaining_laps` (the race ends when the
  leader completes `target_laps`), so it may overstate by one for a lapped car; TIMED mode
  `ceil(remaining_ms / avg_lap_ms)`; PRACTICE null; 0 while finishing.
- `must_pit = not in_pit and laps_to_go is not None and laps_left is not None and
  laps_left < laps_to_go`; `pit_by_lap = laps + floor(laps_left)` when `must_pit`.

Mandatory pit stops (`self.config.pits`, filled like `incidents`): in LAPS and TIMED mode
only, on any race end (finish or Stop), a car with `pit_stops < min_stops` gets
`(min_stops - pit_stops) × missed_penalty_s × 1000` added to `penalty_ms` and a `pit_missed`
event, before the final order, `race_finished`, the event classification and the history
results. A stop is a counted `pit_stops` entry (a drive-through counts). Commentary: a
`must_pit` car may get a strategy line (at most once per car per race), and `pit_missed` a
normal-priority line. The app never writes fuel values to the CU in this wave.

### Keyboard shortcuts

`Settings.shortcuts` maps an action id to a key combo, overriding the frontend defaults
(`""` disables an action). Combos are `[Ctrl+][Alt+][Shift+]<key>` with `<key>` a
`KeyboardEvent.key` value (single characters upper-case, e.g. `Shift+P`, `Space`, `Escape`,
`F2`, `+`). Normalisation from a `KeyboardEvent` (works on IT and US layouts): letters →
upper case with an explicit `Shift+` when shift is held; other printable characters → the
produced character with Shift ignored (`?`, `+`); non-printable keys (`F1`..`F12`, arrows,
`Space` for `" "`, `Escape`, `Enter`, `Backspace`, `Delete`) keep all modifiers; `Dead`,
`Unidentified`, `Process` and Meta combos are ignored; Ctrl+Alt (AltGr) combos are not
allowed; browser-reserved combos (Ctrl+R/W/N/T, F5, F11, F12) are not allowed. The backend
checks in `settings_errors()` (so the code is `settings_invalid`): at most 100 entries, ids
and combos ≤ 40 characters. Action ids, defaults, conflict detection and the `?` help
overlay live in the frontend. Shortcuts never fire while typing in an input, textarea,
select or contenteditable, nor while a modal other than the help overlay is open; Space /
Enter on a focused button, link or `[role=button]` are left to that element; handled
combos call `preventDefault`. Destructive actions (stop, reset, disconnect) default to
combos with a modifier (e.g. `Ctrl+Shift+R`).

## Roadmap wave 2

Controller settings and pairing (docs/ROADMAP.md §4 and the CU fuel writes of §3), webcam
tracking prototype (§1), responsive layouts (§5). Shapes in `models.py`:
`ControllerSettings`, `CarConfig.controller`, `Driver.controller`, `PairingState`,
`RaceState.pairing`, `CarPaired` (`car_paired`), `ControllerStatus`, `GarageCar`. All new
fields have defaults. Everything is testable on the simulator; the real CU is tested at the
end of the roadmap.

### Controller settings (speed, brake, fuel)

The CU keeps a speed, brake and fuel value (raw 0..15) per controller, written with
carreralib `setspeed` / `setbrake` / `setfuel` (`setword` 0 / 1 / 2, repeat 2). The CU
does not report them back. Their exact effect on the real CU (direction of the scale, tank
level vs consumption for fuel) is **to be verified on the track**; the UI shows the raw
0..15 value with that note.

- `TrackInterface` gains `set_speed(address, value)`, `set_brake(address, value)`,
  `set_fuel(address, value)` and `press_code()` (CU CODE button, `CODE_BUTTON_ID`). They
  go through the same command queue as `start()`; values outside 0..15 or addresses
  outside 0..5 raise `ValueError` before anything is sent.
- **Effective settings** per address: start from `CarConfig.controller`; if a driver is
  assigned to that address (event mode) and `Driver.controller` is set, each of its
  non-null fields replaces the car's. Null fields are never written.
- **When the controller writes**: on connect (after the first Status), after
  `PUT /api/settings`, after a driver (un)assignment or a driver profile change, and on
  `POST /api/controllers/apply`. Never while the race is STARTING, RUNNING or PAUSED:
  changes made then stay `pending` and are written when the race finishes or is reset.
  Only fields that differ from the last successful write (`applied`) are sent, except
  on connect, when everything non-null is sent (the CU may have been power-cycled). A
  failed write is logged and leaves the address `pending`; it is never raised to the
  request that triggered it.
- **Simulator**: speed scales the car's pace (15 = unchanged, each step below adds 4 %
  to its lap time), brake is accepted and ignored, fuel sets the car's tank level
  immediately (an assumption, documented in `simulator.py`).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/controllers` | – | `{"controllers": ControllerStatus[]}` addresses 0..5 |
| POST | `/api/controllers/apply` | – | same, after writing every pending address (409 `not_connected` without a track; 409 `busy` during a race) |

Driver profiles are edited through the existing `PUT /api/drivers/{id}` (field
`controller`); car settings through `PUT /api/settings` (`cars[].controller`).

### Pairing (car ↔ controller)

Carrera coding: press CODE on the CU, put the car on the track and press the lane-change
button on the controller it should answer to. The app drives that from a wizard:

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/pairing` | `{"target_address": 0..5, "car": CarConfig}` | `PairingState` (phase `waiting`); presses CODE once |
| DELETE | `/api/pairing` | – | `PairingState` (phase `cancelled`) or 404 `not_found` if none |

- Allowed only with a connected track (409 `not_connected`) and while the race is IDLE or
  FINISHED (409 `busy`); a second POST while `waiting` replaces the first (CODE is pressed
  again). `car.address` is ignored and set to `target_address`.
- While `waiting` (60 s, `expires_at`), the first sensor-1 crossing of any address
  completes it: `detected_address` is set, phase `paired`, event `car_paired` with
  `matches_target = detected == target`, and the `car` profile (name, colour, nickname,
  logo, controller settings) is stored in settings at the **detected** address (replacing
  that car), then its controller settings are written. That crossing is not a lap (no
  race is running). After 60 s: phase `timeout`. A failing CODE press: phase `failed`.
- `RaceState.pairing` carries the state while `waiting` and for 10 s after it ended (so the
  UI can show the result), then null. Not persisted.
- Simulator: `press_code()` is accepted; the next crossing pairs (any car), so the flow is
  testable end to end.

### Garage

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/garage` | – | `{"cars": GarageCar[]}` one per configured car, by address |

Stats come from the race history (store): races the address took part in (it has at least
one lap), total laps, all-time best valid lap and its layout.

### Webcam tracking (prototype)

Frontend only in this wave, no new dependency, video never leaves the browser.
- Page `#/camera`: source = a webcam (`getUserMedia`) or a **simulated camera** that renders
  the live race (layout path + car dots from the live positions) into a canvas with a
  perspective tilt, lighting gradient and noise, so everything is testable on the
  simulator.
- Calibration: the user clicks 4+ points on the image and matches them to points of the
  current layout (start line first); a homography (DLT, normalised) maps image → layout
  coordinates; the reprojection error is shown. Stored per layout name in `localStorage`
  (key `carrera.camera.<layout>`), exportable as JSON.
- Car signatures: per car, click it in the frame (or drive it past) to sample a colour
  signature (hue/saturation histogram, robust to brightness).
- Tracking: downscaled frames (e.g. 320 px wide) at up to 15 fps; background model
  (running average) for motion, then colour matching per car, blob centroid → homography →
  nearest point of the layout path (`s`); outliers (jumps backwards beyond a tolerance, off
  the path beyond a distance) are rejected. Stats per car: detection rate, last seen, fps.
- Output: a client store slice `camera` (per address: `s`, `seen_at`, `off_path`) that the
  dashboard and TV `TrackMap` use, while fresh (< 500 ms), instead of the estimated `s`
  (dot drawn as "measured"). Sending positions or camera incidents to the backend is a
  later wave.

### Responsive layouts

One shared breakpoint module for the dashboard and TV mode. The 16:9 layouts at 1920×1080
and 1366×768 stay as they are (no scrolling). Added: ultrawide (21:9) and 4K (bigger map,
more columns), tablet landscape and portrait (touch-sized controls, collapsible panels),
and phones as a **pit wall** (race controls, leaderboard and latest commentary; map on
tap).
