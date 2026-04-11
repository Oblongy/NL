# Local Test Setup

## Goal

Run the active backend in `backend/` and point the legacy client at it for local testing.

## Active Local Settings

Current workspace settings:

- HTTP host: `127.0.0.1`
- HTTP port: `8082`
- TCP host: `0.0.0.0`
- TCP port: `3724`

These come from:

- [`backend/.env.example`](/mnt/c/Users/Dilldo/Music/Library/1320L/backend/.env.example)
- [`backend/src/config.js`](/mnt/c/Users/Dilldo/Music/Library/1320L/backend/src/config.js)

## 1. Start The Backend

```bash
cd /mnt/c/Users/Dilldo/Music/Library/1320L/backend
npm start
```

If you are changing code while testing:

```bash
cd /mnt/c/Users/Dilldo/Music/Library/1320L/backend
npm run dev
```

## 2. Verify The Backend Is Reachable

HTTP check:

```bash
curl http://localhost:8082/healthz
```

Legacy compatibility check:

```bash
curl http://localhost:8082/status.aspx
```

You should also see startup logs similar to:

```text
TCP server listening {"host":"0.0.0.0","port":3724}
Backend listening {"host":"127.0.0.1","port":8082,"tcpHost":"0.0.0.0","tcpPort":3724,...}
```

## 3. Point The Client At The Local Backend

There are two practical ways to do this.

### Method A: Proxy Port 80 To Port 8082

Use Fiddler or Charles if the client is hardcoded to request `http://...:80/...`.

Recommended rewrite rules:

- Match: `regex:^http://.*:80/gameCode1_00\.aspx`
- Action: `http://localhost:8082/gameCode1_00.aspx`
- Match: `regex:^http://.*:80/`
- Action: `http://localhost:8082/`

This is the least disruptive option because it keeps the backend on its current local port.

### Method B: Change The Backend To Port 80

If you do not want a proxy layer:

1. Stop anything using port `80`
2. Change `PORT=8082` to `PORT=80` in `backend/.env`
3. Restart the backend
4. Point the client at `http://localhost/`

Only use this if you are comfortable changing your local HTTP setup.

## 4. Optional Helper Page

[`test-local.html`](/mnt/c/Users/Dilldo/Music/Library/1320L/test-local.html) is configured for the current local backend:

- `serverURL=http://localhost:8082`
- `tcpHost=localhost`
- `tcpPort=3724`

Use it as a quick browser-side smoke test for the HTTP endpoint and embedded Flash configuration.

## 5. Monitor The Session

Watch the terminal running the backend. Useful log lines include:

- `TCP connection opened`
- `TCP message received`
- `TCP login complete`
- `TCP SRC received (race channel open)`
- `TCP forwarded I/S packet`
- `TCP race cleaned up`

## 6. Common Failure Cases

### HTTP works but the game does not load

Usually means the client is still trying to reach the original host or port `80`. Use the proxy method above or switch the backend to port `80`.

### Login works but racing breaks

Check for errors around:

- `RRQ`
- `RRS`
- `SRC`
- `I` and `S` packet forwarding

### The TCP port is already in use

Port `3724` is commonly used by Blizzard services. Either stop the conflicting service or change `TCP_PORT` in `backend/.env` and make sure the client is redirected to the same port.
