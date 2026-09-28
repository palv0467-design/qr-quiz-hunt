# QR Quiz Hunt — Digital Banking Competition

This is a complete starter deployment for the QR Quiz Hunt described by Eesh.

## Included

- Contestant mobile webpage
- Organiser/admin webpage
- Start QR + QR 1–10 generation
- Server-side 120-second QR-finding timer
- Server-side 30-second question timer
- Strict QR sequence enforcement
- Automatic disqualification for wrong answers
- Automatic disqualification when timers expire
- Visibility/background detection (first event warns, second disqualifies)
- Live organiser dashboard
- Question + hint editor
- Game settings
- Contestant reset
- SQLite persistence
- Admin authentication

## Run locally

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Set a strong `ADMIN_PASSWORD` and `JWT_SECRET`.
4. Run:

```bash
npm install
npm start
```

5. Open `http://localhost:3000/`.
6. Admin panel: `http://localhost:3000/admin.html`

## Important for the college event

Set `PUBLIC_BASE_URL` to the real HTTPS address before generating/printing QR codes, for example:

`https://your-domain.example`

Then restart the server and generate the QR images from the Admin > QR Codes page.

### Start QR
Keep the Start QR at the organiser table.

### Hidden QR codes
Print QR 1–10 and place them in the lobby in the intended locations.

### Anti-cheating limitation
A normal mobile browser cannot physically prevent a contestant from using another device or guarantee that the operating system will never allow app switching. This build detects the game page being backgrounded/hidden and records violations; after two visibility events it disqualifies the session. The server remains authoritative for QR order and timers.

## Production recommendation

Deploy the Node app on a service that supports a persistent filesystem/disk for SQLite, or replace SQLite with a hosted database such as PostgreSQL/Supabase before a large competition. Use HTTPS and a long random JWT secret.
