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

## In progress (updated)

1. **Event mode** — merged on `main` and reviewed: E1 drivers/photos/assignments/STT
   backend, E4 roster + "Who's driving?" frontend, E5 programs/session runner/TV
   graphics/import-export frontend. Still to do:
   - **E2** (sessions, qualifying order, false start inference, penalties in the ranking,
     commentator context) — was being built by an arm on the user's PC (local worktree);
     a partial snapshot is on branch `wip/event-e2-sessions` (unreviewed). Brief in
     [event-mode-briefs.md](event-mode-briefs.md). Until it lands, the frontend's
     `/api/programs` and `/api/event/*` calls get 404/405.
   - **E3** export/import backend (`routes_io.py`), see the brief notes below; frontend
     import cap is 5 MB, so the backend body limit for `/api/import` must allow 5 MB.
   - Fable SUPERVISE of the integrated event mode, Playwright e2e, small nits: stop late
     `getUserMedia` streams in `VoiceInput`/`PhotoCapture` if unmounted while pending;
     `api.transcribe` `name_guess` type should be `string | null`.
   E3 brief: `POST /api/export`, `POST /api/import` per PROTOCOL "Export / import" (same
   code path for dry run and apply in one SQLite transaction, rolled back on dry run;
   settings/layouts validated like their own endpoints; records merge keeps the faster
   lap; replace of drivers purges their assignments; `has_photo` false; unknown version →
   422 `import_unsupported`, invalid → 422 `import_invalid`).
2. **CI** — `.github/workflows/desktop.yml` works: ARM64 build passed; x64 failed only on
   the frontend test command (fixed in 45e9d46). Repo was renamed to
   `Fabrimat/Carrera-Race-Control` (local remote still points to the old URL, GitHub
   redirects). Actions on Node 20 are deprecated: Dependabot will bump them.
3. **README screenshots/GIFs** (requested): capture the app (English UI) with Playwright
   on the simulator — dashboard 16:9, TV mode, track editor/live map, drivers + who's
   driving, event page; short GIFs (ffmpeg palettegen) of the start lights and TV banners;
   store under `docs/images/` (keep each < ~1.5 MB) and embed in README.
4. **Presentation video** — being produced on the user's PC by an arm (brief kept in the
   local scratchpad; summary): ≤ 90 s, Italian UI; **cold open like a trailer: the start
   lights come on, lights out, then the AI commentator calls the action**; then a
   professional Italian narrator over app footage, ElevenLabs music/SFX/Veo shots,
   simulated webcam for the roadmap part. Output stays outside the repo.

## Environment notes

- Windows ARM64 PC; backend venv uses an x64 uv Python (emulated). Frontend via
  `npx -y pnpm@9` (corepack broken). Backend `cd backend && uv run pytest -q`.
- Real track: Carrera Control Unit over BLE `DD:81:ED:DC:17:6C` (only on the user's PC).
- Keys live in the repo-root `.env` (gitignored) locally; a cloud session needs them as
  environment secrets (ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, optionally OPENAI_API_KEY).
