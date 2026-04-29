# tekken-tracker

Purpose: concise guidance for Copilot sessions working in this repository — commands, high-level architecture, and codebase-specific conventions.

---

## 1) Build, run, test, and lint commands
- Start production: `npm start` (runs `node server.js`).
- Dev mode (auto-reload): `npm run dev` (runs `node --watch server.js`).
- There are no test or lint scripts in package.json. If tests are added, prefer adding `npm test` and a single-test runner script (e.g., `node ./test/single-test.js` or `mocha <file>`).
- To run a single Node file for quick checks: `node path/to/file.js`.

---

## 2) High-level architecture
- Node + Express server: entry point `server.js`. Loads environment vars via `dotenv`.
- Static front-end: `public/` (served with express.static). Key client files: `public/app.js`, `public/brackets.js`, `public/index.html`.
- Server-side modules: `src/` contains integration and business logic. Notable modules:
  - `src/startgg.js` — StartGG API calls and caching helpers (fetchers, cache, clearCache, cacheSize).
  - `src/bracket.js` — domain logic: collision detection, player timelines, bracket simulation.
- Runtime state: `server.js` keeps an in-memory list `TRACKED_IDS` and `EVENT_SLUG`. These can be updated at runtime via API.
- API surface (server.js):
  - GET `/api/event` — fetch event metadata
  - GET `/api/players` — fetch tracked entrants
  - GET `/api/sets` — sets for tracked entrants
  - GET `/api/collisions` — direct collision detection
  - GET `/api/timeline/:entrantId` — per-player timeline
  - GET `/api/dashboard` — bundled payload (event, players, sets, collisions, timelines, brackets)
  - POST `/api/simulate` — simulate bracket with optional `overrides` mapping
  - POST `/api/config` — update `entrantIds` and/or `eventSlug` (clears cache)
  - POST `/api/refresh` — clear cache
  - GET `/api/status` — server status, tracked IDs
- Environment variables: `PORT`, `EVENT_SLUG` and other StartGG credentials (check `src/startgg.js`).
- Deployment: `.github/workflows/deploy.yml` exists — expect simple push-based deploy.

---

## 3) Key repository conventions and patterns
- CommonJS modules (require/exports) throughout — keep changes consistent.
- Server holds light mutable runtime state (TRACKED_IDS). Prefer using `/api/config` to change tracked entrants rather than editing source.
- IDs are numeric entrant IDs (track by number). Ensure conversions: `Number(...)` and filter falsy values when updating from clients.
- The dashboard API (`/api/dashboard`) is intentionally single-call to the server to minimize client-side fetch complexity — Copilot should prefer edits that preserve this pattern when possible.
- Bracket simulation is pure-ish: `simulateBracket(sets, overrides)` returns simulated sets and does not persist changes; use returned payloads for client-side projection.
- Caching: `startgg` export includes cache helpers (`clearCache`, `cacheSize`) — prefer calling these helpers after config changes or when testing repeated API calls.

---

## Notable files to inspect when changing behavior
- `server.js` — app routes, runtime state, start point for local dev
- `src/startgg.js` — external API calls and caching logic
- `src/bracket.js` — collision detection, timeline generation, simulation
- `public/` — client JS and HTML for UI
- `.github/workflows/deploy.yml` — CI/deploy path

---

## How Copilot should assist (short guidelines)
- When asked to modify behavior, prefer server-side endpoints (`/api/*`) or `src/*` modules rather than editing static files in `public/` unless the UI is the requested target.
- Preserve existing API contracts and response shapes when possible to avoid client breakage.
- When adding tests or linting, add npm scripts (`test`, `lint`) to package.json and include minimal config files; document usage here.

---

Created: generated to help future Copilot sessions. Update this file if project adds tests, linters, or a frontend build step (e.g., bundlers).
