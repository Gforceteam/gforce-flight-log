# Gforce Flight Log — project handoff

Canonical onboarding for this product: architecture, deployment, API, data, UI conventions, and agent-facing constraints. **Do not commit secrets**; store values in a password manager or other private credentials store.

## Overview

| | |
| --- | --- |
| **Name** | Gforce Flight Log |
| **Type** | Tandem paragliding flight operations management PWA |
| **Live app** | https://gforceteam.github.io/gforce-flight-log/ (pilots + office: login → **— Office —** + office password) |
| **API** | https://gforce-api.fly.dev |
| **WebSocket** | wss://gforce-api.fly.dev |

Two-role PWA for GForce Paragliding (Queenstown, NZ). Pilots log tandem flights and receive timer alerts when office sends them away. Office dispatches pilots, tracks timers, and manages the duty roster.

## Repository

**Single monorepo:** https://github.com/Gforceteam/gforce-flight-log  

The pilot PWA (including **office mode** in the same `index.html`), API source under `api/`, and `flight-data-backups/` CSV history all live here. GitHub Pages publishes the **repo root** so the public URL is unchanged. Older split repos (`gforce-api`, `gforce-staff-dashboard`, `gforce-flight-data-backups`) may be archived after migration.

**Local path:** e.g. `~/Developer/Gforce Flight Log/gforce-flight-log` or your clone path.

## Architecture

```
Monorepo (GitHub Pages = repo root)
├── index.html, sw.js, manifest.json, icons  — pilot PWA + office UI (login → — Office —)
├── api/               — Node API (Fly.io): server.js, Dockerfile, fly.toml
├── flight-data-backups/ — committed CSV snapshots
└── Turso DB           — LibSQL/SQLite (credentials in Fly secrets)
```

**Checkout caveat:** A local clone might split the UI across `app.js`, `style.css`, and a smaller `index.html`, while the GitHub Pages deployment may still use a monolithic `index.html`. Treat **this document plus deployed URLs and path constraints** as the source of truth for behavior and routing, not line counts in a single file.

## Deploy

**Frontend (GitHub Pages)**

```bash
cd ~/Developer/gforce-flight-log   # or your clone path
git add .
git commit -m "Your message"
git push origin main
```

**Backend (Fly.io)**

```bash
cd ~/Developer/gforce-flight-log/api   # or your clone path + /api
git add server.js   # or whatever changed
git commit -m "Your message"
git push origin main
fly deploy --app gforce-api
```

**GitHub Actions:** `.github/workflows/fly-deploy-api.yml` deploys from `api/` on pushes to `main`. Set the **`FLY_API_TOKEN`** secret on the **`gforce-flight-log`** repository. In the Fly.io dashboard, disconnect any deploy hook that still targets the old **`gforce-api`** GitHub repo so only this workflow (or your manual `fly deploy`) runs.

## Secrets and environment (names only)

Configure on Fly and locally as needed. **Values** belong in a password manager or other private storage, not in this repo.

**Fly.io (app: `gforce-api`)**

- `JWT_SECRET`
- `OFFICE_PASSWORD`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `GITHUB_TOKEN`

**Turso**

- `TURSO_URL` (example host pattern: `libsql://…turso.io`)
- `TURSO_AUTH_TOKEN`

Pilot/office passwords and pilot account identifiers for testing are **not** listed here; keep them in your private credentials doc.

## Auth and roles

- **Pilot:** `POST /api/auth/pilot` with `{ name, password }` → `{ token, id, name }`. Use `Authorization: Bearer <token>` on pilot routes.
- **Office:** `POST /api/auth/office` with `{ password }` → `{ token }`. Bearer token on office routes.
- **Public:** `GET /api/public/pilots` returns `[{ id, name }]` for login.

## API endpoints (summary)

### Auth (no token)

- `POST /api/auth/pilot`
- `POST /api/auth/office`
- `GET /api/public/pilots`

### Pilot (Bearer)

- `GET /api/my-status`
- `GET /api/flights` — own flights
- `POST /api/flights` — log flight: `{ date, flight_num, weight, takeoff, landing, time, notes? }`
- `PUT /api/flights/:id` — edit own flight
- `DELETE /api/flights/:id`
- `PUT /api/pilot/available` — `{ available: bool }` (broadcasts WS)
- `PUT /api/pilot/wing` — `{ wing_reg }`
- `PUT /api/pilot/hours` — `{ date, hours }`
- `PUT /api/pilot/password` — `{ current, newPassword }`
- `GET /api/flying` — active timers with pilot info
- `GET /api/drives` — peak drives
- `POST /api/drives` — log peak drive
- `DELETE /api/drives/:id`
- `POST /api/push/subscribe` — Web Push subscription
- `DELETE /api/push/unsubscribe`
- `POST /api/pilot/cancel-timer` — Did Not Fly

### Office (Bearer)

- `GET /api/pilots` — all pilots with status, timers, `last_landed_at`
- `GET /api/office/flights` — all flights with pilot info
- `POST /api/office/leave` — `{ pilot_id, client_name }` (starts timer)
- `POST /api/office/group-leave` — `{ group_name?, pilot_ids[] }`
- `POST /api/office/landed-early` — `{ pilot_id }`
- `POST /api/office/extend-timer` — `{ pilot_id }` (+30 min)
- `POST /api/office/pilot-signout` — `{ pilot_id }`
- `POST /api/office/pilot-signin` — `{ pilot_id }`
- `PUT /api/office/flights/:id` — edit any flight
- `DELETE /api/office/flights/:id`
- `PUT /api/office/reset-password` — `{ pilot_id, new_password }`

## WebSocket

Clients connect **without** auth. **Server → client** events (broadcast):

- `LEFT_OFFICE` — `pilot_id`, `pilot_name`, `client_name`, `started_at`, `expires_at`, `group_id?`
- `GROUP_LEFT_OFFICE` — `pilot_ids`, `pilot_names`, `group_name?`, `group_id`, `started_at`, `expires_at`
- `LANDED` — `pilot_id`, `pilot_name`, `flight_id`
- `LANDED_EARLY` — `pilot_id`, `pilot_name`
- `DID_NOT_FLY` — `pilot_id`, `pilot_name`
- `TIMER_EXPIRED` — `pilot_id`, `pilot_name`
- `TIMER_EXTENDED` — `pilot_id`, `pilot_name`, `new_expires_at`
- `PILOT_SIGNED_OUT` — `pilot_id`
- `PILOT_SIGNED_IN` — `pilot_id`

## Database schema (Turso / LibSQL)

```sql
CREATE TABLE pilots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
  created_at TEXT, last_seen TEXT, current_wing TEXT, available INTEGER DEFAULT 0);

CREATE TABLE flights (
  id TEXT PRIMARY KEY, pilot_id TEXT, client_name TEXT, date TEXT,
  flight_num INTEGER, weight REAL, takeoff TEXT, landing TEXT,
  time INTEGER, photos REAL, notes TEXT, landed_at TEXT,
  created_at TEXT, wing_reg TEXT, hours_worked REAL, sent_away_at TEXT);

CREATE TABLE active_timers (
  pilot_id TEXT PRIMARY KEY, client_name TEXT, started_at TEXT, expires_at TEXT,
  group_id TEXT, notif_10min INTEGER DEFAULT 0, notif_5min INTEGER DEFAULT 0, notif_expired INTEGER DEFAULT 0);

CREATE TABLE flight_groups (id TEXT PRIMARY KEY, name TEXT, started_at TEXT, is_peak_trip INTEGER DEFAULT 0);
CREATE TABLE group_members (group_id TEXT, pilot_id TEXT, PRIMARY KEY (group_id, pilot_id));
CREATE TABLE drives (id TEXT PRIMARY KEY, pilot_id TEXT, date TEXT, group_id TEXT, notes TEXT, created_at TEXT);
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, pilot_id TEXT NOT NULL, subscription TEXT NOT NULL, created_at TEXT);
CREATE TABLE office_logs (id TEXT PRIMARY KEY, pilot_id TEXT, event TEXT, created_at TEXT);

CREATE INDEX idx_flights_pilot_date ON flights(pilot_id, date);
CREATE INDEX idx_flights_date ON flights(date);
CREATE INDEX idx_flights_landed ON flights(landed_at);
CREATE INDEX idx_timers_pilot ON active_timers(pilot_id);
CREATE INDEX idx_push_pilot ON push_subscriptions(pilot_id);
CREATE INDEX idx_drives_pilot ON drives(pilot_id);
```

## Design system (CSS variables)

Do **not** change the accent orange without explicit approval.

```css
--bg: #0b0d12;
--surface: #12151d;
--card: #181c26;
--card-hi: #1e2334;
--border: #242838;
--border-hi: #303548;
--accent: #f37329;     /* GForce orange */
--danger: #f04438;
--warning: #f5a623;
--success: #22c55e;
--text: #f1f2f6;
--text-2: #c5cbd8;
--muted: #8b929f;
--radius: 16px;
--radius-sm: 10px;
```

- **Pilot UI:** dark theme (default); Montserrat 700–800 for headings and numbers.
- **Office UI:** light background `#ffffff`, Inter.

## Path constraints (do not change casually)

These paths were set for GitHub Pages; changing them can break the deployed app.

| Item | Path |
| --- | --- |
| Service worker | `/checklist/sw.js` |
| Manifest | `/checklist/manifest.json` |
| SW cache name | `gforce-v7` |
| SW `APP` const base | `/checklist/` |
| Manifest `start_url` | `/flightlog/` |
| Icons | `/flightlog/icon-192.png`, `/flightlog/icon-512.png` |
| `version.json` | Repository root (not under `/checklist/`) |

## Key frontend concepts (names)

- `apiFetch(url, opts)` — fetch with Bearer token; 401 handling toward login.
- `WS_CONNECT()` / `ws.close()` — WebSocket lifecycle.
- `loadOfficeData()` — office: pilots + flights.
- `renderPilotStatus()` / `renderOfficeDashboard()` — main views.
- `sendAway()` / `groupSendAway()` — office send-away.
- `showNewFFModal()` / `showGroupModal()` — FF / group forms.
- `showSentAwayModal(data)` — pilot send-away UI.
- `startFlyingTimer()` / `clearFlyingTimer()` — pilot timer UI.
- `renderStatsPage()` / `renderStatsOffice()` — stats.
- `doAuth()`, `officeDoLogout()`, `pilotDoLogout()` — auth.

## Known issues (do not fix without asking)

1. WebSocket has no authentication; any client can connect and receive broadcasts.
2. No WS ping/pong heartbeat; stale connections accumulate (mitigated by ~20s polling fallback).
3. Alert banner auto-dismisses in 30s; staff can miss expired timer alerts.
4. No foreign keys on `pilot_id`; pilot deletion can leave orphaned records.
5. Backup timer drifts after DST if anchored only with `setInterval(24h)` instead of a real NZ-time schedule.
6. Mixed asset paths in `index.html`; some icons may still reference `/gforce-flight-log/` paths.

## Product preferences (do not revert casually)

- Pilot nav: **fixed bottom bar** with SVG icons (top tabs were tried twice and reverted).
- Office nav: **top tab bar** under header.
- Stats order: **Today → This Week → This Month → Avg/Day**.
- Remove **Gondola Time** and **Vertical Climbed** from stats.
- FF tab button label: **"FF"**, not "Follow".
- Group name on New FF form: **optional** (not required).
- Flight time input: **range slider 5–15 min** (not radio buttons).
- Office background: **`#ffffff`** (white).

## Regional and copy rules

- **Timezone:** Pacific/Auckland (NZ) for user-visible dates; use `timeZone: 'Pacific/Auckland'` in `toLocaleString` where relevant.
- **API dates:** `YYYY-MM-DD`; ISO strings in the DB.
- **UI copy:** avoid em dashes in UI text; use commas, semicolons, or rephrase.

## Recently shipped (reference)

Examples from active development cycles:

- PWA install prompt and “Add to Home Screen”
- Version banner (“New version available” / “Update Now”)
- Office auto-refresh ~20s as WS fallback
- Visible WS connection indicator in office header
- More prominent office refresh controls
- Flight log scroll fix (fixed nav, scrolling content)
- Light/white office background
- Flight time as range slider
- FF tab: compact cards, optional group name, Send Away + Sign Out on one row
- Service worker + manifest under `/checklist/` for GitHub Pages

---

*Last updated for agent onboarding; keep in sync when deployment paths or API behavior change.*
