# Roadmap wave 1 — shared context (read first)

Repo C:\Users\Fabrizio\Repos\Carrera (Windows, Git Bash). Backend:
`cd backend && .venv/Scripts/python -m pytest -q -p no:cacheprovider`, lint
`.venv/Scripts/python -m ruff check app tests && .venv/Scripts/python -m ruff format --check app tests`
(in a worktree without `.venv`: `uv sync` then `uv run python -m pytest ...`). Frontend
(pnpm via `npx -y pnpm@9`, corepack is broken): `npx -y pnpm@9 install` (worktree),
`npx -y pnpm@9 exec tsc -b`, `npx -y pnpm@9 test`, `npx -y pnpm@9 lint`.

CONTRACTS (head-written, commit 2048c1e + the "wave 1 contract fixes" commit) — DO NOT change them; report problems instead:
- `docs/PROTOCOL.md` section "Roadmap wave 1" (READ IT FULLY) and the new error codes in
  "Error codes".
- `backend/app/race/models.py`: `IncidentRules`, `PitRules`, `RaceConfig.incidents/pits`,
  `CarConfig.logo_id`, `Incident`, `FuelStrategy`, the "Roadmap wave 1" fields of
  `CarState`, events `IncidentStarted`, `IncidentCleared`, `PitMissed`,
  `Settings.shortcuts`, `Logo`, `SessionSpec.incidents/pits`.
- `frontend/src/lib/types.ts` mirrors them. `EventLog.describeEvent` already handles the
  three new events.
- i18n: `frontend/src/i18n/en.ts` + `it.ts` (it is typed against en, must match). Four
  reserved blocks at the bottom: logos / incidents / fuel strategy / keyboard shortcuts.
  Add your keys ONLY in your block (other blocks belong to other arms).

Engine hooks are pre-stubbed in the contract (`backend/app/race/engine.py`, end of file:
`_check_incidents`, `_clear_incident`, `_close_incidents_at_end`, `_apply_pit_penalties`,
`_record_fuel_lap`, `_update_fuel_strategy`, with their call sites already in `tick`,
`_on_timer`, `_finish_race`, `_on_status`; `_Car` fields and the new `CarState(...)`
kwargs in `_car_state` are filled). Fill the bodies of YOUR hooks; add other call sites
only where your brief needs them. Rules: the engine reads `self.config.incidents` /
`self.config.pits` (the controller's `_session_config` already applies the session
override); do NOT change `set_session_rules` / `_apply_session_rules`.

Paths: pages in `frontend/src/pages/` (Dashboard, SettingsPage, TvMode, History),
`frontend/src/components/event/ProgramEditor.tsx`, controller `backend/app/service.py`,
routes `backend/app/api/routes.py` (`settings_errors()`).

Merge order (head): K → L → IB → F → IF.

Existing patterns to reuse: driver photos (`backend/app/avatars.py`,
`backend/app/api/routes_drivers.py`, `frontend/src/lib/photo.ts`, `DriverAvatar.tsx`),
store migrations (`backend/app/race/store.py` `_MIGRATIONS`), effective session rules
(`service.py` `_apply_session_rules`, `_session_config`), TV banners
(`frontend/src/lib/tvBanners.ts`, `components/tv/useBanners.ts`), commentary templates
(`backend/app/commentary/templates_en.py` / `templates_it.py`, `events.py`, `context.py`).

Facts: real Carrera Control Unit over BLE, 6 controllers (addresses 0..5), start/finish =
sensor 1, Check Lanes = sensors 2 and 3; the simulator (`backend/app/track/simulator.py`)
simulates fuel, pits and Check Lanes. The 16:9 dashboard must fit 1920×1080 and 1366×768
without scrolling.

User rules: every user-facing text in English AND Italian; code/comments/docs English;
no new dependencies (ask in the report); never log or expose API keys; tests alongside
code; NEVER commit (the head commits). A live server may run on port 8000 from a
scratchpad folder `carrera-live`: never touch port 8000 or that folder, never run
`test:e2e` (the head runs it). Don't kill processes you did not start.

Report at the end: files changed, what each does, how to verify, anything you could not do.

---

## Brief L — Car brand logos, full stack  [sonnet, worktree]

Goal: PROTOCOL "Roadmap wave 1" → "Logos", end to end.
- Backend: store schema v5 (`logos` table: id, name, json) with migration + store methods;
  a `LogoStore` for files in `DATA_DIR/logos/` (reuse/generalise `avatars.py` atomic
  write, ETag); new router `backend/app/api/routes_logos.py` wired in `main.py`; image
  validation per PROTOCOL (magic bytes, SVG checks via `xml.etree.ElementTree` / defusedxml
  is NOT available — use stdlib with a size cap and reject DOCTYPE/ENTITY to avoid entity
  expansion); response headers per PROTOCOL; controller methods; `settings_invalid` for an
  unknown `logo_id` on PUT /api/settings; deleting a logo clears it from cars and saves
  settings; engine/controller copies `CarConfig.logo_id` into `CarState.logo_id`; error
  codes added to the backend `ErrorCode` literal.
- Frontend: `api.ts` client methods + `api.logoUrl(id, version)`; a "Logos" section in
  Settings (upload PNG/JPEG/WebP/SVG ≤ 512 KB with a client-side size check, rename,
  delete with confirm) and a logo picker per car in the cars settings; a `CarLogo`
  component (img, alt = logo name, fallback = nothing / colour swatch) shown in the
  Leaderboard, TV tower and race history detail (NOT on map dots). Import nulls unknown
  `logo_id`s (`bundle.py` / `refresh_after_import`). Errors translated
  (`error.logo_not_found`, etc.).
Acceptance: backend tests for CRUD, validation (each magic type, SVG with script/on*/
javascript:/foreignObject/DOCTYPE/external href/@import rejected, oversize), headers
(nosniff everywhere, CSP only on SVG) and 304, id path traversal → 404, missing file →
404, migration v4→v5 on an existing DB, settings validation, delete clears cars, export
carries `logo_id`, import with unknown `logo_id` nulls it; frontend
vitest for the upload/picker and the leaderboard showing a logo; tsc + lint + all tests
green; dashboard still no-scroll.
Verify: backend pytest + ruff; `npx -y pnpm@9 exec tsc -b && npx -y pnpm@9 test && npx -y pnpm@9 lint`.
Skills: frontend-design:frontend-design (match the dark race-control style).
Constraints: logos only rendered via `<img>`; no new dependency; don't touch incident /
fuel / shortcut code. Shared files (Leaderboard, TvTower, TrackMap, SettingsPage,
service.py, engine.py): keep edits minimal and localized.

## Brief IB — Incidents, backend  [sonnet, worktree]

Goal: PROTOCOL "Roadmap wave 1" → "Incidents", backend side.
- Engine (`backend/app/race/engine.py`): fill `_check_incidents`, `_clear_incident`,
  `_close_incidents_at_end` exactly per PROTOCOL "Incidents" (watch anchor incl. pit exit,
  resume from PAUSED, resync; no re-watch after marshal clear until the next counted
  crossing; all-cars-overdue rule; nothing while PAUSED); wire `_clear_incident` also into
  `_on_sensor` after its debounce; marshal report/clear engine methods.
- Controller fills `Incident.s` / event `s` from the layout (midpoint of the stretch).
- Simulator (`backend/app/track/simulator.py`): deslot model + deterministic
  `deslot(address, seconds)` method per PROTOCOL.
- Controller + routes: the two marshal endpoints (in `backend/app/api/routes.py` next to
  pace-car), error codes `race_not_running`, `incident_not_found` added to the backend
  literal; auto pace car exactly per PROTOCOL (recall from PAUSED-by-us, recall on
  finish/stop/reset, manual pace-car hands ownership to the user, reset on prepare,
  failures logged).
  Race history results keep the new CarState fields (check `_persist`).
- Commentary: en + it templates for `incident_started` (with/without count > 1; place from
  sensors when known, e.g. "between sector 2 and 3") and `incident_cleared`; priority per
  PROTOCOL; LLM facts include incidents per car (context.py).
Acceptance: unit tests — no flag without estimate, flag after factor × expected, not in
pit / finished / paused, clear on crossing (lap still counted) and on a Check Lane
crossing, clear by marshal, clear at race end (`incident_cleared(race_end)` before
`race_finished` in the same batch, penalties reflected in `race_finished.order`), lost_ms,
penalty applied for overdue and marshal, session rules override, detect=false, no re-flag
after marshal clear / pit exit / resume / resync, all-cars-stopped flags none, auto pace car
toggles exactly once each way, recalls from PAUSED, not when not deployed by us, ownership
handed over on manual toggle, reset on prepare/reset; simulator deslot produces an
incident end to end through the controller; endpoints + error codes; existing tests green;
ruff clean.
Verify: backend pytest + ruff.
Constraints: backend only. Don't touch fuel/pit-rule code (brief F) or logos (brief L);
engine.py and service.py are shared with F and L — keep your changes in clearly separated
methods.

## Brief IF — Incidents, frontend  [sonnet, worktree]

Goal: PROTOCOL "Roadmap wave 1" → "Incidents", UI side (build against the contract and
fixtures; the backend arrives in parallel).
- `api.ts`: `reportIncident(address)`, `clearIncident(address)`; errors translated
  (`error.race_not_running`, `error.incident_not_found`).
- Dashboard: a **marshal call** panel that appears when any car has `incident` (car colour,
  driver/car name, place "sector 2 → 3" or "near the line", elapsed time since
  `started_race_ms`, big "Back on track" button) and, in the leaderboard row, a small
  "report off" action and an incident badge (count). Must keep the 16:9 no-scroll layout
  (overlay/slide-in panel is fine).
- TrackMap: an "OFF" marker (yellow) at `incident.s` for cars with an open incident
  (dashboard and TV maps), instead of the animated dot.
- TV mode: yellow-flag banner on `incident_started` (driver name, place), short
  "back on track" banner on `incident_cleared`; tower marks cars with an open incident.
- Toast on the dashboard for `incident_started`.
- Rules UI (for BOTH incidents and pits, one consistent UX): `RaceConfig.incidents`
  (detect, factor, auto pace car with a note that it moves the real pace car, penalty s)
  and `RaceConfig.pits` (mandatory stops, penalty s per missing stop) in Settings (race
  section), and per session in the ProgramEditor (inherit from settings, or override).
- History views treat missing new fields of old races as 0 / null / [].
- History detail: incidents and time lost per car.
Acceptance: vitest for marshal panel (appears / clear calls api), tv banners for the two
events, TrackMap OFF marker, rules editors round-trip; tsc + lint + tests green; en+it
strings in the incidents block; keyboard accessible; dashboard no-scroll at 1366×768.
Verify: `npx -y pnpm@9 exec tsc -b && npx -y pnpm@9 test && npx -y pnpm@9 lint`.
Skills: frontend-design:frontend-design.
Constraints: frontend only. Shared files with L/F/K (Leaderboard, Dashboard, TrackMap,
TvMode, SettingsPage, ProgramEditor): minimal, localized edits.

## Brief F — Fuel strategy and mandatory pit stops, full stack  [sonnet, worktree]

Goal: PROTOCOL "Roadmap wave 1" → "Fuel strategy".
- Backend engine: fill `_record_fuel_lap`, `_update_fuel_strategy`, `_apply_pit_penalties`
  exactly per PROTOCOL "Fuel strategy" (stint-based per_lap, leader-based laps_to_go,
  `lap_pit` / stint tracking on pit entry/exit, penalties in LAPS/TIMED on finish AND Stop,
  none in PRACTICE). Commentary en+it:
  `pit_missed` line and a rate-limited strategy line for `must_pit` (at most once per car
  per race); LLM facts include laps_left / must_pit.
- Frontend: a compact strategy view on the dashboard (per car: fuel bar, laps left,
  "must pit by lap N" warning) that fits the 16:9 no-scroll layout (e.g. a tab or toggle
  in an existing panel, shown only in fuel mode); a fuel-over-laps chart (reuse the
  existing chart approach in `LapChart.tsx` / `LazyLapChart.tsx`, no new dependency) in the
  dashboard or race history detail; `pit_missed` toast + TV banner. (The pit RULES editor
  is built by brief IF, not here.)
Acceptance: backend unit tests (`len(fuel_laps) == laps`, stint per_lap with quantised
levels and carry-over after a pit, laps_left, leader-based laps_to_go in LAPS incl. a lapped
car, TIMED, PRACTICE, 0 while finishing, must_pit false in pit, pit_by_lap, strategy null
without fuel mode and when it turns off mid-race, pit penalty changes order + winner +
classification, penalty on Stop in LAPS/TIMED and none in PRACTICE, session override via
config, commentary rate limit); frontend vitest for the strategy view; all suites + lint
green.
Verify: backend pytest + ruff; frontend tsc + test + lint.
Skills: frontend-design:frontend-design.
Constraints: never write fuel to the CU. engine.py / service.py shared with IB and L;
frontend shared files minimal and localized.

## Brief K — Keyboard shortcuts  [sonnet, worktree]

Goal: PROTOCOL "Roadmap wave 1" → "Keyboard shortcuts" and ROADMAP §6.
- Backend: validation of `Settings.shortcuts` in `settings_errors()` (entries ≤ 100,
  id/combo ≤ 40 chars → `settings_invalid`) + test. Nothing else.
- Combo normalisation, ignored keys, disallowed combos, focused-button rule,
  preventDefault and modifier-only destructive defaults exactly per PROTOCOL.
- "Jump to next/previous car" = move focus to the next/previous leaderboard row's name
  control (so F2 renames it).
- Frontend: `lib/shortcuts.ts` (action registry with ids, default combos, i18n label keys,
  combo parsing/normalising from `KeyboardEvent`, conflict detection); one global listener
  (hook in `App.tsx`) that ignores inputs/textarea/select/contenteditable and open modals;
  actions: race start (same path as the Start button), stop, reset, pace car, mode cycle,
  laps/duration +/-, connect/disconnect, scan, commentary mute, volume +/-, effects on/off,
  LLM on/off, repeat last line, navigate to dashboard/history/settings/track editor/
  drivers/event, TV mode (desktop: open the TV window via `lib/desktop.ts` if it exposes
  that, else navigate), fullscreen, jump to next/previous car in the leaderboard; reuse the
  existing handlers/store actions rather than duplicating logic; `?` opens a help overlay
  listing all shortcuts in the UI language; a Settings section to rebind (press-to-record),
  disable, reset to default, with conflict warnings, saved in `Settings.shortcuts`.
Acceptance: vitest for parsing/normalising (incl. `+` and `?` from an IT-layout event,
AltGr rejected), conflict detection, listener ignores inputs and modals, Escape in a
modal does not stop the race, Space on a focused button fires once, a couple of actions
dispatching, overlay renders translated; tsc + lint + tests green.
Verify: backend pytest + ruff; frontend tsc + test + lint.
Constraints: no global (OS-level) shortcuts in the desktop app this wave. Shared files
(App.tsx, SettingsPage): minimal, localized.
