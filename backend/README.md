# Nitto Legends Community Backend

This backend keeps the old `gameCode1_00.aspx` action flow, but stores real data in Supabase.

The intended shape is:

1. Flash client talks to this backend only.
2. This backend decodes the legacy payload.
3. Implemented actions read and write Supabase tables.
4. Unimplemented actions fall back to your captured fixtures so the game can keep working while we port features over.

## Quick start

1. Create a Supabase project.
2. Run [schema.sql](/Users/Dilldo/Music/Library/1320%20V2.5/backend/supabase/schema.sql) in the Supabase SQL editor.
3. Copy `.env.example` to `.env` and fill in your project URL and service role key.
4. Run `npm install` inside [backend](/Users/Dilldo/Music/Library/1320%20V2.5/backend).
5. Keep the runtime fallback fixtures in `backend/fixtures/`.
6. Start the backend with `npm run dev`.

## Deploying to the VPS

For live updates from this Windows workspace, use the local deploy helper instead of manual file sync:

```powershell
cd backend
git add src/game-actions.js src/game-xml.js src/parts-xml.js
.\deploy_live.ps1
```

What it does:

- deploys staged backend files by default
- can deploy explicit files or the full tracked backend tree when requested
- leaves live `.env` and `node_modules/` alone
- backs up replaced or removed live files under `/opt/NL/backend/.deploy-backups/<timestamp>/`
- runs `node --check src/index.js`
- restarts `pm2` app `nl-backend`
- checks `http://127.0.0.1:8082/healthz`

You can also run it without the PowerShell wrapper:

```powershell
cd backend
$env:NL_VPS_PASSWORD = "..."
python tools/deploy_live.py --host 173.249.220.49 --user root
```

Useful flags:

- `.\deploy_live.ps1 -DryRun`
- `.\deploy_live.ps1 -Files src/game-actions.js,src/game-xml.js,src/parts-xml.js`
- `.\deploy_live.ps1 -AllTracked`
- `.\deploy_live.ps1 -SkipHealthcheck`

## Current real actions

- `login`
- `getuser`
- `getracerscars`
- `/Status.aspx`
- `/Upload.aspx`

Everything else currently falls back to fixtures loaded from `backend/fixtures/*.decoded_http_responses.json`.

## Starter Supabase tables

The starter schema now covers the first real community-server data slices:

- `game_players`
- `game_sessions`
- `game_cars`
- `game_teams`
- `game_team_members`
- `game_mail`

That gives us enough structure to start porting:

- login/profile flows
- garage and owned cars
- team membership and `teaminfo`
- mailbox/system messages

## Scaffold alignment

The backend now also includes the original-style support files shown in your screenshots:

- [race-room-registry.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/race-room-registry.js)
- [rivals-state.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/rivals-state.js)
- [session.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/session.js)
- [sms-message.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/sms-message.js)
- [tcp-notify.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/tcp-notify.js)
- [tcp-proxy.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/tcp-proxy.js)
- [tcp-server.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/tcp-server.js)
- [team-state.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/team-state.js)
- [user-service.js](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/user-service.js)
- [wheel-lookup.json](/Users/Dilldo/Music/Library/1320%20V2.5/backend/src/wheel-lookup.json)

## Why Supabase behind a backend

The Flash client should not talk directly to Supabase.

This backend keeps the service role key private, lets us preserve the original encrypted request format, and gives us room to keep matching the old game behavior one action at a time.

## Next good extensions

1. Port `teaminfo`
2. Port `getallcars`
3. Port `buyenginepart` and `buypart`
4. Move more login-side XML nodes from fixture/template mode to real database-backed payloads
