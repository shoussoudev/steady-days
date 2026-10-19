# Steady Days

A calm personal daily dashboard: Top 3, check-ins, workout, journal, wishlist, backlog and pointers.

- `src/steady-days.html` is the app source (also published as the Claude artifact).
- `web/` holds the standalone pieces: Firebase sign-in and storage adapter (`boot.js`), the runtime shim (`shim.js`), service worker and manifest.
- `python3 tools/build.py` builds the GitHub Pages site (`index.html` and friends at the repo root).

Data lives in Firebase (Firestore, `users/<uid>/docs/...`), readable and writable only by the signed-in owner.
