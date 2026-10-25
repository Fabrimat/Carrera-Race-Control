# Handoff — work in progress (2026-10-25)

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

## In progress

1. **Event mode build** — briefs in [event-mode-briefs.md](event-mode-briefs.md)
   (shared context + E1 drivers/STT backend, E2 sessions/false start/penalties backend,
   E4 roster/assignment frontend, E5 programs/session runner/import-export frontend).
   Arms were running in local worktrees when this was written; finished work lands on
   `main`, unfinished work may be on `wip/event-*` branches. Then:
   - **E3 backend export/import** (`routes_io.py`): `POST /api/export`, `POST /api/import`
     per PROTOCOL "Export / import" (same code path for dry run and apply in one SQLite
     transaction, rolled back on dry run; settings/layouts validated like their own
     endpoints; records merge keeps the faster lap; replace of drivers purges their
     assignments; `has_photo` false; unknown version → 422 `import_unsupported`).
   - Independent review of each brief, Fable SUPERVISE of the integrated event mode
     (trust boundaries: photo upload, import, STT), Playwright e2e, commit, push.
2. **CI** (`.github/workflows/desktop.yml`): x64 (`windows-latest`) + ARM64
   (`windows-11-arm`, overridable with repo variable `ARM64_RUNNER`) installers, attached
   to every GitHub Release. Under review when this was written. After merge: trigger a
   `workflow_dispatch` run and check both jobs; ARM64 skips `windows-curses` (no
   win_arm64 wheel) — confirm the frozen backend starts on ARM64.
3. **Presentation video** (not started) — ≤ 90 s, Italian, Italian UI, for internal
   management, as many features as possible, professional Italian voice, generated with
   ElevenLabs; simulate everything (simulator track, cars, webcam).
   Plan:
   - Script (~190–210 Italian words) covering: live timing from the real Control Unit,
     AI commentator (live lines + Italian voice), 16:9 control panel, F1-style TV mode on
     a second monitor, track editor + photo→map + live map with position estimate,
     sectors, event mode (drivers, "who's driving", qualifying, false start, penalties,
     import/export), Windows app x64/ARM64, roadmap (webcam tracking, incidents).
   - Footage: Playwright screen recordings of the real app in Italian (`ui_language: it`)
     driven by the simulator; ElevenLabs Image & Video API (`/v1/flows/image`,
     `/v1/flows/video`, e.g. `veo-3.1-generate-001`, 16:9, 1080p; polling ≥ 10 s) for a
     cinematic intro and simulated webcam shots (verified working: account tier
     growing_business, image generation OK).
   - Voice-over: ElevenLabs TTS with a professional Italian voice (pick from the voice
     library; current commentator voice is Davide `ImsA1Fn5TNc843fFdz99`), music via
     ElevenLabs Music API, ducked under the voice.
   - Assemble with ffmpeg (1920×1080, H.264 + AAC, ≤ 90 s, Italian burned-in captions
     optional). Output outside the repo (don't commit large media).

## Environment notes

- Windows ARM64 PC; backend venv uses an x64 uv Python (emulated). Frontend via
  `npx -y pnpm@9` (corepack broken). Backend `cd backend && uv run pytest -q`.
- Real track: Carrera Control Unit over BLE `DD:81:ED:DC:17:6C` (only on the user's PC).
- Keys live in the repo-root `.env` (gitignored) locally; a cloud session needs them as
  environment secrets (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, optionally OPENAI_API_KEY).
