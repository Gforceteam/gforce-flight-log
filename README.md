# Gforce Flight Log (monorepo)

Tandem paragliding flight logger: pilot PWA, office staff dashboard, API server code, and committed CSV backups live in **this single repository**. GitHub Pages serves the **repository root** so the pilot app URL is unchanged.

## URLs

| App | URL |
|-----|-----|
| Pilot PWA | https://brookewhatnall.github.io/gforce-flight-log/ |
| Staff dashboard | https://brookewhatnall.github.io/gforce-flight-log/staff-dashboard/ |
| API (Fly.io) | https://gforce-api.fly.dev |
| WebSocket | wss://gforce-api.fly.dev |

## Repo layout

| Path | Purpose |
|------|---------|
| Repo root (`index.html`, `sw.js`, `manifest.json`, icons) | Pilot PWA — **must stay at root** for the same GitHub Pages URL |
| `staff-dashboard/` | Office dashboard (static HTML) |
| `api/` | Node API for Fly.io (`fly deploy` from `api/`) |
| `flight-data-backups/` | Historical flight CSV exports (committed backups) |

Local-only pilot exports still go under `backups/` (gitignored), same as before.

## Development

```bash
# Pilot app (static) — from repo root
npx serve .

# Staff dashboard
npx serve . --listen 8080
# Then open http://localhost:8080/staff-dashboard/

# API
cd api && npm install && npm start
```

Configure `api/.env` from `api/.env.example` for local API work.

## Pilot app: standalone vs portal

- **Standalone:** Offline, `localStorage`. No account.
- **Portal:** Logs into the API; flights sync and notify office via WebSocket.

The pilot app picks the API URL from context (localhost vs GitHub Pages). To change it, edit the `API_BASE` constant in root `index.html`.

## Deploy

**GitHub Pages:** Repository **Settings → Pages**: build from **`main`**, folder **`/` (root)**. Do **not** switch to `/docs` only unless you move the PWA into `docs/` (that would change URLs).

**API (Fly.io):**

```bash
cd api
fly deploy --app gforce-api
```

## Legacy separate repos

The former split repos (`gforce-api`, `gforce-staff-dashboard`, `gforce-flight-data-backups`) can be archived on GitHub after this monorepo is pushed and the team uses the new staff URL.

## Adding pilots

See `Project.md` for SQL and PIN hashing. **Do not commit secrets.**
