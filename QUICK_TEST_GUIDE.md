# Quick Local Test Guide

## Current Backend Config

These values match the active `backend/.env` in this workspace:

- HTTP: `http://localhost:8082`
- TCP: `localhost:3724`
- Backend folder: `backend/`

## Start The Backend

From the repo root:

```bash
cd backend
npm start
```

For auto-reload during development:

```bash
cd backend
npm run dev
```

## Quick Health Check

Once the backend is running, verify the HTTP side:

```bash
curl http://localhost:8082/healthz
```

Expected result:

```text
ok
```

You can also open the local helper page at [`test-local.html`](/mnt/c/Users/Dilldo/Music/Library/1320L/test-local.html), which is configured for the same ports.

## If The Game Still Tries Port 80

The legacy client may still request `http://<game-host>:80/...`.

### Option 1: Proxy Port 80 Traffic To `8082`

Use Fiddler or Charles and rewrite requests to the local backend:

- Match: `regex:^http://.*:80/gameCode1_00\.aspx`
- Action: `http://localhost:8082/gameCode1_00.aspx`
- Match: `regex:^http://.*:80/`
- Action: `http://localhost:8082/`

### Option 2: Run The Backend On Port 80

If you want the backend to answer directly on port `80`:

1. Free port `80`
2. Change `PORT=8082` to `PORT=80` in `backend/.env`
3. Restart the backend

Only do this if you actually want to replace the current local `8082` setup.

## What To Watch For

Success signs:

- `TCP connection opened`
- `TCP login complete`
- `TCP forwarded I/S packet`
- Both clients stay connected through race start and finish

Problem signs:

- `Connection Error 008`
- One car frozen while the other moves
- Repeated `TCP I/S packet received without active race`
- Disconnects after `RRQ`, `RRS`, or `SRC`

## Where To Watch Logs

Watch the terminal where `npm start` or `npm run dev` is running. The current backend writes logs to stdout by default.

If you want a saved log while testing:

```bash
cd backend
npm start 2>&1 | tee ../backend-run.log
```
