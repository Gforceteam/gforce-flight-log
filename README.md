# Gforce Flight Log (monorepo)

Tandem paragliding flight logger: pilot PWA (with **built-in office mode**), API server code, and committed CSV backups live in **this single repository**. GitHub Pages serves the **repository root** so the public URL is unchanged.

## URLs

| App | URL |
|-----|-----|
| Pilot + office (same PWA) | https://brookewhatnall.github.io/gforce-flight-log/ |
| API (Fly.io) | https://gforce-api.fly.dev |
| WebSocket | wss://gforce-api.fly.dev |

**Office staff** do not use a second URL. On the login screen, choose **— Office —** in the pilot dropdown, then enter the **office password** (same as API `OFFICE_PASSWORD`). That unlocks the office dashboard (timers, roster, exports) inside this app.

## Repo layout

| Path | Purpose |
|------|---------|
| Repo root (`index.html`, `sw.js`, `manifest.json`, icons) | Pilot PWA + office UI — **must stay at root** for the same GitHub Pages URL |
| `api/` | Node API for Fly.io (`fly deploy` from `api/`) |
| `flight-data-backups/` | Historical flight CSV exports (committed backups) |

Local-only pilot exports still go under `backups/` (gitignored). Committed history lives under `flight-data-backups/`.

## Development

Run the **API** on port **3000** and the **static PWA** on a **different** port so they do not clash (for example **8080**). The browser origin must be allowed by API CORS (localhost on common dev ports is included).

```bash
# Terminal 1 — API (Turso: set TURSO_URL + TURSO_AUTH_TOKEN in api/.env)
cd api && npm install && npm start

# Terminal 2 — PWA from repo root (example: port 8080)
npx serve -l 8080 .
```

Then open `http://localhost:8080` (or your chosen port). From `localhost`, the app uses `http://localhost:3000` for REST and `ws://localhost:3000` for WebSocket. **Production** (GitHub Pages) uses `https://gforce-api.fly.dev` / `wss://gforce-api.fly.dev` automatically.

Copy `api/.env.example` to `api/.env` and fill in Turso and auth values. Run `cd api && npm test` for a quick syntax check.

## Pilot app: standalone vs portal

- **Standalone:** Offline, `localStorage`. No account.
- **Portal:** Logs into the API; flights sync and notify office via WebSocket.

The pilot app **selects the API and WebSocket URLs from `location.hostname`**: localhost (or `127.0.0.1`) → local API on port 3000; otherwise → Fly production. To point at another host, set the `ALLOWED_ORIGINS` env var on the API and adjust the client config in `index.html` if needed.

## Deploy

**GitHub Pages:** Repository **Settings → Pages**: build from **`main`**, folder **`/` (root)**. Do **not** switch to `/docs` only unless you move the PWA into `docs/` (that would change URLs).

**API (Fly.io):**

Manual deploy from a clone of this repo:

```bash
cd api
fly deploy --app gforce-api
```

**CI (GitHub → Fly):** Pushes to `main` that touch `api/` run `.github/workflows/fly-deploy-api.yml`. Add a repository secret **`FLY_API_TOKEN`** (create with `fly tokens create` or **Fly.io dashboard → Access tokens**). If you previously connected Fly’s GitHub integration to the old **`gforce-api`** repo only, remove or disable that so deploys are not duplicated or pointed at the wrong repo.

## Legacy separate repos

The former split repos (`gforce-api`, `gforce-staff-dashboard`, `gforce-flight-data-backups`) can be archived on GitHub after this monorepo is pushed. The old standalone **gforce-staff-dashboard** Pages site was redundant with **Office** mode in the main PWA.

## Adding pilots

See `Project.md` for SQL and PIN hashing. **Do not commit secrets.**
