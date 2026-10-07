# Compliance Dashboard — INSTALL

The Compliance Dashboard is already built into the Finance Suite. There is nothing separate to install. No new packages were added: it uses what the app already has (Express, multer, xlsx, React, lucide icons).

## Start it (normal use)

1. Double-click **`start-server.bat`** in the project folder (as you do today). A black window opens and says *Server running on http://localhost:3002*.
2. Open **http://localhost:3002** in the browser and sign in.
3. Click **Compliance Dashboard** in the sidebar.

## After any change to the code

| What changed | What to do |
|---|---|
| Anything in `server/` (including `server/compliance/`) | Close the server window and double-click `start-server.bat` again |
| Anything in `client/src/` | Rebuild: open a terminal and run `node "C:\Users\Parthiv Panchal\Desktop\Claude\build2.js"`, then refresh the browser |
| `server/compliance/config/compliance.config.json` | Nothing — it is read fresh on every request |

## First run

On the first request after the server starts, the module creates its data files in `server/compliance/data/` and loads the starting companies and compliances from `server/compliance/config/seed.json`. This happens once (it is migration v1).

## Run the tests

In a terminal in the project folder:

```
npm run test:compliance
```

All 49 tests should show `pass`. The tests use temporary folders and never touch your real data.

## Install on another computer (fresh copy)

1. Install Node.js (version 20 or newer; this PC uses 24).
2. Copy the project folder.
3. In the project folder run `npm install`, then `cd client`, `npm install`, `cd ..`.
4. Copy `.env` (Zoho keys) from the old computer. Never email it.
5. Build the client (`node build2.js`, or `npm run build` if the folder path has no `&`).
6. Start the server with `start-server.bat`.
7. Copy `server/compliance/data/` (your compliance data) and your document **Storage Root** folder from the old computer.

## Using a database (Neon) instead of files

If `DATABASE_URL` is set in `.env`, compliance data is stored in the same `kv_store` table the rest of the app uses (keys `compliance_data`, `compliance_audit`, `compliance_zoho_sync`, `compliance_settings`). Documents are still files in the Storage Root folder.
