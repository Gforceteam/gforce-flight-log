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

Local-only pilot exports still go under `backups/` (gitignored), same as before.

## Development

```bash
# PWA (pilot + office) — from repo root
npx serve .

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
