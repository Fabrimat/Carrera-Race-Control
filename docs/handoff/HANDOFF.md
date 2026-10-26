# Handoff — work in progress (2026-10-26)

Read this first when continuing in a new session (local or cloud). Rules that always
apply: user-facing text in English **and** Italian (typed i18n dictionaries), code and
docs in English, commit and push progressively, **never add a `Co-Authored-By: Claude`
trailer**, never log or expose API keys, commits are SSH-signed (retry on 1Password
hiccups, never bypass signing).

## Done and pushed

- Race control app (backend, simulator, engine, BLE adapter, commentary with Haiku/OpenAI
  + ElevenLabs TTS, sectors, track editor/map, 16:9 dashboard, F1-style TV mode).
- Windows desktop app (`desktop/`, Electron + PyInstaller sidecar, config window,
  TV window) — reviewed + Fable-approved.
- Event mode contracts and groundwork: `docs/PROTOCOL.md` "Event mode", models, store
  schema v4, empty routers `backend/app/api/routes_{drivers,event,io}.py`, reserved
  i18n blocks.

## State (end of the local session)

All done, reviewed, Fable-approved and pushed:
- **Event mode** complete (E1–E5): drivers + photos + "Who's driving?" (tap / voice /
  crossing), programs with practice/qualifying/race, false start inference + rules,
  penalties in the ranking, commentator context, JSON export/import with dry run; the
  commentator names assigned drivers. Backend 614 tests, frontend 203, e2e smoke green.
- **CI** `.github/workflows/desktop.yml`: x64 + ARM64 installers green, attached to every
  `v*` release. Repo renamed to `Fabrimat/Carrera-Race-Control` (update local remotes:
  `git remote set-url origin https://github.com/Fabrimat/Carrera-Race-Control.git`).
- **README** screenshots and GIFs in `docs/images/`.
- **Presentation video v2** (76 s, Italian, colleague tone, `eleven_v4` voices, Veo 3.1)
  produced on the user's PC, not in the repo (scratchpad
  `video/out/carrera-race-control-presentazione.mp4`, v1 kept as `-v1.mp4`, scripts in
  `video/scripts/`).

- **Roadmap wave 1** (contracts in `docs/PROTOCOL.md` "Roadmap wave 1", briefs in
  `docs/handoff/roadmap-wave1-briefs.md`): car brand logos (library, SVG checks, schema v5),
  incidents (overdue detection, marshal calls, OFF marker, yellow-flag banner, optional auto
  pace car, incident penalties, simulator deslot), fuel strategy (stint-based laps left,
  "pit by lap N", fuel chart) and mandatory pit stops, keyboard shortcuts (`?` overlay,
  rebinding in Settings). Each brief reviewed; Fable supervised the integration (one fix:
  pace car deploy/clear race). Backend 759 tests, frontend 277, e2e smoke green.
- **Release v0.1.0** published with x64 + ARM64 installers (one-click). The installer is now
  assisted (choose folder, per-user or all users, en/it pages): ships from v0.1.1 on.
- Dependabot action bumps merged together (PR #8); MIT license added.

## Open points

- Live-test on the real CU: the auto pace car (`IncidentRules.auto_pace_car`, off by
  default) and incident detection thresholds.
- Roadmap next: responsive control panel (§5), car↔controller pairing + per-car
  speed/brake profiles (§4, needs the real CU: `setspeed`/`setbrake`), webcam tracking
  prototype (§1, may need OpenCV: ask first), CU fuel writes (`setfuel` semantics unknown).
  Possible: a setting to hide the fuel strategy view even in CU fuel mode.

- Live-test the `restart` false start rule on the real Control Unit before using it at an
  event (conservative now: worst case the race stays "starting" and the operator presses
  START on the CU). `warn` / `penalty` need no CU interaction.
- Listen to the video narration once (audio was only checked for loudness).

## Environment notes

- Windows ARM64 PC; backend venv uses an x64 uv Python (emulated). Frontend via
  `npx -y pnpm@9` (corepack broken). Backend `cd backend && uv run pytest -q`.
- Real track: Carrera Control Unit over BLE `DD:81:ED:DC:17:6C` (only on the user's PC).
- Keys live in the repo-root `.env` (gitignored) locally; a cloud session needs them as
  environment secrets (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, optionally OPENAI_API_KEY).
