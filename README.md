# Steady Days

A calm personal daily dashboard: Top 3, check-ins, workout, journal, wishlist, backlog and pointers.

- `src/steady-days.html` is the app source (also published as the Claude artifact).
- `web/` holds the standalone pieces: Firebase sign-in and storage adapter (`boot.js`), the runtime shim (`shim.js`), service worker and manifest.
- `python3 tools/build.py` builds the GitHub Pages site (`index.html` and friends at the repo root).

Data lives in Firebase (Firestore, `users/<uid>/docs/...`), readable and writable only by the signed-in owner.

## Server side (Firebase Functions, `functions/`)
- `tick` runs every 5 minutes: the morning nudge at each person's chosen time, and task reminders (`remindAt`) that are due. It reads `users/<uid>/docs/{settings,devices,reminder__next,tt}` and writes only `users/<uid>/docs/server`.
- `claude` is a callable function that asks Claude with the server-held `ANTHROPIC_API_KEY`, limited to `ALLOWED_EMAILS`.
- `.github/workflows/deploy-functions.yml` deploys on push once these repository secrets exist: `FIREBASE_SERVICE_ACCOUNT` (JSON key), `ALLOWED_EMAILS`, and optionally `ANTHROPIC_API_KEY`.
