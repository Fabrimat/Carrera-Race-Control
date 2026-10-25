# Carrera Race Control: project plan

Local app to control a Carrera Digital 124/132 slot car track from a PC over Bluetooth LE (Carrera AppConnect), with a live web dashboard and an AI race commentator voiced by ElevenLabs.

## Goals

1. Connect to the Control Unit (CU) over BLE (serial as fallback) using `carreralib`.
2. Turn raw `poll()` data into race events (laps, best lap, gaps, pit, fuel, start/finish).
3. Show everything in a real-time web UI (leaderboard, lap times, race controls).
4. Add a commentator: events become short spoken lines via ElevenLabs TTS.
5. Everything must work without a track through a simulator, so development never depends on the hardware.

## Non-goals (for now)

- No remote/cloud hosting, accounts or multi-user. Local only.
- No steering of cars (carreralib reads timing and controls start/pace; it does not drive cars).
- No mobile app. The UI is responsive but desktop first.

## Stack

- **Backend**: Python 3.11+, FastAPI, asyncio, WebSocket for live events, REST for commands. Python is required because `carreralib` is Python.
- **Frontend**: React + TypeScript + Vite, Tailwind, a small state store (Zustand), Recharts for lap charts.
- **Storage**: SQLite (SQLModel or plain sqlite3) for races, laps and settings.
- **Voice**: ElevenLabs official Python SDK, streaming TTS.
- **LLM (optional, phase 5)**: Anthropic API for commentary variety. Must be behind an interface so it can be disabled.
- **Tooling**: uv or poetry, ruff, pytest, pnpm.

## Repository layout

```
carrera-rms/
  backend/
    app/
      main.py              # FastAPI app, lifespan, websocket
      config.py            # settings via pydantic-settings, .env
      track/
        base.py            # TrackInterface (Protocol): connect, poll, start, set_pace, close
        carrera.py         # carreralib adapter (BLE + serial)
        simulator.py       # fake CU producing realistic Timer/Status data
      race/
        models.py          # Car, Lap, RaceState, Event (pydantic)
        engine.py          # consumes raw polls, emits domain events
        store.py           # SQLite persistence
      commentary/
        events.py          # event -> commentary candidates
        templates_it.py    # Italian templates, several variants per event
        director.py        # priority queue, cooldowns, drops stale lines
        llm.py             # optional LLM writer (interface + Anthropic impl)
        tts.py             # ElevenLabs streaming client
      api/
        routes.py          # REST: connect, start, stop, reset, settings
        ws.py              # WebSocket broadcast hub
    tests/
  frontend/
    src/
      pages/               # Dashboard, History, Settings
      components/          # Leaderboard, LapChart, RaceControls, CarCard, CommentaryFeed
      lib/                 # ws client, api client, audio player
  README.md
  .env.example
```

## Phase 0: scaffolding and simulator

- Create the repo, backend and frontend skeletons, lint and test setup.
- Define `TrackInterface` and implement `SimulatorTrack` first.
- Simulator: up to 6 cars, per-car base lap time with random variance, emits `Timer(address, timestamp, sector)` and `Status(fuel, start, mode, pit, display)` shaped like carreralib output.
- Acceptance: `pytest` passes and a script prints simulated laps in the console.

## Phase 1: real track connection

- Read the `carreralib` docs (carreralib.readthedocs.io) and source to confirm: BLE address format, whether a scan step is needed, the poll loop contract, timestamp units. Do not guess these.
- Implement `CarreraTrack` adapter: connect over BLE with serial fallback, reconnect with backoff, clean shutdown.
- `poll()` is blocking, so run it in a dedicated thread and bridge to asyncio with a queue.
- Add a BLE scan helper (CLI command and API endpoint) to find the CU.
- Note: the CU usually accepts one BLE connection at a time, so the official phone app must be closed. Show a clear error in the UI if connection fails.
- Acceptance: with the real track, laps appear in the console with correct timing.

## Phase 2: race engine

- Consume raw events and maintain `RaceState`: per car lap count, last lap, best lap, average, position, gap to leader and to car ahead, fuel, pit status.
- Ignore the first pass over the line per car as the start, filter impossible lap times (too short means a double trigger), handle cars joining mid-race.
- Emit domain events: `RaceStarted`, `LapCompleted`, `BestLap`, `PositionChange` (overtake estimate), `PitEntry`, `PitExit`, `LowFuel`, `RaceFinished`, `Idle`.
- Overtakes are estimates from line crossings and sectors, so mark them as `approximate`.
- Race modes: free practice, timed race, N laps. Configurable.
- Persist races and laps in SQLite.
- Acceptance: unit tests with scripted timestamp sequences cover each event.

## Phase 3: API and UI

Backend:
- `GET /api/state` snapshot, `POST /api/connect`, `POST /api/disconnect`, `POST /api/race/start`, `POST /api/race/stop`, `POST /api/race/reset`, `GET/PUT /api/settings`, `GET /api/races` history.
- `WS /ws` pushes `state` snapshots and `event` messages. Send a full snapshot on connect, then deltas.

Frontend (desktop first, dark theme, big readable numbers since it may run on a TV):
- **Dashboard**
  - Connection bar: status, device picker (scan), connect/disconnect, simulator toggle.
  - Race controls: mode (practice, laps, timed), start, stop, reset.
  - Leaderboard: position, car color/name, laps, last lap, best lap (purple when overall best), gap to leader, fuel bar, pit badge. Animated position changes.
  - Lap chart: lap time per lap per car (Recharts).
  - Commentary feed: text of each spoken line, with a mute button and volume.
- **History**: list of past races, open one to see results and lap chart.
- **Settings**: car names and colors, commentary on/off, language, voice, verbosity, ElevenLabs and optional LLM keys status (never display keys).
- Fullscreen "TV mode" showing only the leaderboard and the latest commentary line.
- Acceptance: with the simulator, a full race runs end to end in the browser with no console errors.

## Phase 4: commentator with ElevenLabs

- `director.py` decides what gets spoken:
  - Priority per event type (overtake and race start/finish high, routine laps low).
  - Cooldown between lines, max queue length, drop stale lines (older than a few seconds for fast events).
  - Never speak over itself: one line at a time, a high priority line can interrupt a low priority one.
- Start with Italian templates, 3 to 5 variants per event, filled with car names and times in natural spoken form (say "un minuto e dodici" style, not raw milliseconds).
- `tts.py`: ElevenLabs streaming TTS. Check the current SDK docs for model, voice id and streaming API, and pick the lowest latency model suitable for Italian. Cache audio for repeated static phrases on disk.
- Audio delivery: backend streams audio chunks to the browser over WebSocket or an HTTP stream, and the frontend plays them with the Web Audio API. Keep local playback as an alternative behind a setting.
- Handle API errors, rate limits and missing key gracefully: fall back to text only in the feed.
- Add a monthly/session character budget setting to control cost.
- Acceptance: with the simulator, the commentator speaks sensibly through a whole race without overlapping.

## Phase 5: LLM commentary (optional)

- `llm.py` interface `write_line(event, context) -> str`, with an Anthropic implementation and a template fallback.
- Prompt: persona of an enthusiastic Italian race commentator, max 1 or 2 short sentences, use only the facts provided, no invented data.
- Run the LLM only for low priority color commentary. Fast events keep using templates to avoid latency.
- Hard timeout (about 1.5 s): if exceeded, use a template.
- Acceptance: toggling the LLM on or off never breaks the flow.

## Phase 6: polish

- Reconnection UX, error toasts, graceful shutdown.
- Export race results to CSV/JSON.
- Optional: sound effects, per-car announcer nicknames, track record tracking.
- README with setup, hardware notes (AppConnect requirement), and troubleshooting BLE on Windows, macOS and Linux.

## Configuration (.env)

```
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ANTHROPIC_API_KEY=        # optional
TRACK_MODE=simulator      # simulator | ble | serial
TRACK_ADDRESS=            # BLE address or serial port
COMMENTARY_LANG=it
```

## Testing strategy

- Unit tests for the engine with deterministic timestamp scripts.
- Property tests for lap filtering (no negative or zero laps, monotonic timestamps).
- A recorded-session replay: save raw polls from a real race to a file and replay them through the engine in tests.
- Frontend: component tests for the leaderboard and one Playwright smoke test against the simulator.

## Risks and notes

- BLE stack differs per OS. Test on the real target OS early (Phase 1).
- Timestamp units and wraparound must be verified from `carreralib`, not assumed.
- TTS latency makes real-time commentary of fast events hard, hence templates and a priority director.
- Carrera and AppConnect are trademarks of Carrera Toys GmbH. This is an unofficial tool.

## Working agreement for Claude Code

- Work phase by phase, commit after each phase, keep the simulator working at all times.
- Ask before adding dependencies beyond the stack above.
- Write tests alongside the code. Do not mock the engine in engine tests.
- Never hardcode API keys. Read them from `.env` and keep `.env.example` updated.
