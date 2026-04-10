# Gforce Staff Dashboard

Office staff dashboard for the Gforce Flight Log system.

## Setup

1. Enable GitHub Pages: Settings → Pages → Source: `main` branch
2. Update `API_BASE` in `index.html` to point to your deployed API server URL
3. Access at `https://brookewhatnall.github.io/gforce-staff-dashboard`

## Login

Use the office password set in the API server (`OFFICE_PASSWORD` env var).

## Features

- Real-time pilot status via WebSocket
- Start 90-minute timers when pilots leave
- Land early button if pilot reports by radio
- Timer expiry alerts
- Per-pilot and combined CSV export
