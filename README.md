# Gforce Flight Log

Tandem paragliding flight logger PWA.

## Pilot Portal Mode (API)

The app now works in two modes:

**Standalone mode:** Works offline, stores flights in browser localStorage. No account needed.

**Portal mode:** Logs into a shared API server. Flights sync to a central database and notify office staff in real time.

### URLs

- **Pilot app:** https://brookewhatnall.github.io/gforce-flight-log
- **Staff dashboard:** https://brookewhatnall.github.io/gforce-staff-dashboard
- **API server:** Deploy the `gforce-api` repo to Render

## Development

```bash
# Pilot app (static, just open index.html or serve with any static server)
npx serve .

# Staff dashboard (static)
cd ../gforce-staff-dashboard && npx serve .

# API server
cd ../gforce-api && npm install && npm start
```

## Pilot App: Standalone vs Portal Mode

The pilot app detects the API URL automatically:
- On localhost → uses `http://localhost:3000`
- On GitHub Pages → uses the deployed API URL

To change the API URL, edit the `API_BASE` constant in `index.html`.

## Portal Mode: How It Works

1. Pilot logs in with their name and PIN
2. When a flight is logged, the office staff dashboard receives a live WebSocket notification and the 90-minute timer stops
3. Office staff can start a "left office" timer for any pilot
4. If the timer expires without a landing report, an alert fires on the staff dashboard

## Deploying the API to Render

1. Create account at [render.com](https://render.com)
2. Connect your `gforce-api` GitHub repo
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables:
   - `JWT_SECRET` = a long random string
   - `OFFICE_PASSWORD` = your office staff password
6. Deploy

The free tier on Render works fine for development and small teams. The server sleeps after 15 minutes of inactivity and wakes on the first request.

## Adding Pilots

Connect to the SQLite database and run:

```sql
-- Generate a PIN hash in Node first:
-- require('bcryptjs').hashSync('1234', 10)

INSERT INTO pilots (id, name, pin_hash) VALUES (
  lower(hex(randomblob(16))),
  'New Pilot',
  '$2a$10$YOUR_HASH_HERE'
);
```

## Seeded Demo Account

- Pilot: **Brooke**
- PIN: **1234**
- Office password: **office123** (set in `OFFICE_PASSWORD` env var)
