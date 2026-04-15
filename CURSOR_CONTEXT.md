# Gforce Flight Log — Cursor Agent Context

## Project Overview

**Name:** Gforce Flight Log
**Type:** Tandem paragliding flight operations management PWA
**Live App:** https://brookewhatnall.github.io/gforce-flight-log/
**Staff:** https://brookewhatnall.github.io/gforce-flight-log/staff-dashboard/
**API:** https://gforce-api.fly.dev | WebSocket: wss://gforce-api.fly.dev
**Description:** Two-role PWA for GForce Paragliding (Queenstown, NZ). Pilots log tandem flights, receive timer alerts when office sends them away. Office dispatches pilots, tracks timers, manages the duty roster.

## Architecture

```
Monorepo (https://github.com/brookewhatnall/gforce-flight-log)
├── index.html, sw.js, manifest.json — pilot PWA (GitHub Pages = repo root)
├── staff-dashboard/ — office dashboard (static HTML)
├── api/server.js    — REST API + WebSocket (Fly.io Tokyo)
└── Turso DB         — LibSQL/SQLite (gforce-api-nzgforce.aws-ap-northeast-1.turso.io)
```

## Repo

- **Monorepo:** https://github.com/brookewhatnall/gforce-flight-log (pilot app + staff + `api/` + `flight-data-backups/`)
- **Local clone:** e.g. ~/Developer/Gforce Flight Log/gforce-flight-log/

## Deploy Commands

```bash
# GitHub Pages (pilot + staff under same origin)
cd ~/Developer/Gforce\ Flight\ Log/gforce-flight-log
git add . && git commit -m "msg" && git push origin main

# Backend (Fly.io)
cd ~/Developer/Gforce\ Flight\ Log/gforce-flight-log/api
git add server.js && git commit -m "msg" && git push origin main
fly deploy --app gforce-api
```

## Secrets & Credentials

```
# Fly.io (app: gforce-api) — get from Brooke's TOOLS.md or OpenClaw config
JWT_SECRET=<get from TOOLS.md>
OFFICE_PASSWORD=office123
VAPID_PUBLIC_KEY=<get from TOOLS.md>
VAPID_PRIVATE_KEY=<get from TOOLS.md>
GITHUB_TOKEN=<get from TOOLS.md>

# Turso — get from Brooke's TOOLS.md or OpenClaw config
TURSO_URL=libsql://gforce-api-nzgforce.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=<get from TOOLS.md>
```

## Pilot IDs & Passwords

All pilots use password `1234`.

| Name | ID |
|------|-----|
| Balda | f1478040-654a-4ecf-8879-50e619ca0075 |
| Bellett | 2d491f03-78f4-4f1a-ae9d-f7ea1490de5e |
| Ben F | f8045262-9af3-4fdf-9a62-eee529d412a3 |
| Blake | 03f6517b-0e5b-44a1-abfa-2c5be7e5967a |
| Brooke | 79fad27f-4fe9-4929-ade6-99050cb72aa1 |
| Casey | 1819c9c5-080f-4a7d-85cd-65f4a2365d37 |
| Cathal | b5839c2d-5afd-46f0-b706-92a7385af62d |
| Cima | 281982ef-6569-43d5-82aa-8e1ca3482e6a |
| Clem | 7f88b884-4caf-48cc-94df-48ad94b89cc0 |
| Dom | 9d279b12-8048-407e-b503-6ae812eb51ed |
| Eddy | 4a8e3092-cb37-48ae-b047-3ca8292cfb9b |
| Gavin | b009c903-1144-43ef-a6b0-fd3c555e678e |
| Georges | 950b79d0-58f4-419b-a901-fbd8760b7dbd |
| Janik | d2fbc818-2719-4586-a75d-4b21ac278b43 |
| Leo | 27269c3e-4061-4df2-99cd-30066c9e6023 |
| Marika | c2291fb3-c79a-4ed3-b59a-2ea0f1dad08d |
| Mike | 174bac4e-4919-458b-ba79-cef9977345a5 |
| Pete | 65a4d22f-2583-4e69-99b2-c17c17816276 |
| Thomas | c46fa347-d4b0-4a77-9498-f7a3c06d5ca4 |
| Todd | 1b51f1e3-1ade-4dfb-988e-031d76685683 |

## API Endpoints

### Auth (no token)
- `POST /api/auth/pilot` — `{ name, password }` → `{ token, id, name }`
- `POST /api/auth/office` — `{ password }` → `{ token }`
- `GET /api/public/pilots` — `[{ id, name }]` (public pilot list for login)

### Pilot (Bearer token in Authorization header)
- `GET /api/my-status` — current status, timer, group, availability, current_wing
- `GET /api/flights` — own flights
- `POST /api/flights` — log flight: `{ date, flight_num, weight, takeoff, landing, time, notes? }`
- `PUT /api/flights/:id` — edit own flight
- `DELETE /api/flights/:id` — delete own flight
- `PUT /api/pilot/available` — `{ available: bool }` — broadcasts WS events
- `PUT /api/pilot/wing` — `{ wing_reg }`
- `PUT /api/pilot/hours` — `{ date, hours }`
- `PUT /api/pilot/password` — `{ current, newPassword }`
- `GET /api/flying` — active timers with pilot info
- `GET /api/drives` — peak drives
- `POST /api/drives` — log peak drive
- `DELETE /api/drives/:id` — delete drive
- `POST /api/push/subscribe` — register Web Push subscription
- `DELETE /api/push/unsubscribe` — remove push subscription
- `POST /api/pilot/cancel-timer` — Did Not Fly

### Office (Bearer token in Authorization header)
- `GET /api/pilots` — all pilots with status, timers, last_landed_at
- `GET /api/office/flights` — all flights with pilot info
- `POST /api/office/leave` — `{ pilot_id, client_name }` → send pilot away, starts timer
- `POST /api/office/group-leave` — `{ group_name?, pilot_ids[] }` → group send-away
- `POST /api/office/landed-early` — `{ pilot_id }` → cancel timer early
- `POST /api/office/extend-timer` — `{ pilot_id }` → +30min
- `POST /api/office/pilot-signout` — `{ pilot_id }`
- `POST /api/office/pilot-signin` — `{ pilot_id }`
- `PUT /api/office/flights/:id` — edit any flight
- `DELETE /api/office/flights/:id` — delete any flight
- `PUT /api/office/reset-password` — `{ pilot_id, new_password }`

## WebSocket Events (broadcast to all clients)

**Client → Server:** Connect with no auth (WS has no authentication)

**Server → Client:**
- `LEFT_OFFICE { pilot_id, pilot_name, client_name, started_at, expires_at, group_id? }`
- `GROUP_LEFT_OFFICE { pilot_ids, pilot_names, group_name?, group_id, started_at, expires_at }`
- `LANDED { pilot_id, pilot_name, flight_id }`
- `LANDED_EARLY { pilot_id, pilot_name }`
- `DID_NOT_FLY { pilot_id, pilot_name }`
- `TIMER_EXPIRED { pilot_id, pilot_name }`
- `TIMER_EXTENDED { pilot_id, pilot_name, new_expires_at }`
- `PILOT_SIGNED_OUT { pilot_id }`
- `PILOT_SIGNED_IN { pilot_id }`

## Database Schema (Turso/LibSQL)

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

## Design System

```css
--bg: #0b0d12;         /* dark page background */
--surface: #12151d;    /* card backgrounds */
--card: #181c26;       /* elevated cards */
--card-hi: #1e2334;    /* hover/active cards */
--border: #242838;     /* borders */
--border-hi: #303548;  /* highlighted borders */
--accent: #f37329;     /* GForce orange — NEVER change */
--danger: #f04438;     /* errors/deletions */
--warning: #f5a623;   /* warnings/cautions */
--success: #22c55e;    /* success states */
--text: #f1f2f6;       /* primary text */
--text-2: #c5cbd8;    /* secondary text */
--muted: #8b929f;      /* muted/placeholder text */
--radius: 16px;        /* large border-radius */
--radius-sm: 10px;     /* small border-radius */
```

**Pilot UI:** dark theme (default), Montserrat 700-800 for headings/numbers
**Office UI:** white/light background (#ffffff), Inter font

## Current File Paths (MUST NOT CHANGE)

These were deliberately migrated and any path change will break the deployed app:

```
SW path:        /checklist/sw.js
Manifest:       /checklist/manifest.json
SW cache:       gforce-v7
SW APP const:   /checklist/
Manifest path:  /flightlog/ (start_url)
Icons:          /flightlog/icon-192.png, /flightlog/icon-512.png
version.json:   repo root (not in /checklist/)
```

## Key Frontend Functions (selected)

- `apiFetch(url, opts)` — fetch with Bearer token, auto-redirects to login on 401
- `WS_CONNECT()` / `ws.close()` — WebSocket connection management
- `loadOfficeData()` — fetches all pilots + flights for office view
- `renderPilotStatus()` / `renderOfficeDashboard()` — main render functions
- `sendAway()` / `groupSendAway()` — office sends pilot away
- `showNewFFModal()` / `showGroupModal()` — FF/new flight following forms
- `showSentAwayModal(data)` — pilot receives send-away notification
- `startFlyingTimer()` / `clearFlyingTimer()` — pilot timer management
- `renderStatsPage()` / `renderStatsOffice()` — stats/charts
- `doAuth()` — pilot login
- `officeDoLogout()` / `pilotDoLogout()` — logout

## Known Issues (DO NOT FIX without asking)

1. WebSocket has no authentication — any client can connect and receive all broadcasts
2. No WS ping/pong heartbeat — stale connections accumulate (mitigated by 20s polling fallback)
3. Alert banner auto-dismisses in 30s — staff can miss expired timer alerts
4. No foreign keys on pilot_id — pilot deletion leaves orphaned records
5. Backup timer drifts after DST — setInterval(24h) doesn't re-anchor to 2 AM NZ
6. Mixed paths in index.html — some icons still reference /gforce-flight-log/ paths

## What Was Recently Built (2026-04-13 to 2026-04-14)

- PWA install prompt + "Add to Home Screen" button
- Version tracking + "New version available" banner with "Update Now"
- Office auto-refresh every 20s (WS fallback)
- Visible WS connection indicator (green/red dot in office header)
- Office refresh buttons made more prominent
- Flight log page scroll fix (nav stays fixed, content scrolls)
- Light/white office background (#ffffff)
- Flight time input changed to range slider (5-15 min)
- FF tab: compact pilot cards, optional group name, Send Away + Sign Out on same row
- Service worker + manifest moved to /checklist/ path (GitHub Pages deployment)

## User Preferences (permanent — do not revert)

- Pilot nav: fixed bottom bar with SVG icons (top tabs tried twice, both reverted)
- Office nav: top tab bar under header
- Stats order: Today → This Week → This Month → Avg/Day
- Gondola Time and Vertical Climbed cards: removed from stats
- FF tab button label: "FF" not "Follow"
- Group name on New FF form: optional (not required)
- Flight time input: range slider 5-15 min (not radio buttons)
- Office background: #ffffff (white)

## Development Notes

- **NZ timezone:** All dates handled in Pacific/Auckland (NZ) — use `timeZone: 'Pacific/Auckland'` in toLocaleString calls
- **Date format:** API uses YYYY-MM-DD, ISO strings stored in DB
- **CSV import:** Ben French had 3077 flights (date format DD/MM/YYYY, needed corrections)
- **All pilots have password `1234`** — office password is `office123`
- **No em dashes** in any UI text — restructure sentences or use commas/semicolons
- **Grok (xai/grok-4-1-fast)** is preferred model for coding tasks — MiniMax for quick tasks
