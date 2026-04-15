# Gforce Staff Dashboard

Office staff dashboard for the Gforce Flight Log system.

## Setup

1. This app is published as part of the **gforce-flight-log** monorepo. GitHub Pages should use the **`main`** branch and the **root** of the repo (pilot PWA stays at `/`; staff UI is under `/staff-dashboard/`).
2. `API_BASE` in `index.html` should point at your deployed API (production: `https://gforce-api.fly.dev`).
3. **Staff URL:** https://brookewhatnall.github.io/gforce-flight-log/staff-dashboard/

The old standalone repo URL (`…/gforce-staff-dashboard`) can be retired after bookmarks are updated, or that repo can host a tiny redirect page.

## Login

Use the office password set in the API server (`OFFICE_PASSWORD` env var).

## Features

- Real-time pilot status via WebSocket
- Start 90-minute timers when pilots leave
- Land early button if pilot reports by radio
- Timer expiry alerts
- Per-pilot and combined CSV export
