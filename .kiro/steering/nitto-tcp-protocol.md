---
inclusion: always
---

# Nitto 1320 Legends — TCP Protocol Reference

## Architecture Overview

The TCP server is implemented as `TcpServer` class in `backend/src/tcp-server.js`. It uses Node.js `net.createServer` and handles all game communication over a single persistent TCP connection per client (plus a second race-channel connection during races).

Key constants:
- `MESSAGE_DELIMITER = "\x04"` — end of message
- `FIELD_DELIMITER = "\x1e"` — field separator within a message
- Default port: `3724`

All data is read/written as `latin1` encoding. Incoming buffers are accumulated in `conn.buffer` and split on `MESSAGE_DELIMITER`.

## Connection Object (`conn`)

Each socket gets a `conn` object with these properties:

```js
{
  id,            // numeric connection ID
  socket,        // raw net.Socket
  buffer,        // partial message accumulation string
  playerId,      // null until authenticated
  sessionKey,    // null until L message received
  bootstrapSent, // whether lobby bootstrap was sent
  lobbyRoomsSent // whether room list was sent
}
```

Additional properties set after login: `username`, `carId`, `teamId`, `teamRole`, `raceId` (race channel only).

Server-level maps for O(1) lookups:
- `this.connections` — `connId → conn`
- `this.connIdByPlayerId` — `playerId → connId`
- `this.raceIdByPlayerId` — `playerId → raceId`
- `this.rooms` — `roomId → [{ connId, playerId, username, carId, teamId, teamRole }]`
- `this.races` — `raceId (UUID) → race session`
- `this.pendingRaceChallenges` — `raceGuid → challenge`

## Cipher

All game messages are encrypted/decrypted with the Nitto wheel cipher (`nitto-cipher.js`):
- **Decode**: `decodePayload(rawMessage)` → `{ decoded, seed }`
- **Encode**: `encryptPayload(message, seed)` — seed is a random integer 10–99

Some bootstrap messages arrive as plain text; `handleMessage` falls back gracefully if `decodePayload` throws.

Sending a message:
```js
const seed = Math.floor(Math.random() * 90) + 10;
const encrypted = encryptPayload(message, seed);
conn.socket.write(Buffer.from(encrypted + MESSAGE_DELIMITER, "latin1"));
```

Use `sendMessage(conn, message)` or `sendToPlayer(playerId, message)` — never write to sockets directly.

## Flash Cross-Domain Policy

Flash sends `<policy-file-request/>\0` as the very first bytes on any TCP connection. Detect it in `handleData` before any cipher processing and respond immediately:

```xml
<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd"><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0
```

Return after writing — do not process as a game message.

## Message Dispatch Pattern

After decoding, split on `FIELD_DELIMITER` to get `parts[]`. `parts[0]` is the `messageType`.

Dispatch order matters — check these **before** the generic single-char handler:
1. `I` — in-race position sync (forward raw, no ack)
2. `S` — in-race state sync (forward raw, no ack)
3. Named multi-char types (`L`, `HTI`, `LRCR2`, `JRC`, etc.)
4. Single-char fallback — ack with `"ac", "<type>", "s", 1` and send lobby bootstrap

## Message Type Reference

### Client → Server

| Type | Description | Server Response |
|------|-------------|-----------------|
| `L` | Login with session key | `"ac", "L", "s", 1, "ni", 1000, "ns", 30, "tid", 1, "trp", 0, "trbp", 0, "lft", "0.5"` + `GNL` |
| `HTI` | Heartbeat | `"ac", "HTI", "s", "<i ut='...' s='1' li='1' it='1'/>"` |
| `LRCR2` | Get room list | `"ac", "LRCR2", "d", "<rooms>...</rooms>"` |
| `JRC` | Join room | `JR` + `LR` + `LRCU` ×2 |
| `GR` | Get race (after join) | `"ac", "GR", "s", 1` — **must ack or client times out** |
| `TC` | Team/channel select | `"ac", "TC", "s", 1` |
| `RRQ` | Race request/challenge | `"ac", "RRQ", "s", 1` + send `UCU` + `RCLG` to target |
| `RRS` | Accept challenge | `"ac", "RRS", "s", 1, "i", "<raceId>"` |
| `RO` | Race open | `"ac", "RO", "t", <trackId>` + IO frames |
| `RR` | Race result | `"ac", "RR", "s", 1` + `UR` + `OR` |
| `RD` | Race done/data | `"ac", "RD", "s", 1` — **must ack**; triggers engine wear even without prior `RR` |
| `SRC` | Start Race Connection (second TCP conn) | `"ac", "SRC", "s", 1` → `RRA` → `RO` → IO frames |
| `I` | In-race position sync | **Forward raw encrypted bytes to opponent — do NOT ack** |
| `S` | In-race state sync | **Forward raw encrypted bytes to opponent — do NOT ack** |
| `LO` | Logout | Close socket |
| `TE`/`CRC` | Chat message | Broadcast `TE` to room |

### Server → Client

| Type | Description |
|------|-------------|
| `LRCU` | Room user list — `<ul><u i='' un='' .../></ul>` |
| `LR` | Room queue — `<q><r i='' icid='' .../></q>` |
| `UCU` | User came up (challenger info) |
| `RCLG` | Race challenge — `<r i='' ci='' icid='' cicid='' bt='' b='' r='<guid>'/>` |
| `RN` | Race next/announce — `<q><r i='' icid='' ci='' cicid=''/></q>` |
| `RRA` | Race ready announce — `<r r1id='' r2id='' r1cid='' r2cid='' b1='-1' b2='-1' bt='0' sc1='0' sc2='0' t='<trackId>'/>` |
| `RO` | Race open — `"ac", "RO", "t", <trackId>` |
| `IO` | Initial position frames — sent after `RO` |
| `GNL` | Buddy list — `<buddies></buddies>` |

## I/S Packet Forwarding

`I` packets carry high-frequency physics sync data:
```
I\x1e<distance>\x1e<velocity>\x1e<acceleration>\x1e<frame>
```

Forward the **raw encrypted bytes** directly to the opponent's socket — do not decrypt, re-encrypt, or ack. If `conn.raceId` is not set (race channel not yet linked), scan `this.races` by `playerId` to find the race.

## SRC — Second TCP Connection (Race Channel)

Flash opens a second TCP connection when a race starts. First message is:
```
SRC\x1e<sessionKey>[\x1e<raceGuid>]
```

Server must:
1. Look up player from session key (same as `L` login)
2. Find active race by GUID hint or scan `this.races` for the player
3. Set `conn.raceId`
4. Respond: SRC ack → `RRA` → `RO` → initial IO frames

## Race Flow Sequence

```
L → HTI → LRCR2 → JRC → GR
→ RRQ (challenger) → RCLG (server notifies target) → RRS (target accepts)
→ RN + RRA + RO + IO frames (broadcast to both players)
→ [race in progress — I/S packets forwarded between players]
→ RD (race done data) → RR (race result)
```

Race sessions are stored in `this.races` with UUID keys. `conn.raceId` links a connection to its race.

## Initial IO Frames

Sent after `RO` to bootstrap race physics. Values come from live capture data — do not approximate:

```js
{ d: "-13",     v: "0",     a: "0",      t: "0" }
{ d: "-12.863", v: "0.698", a: "36.072", t: "0" }
{ d: "-12.709", v: "1.213", a: "31.555", t: "0" }
```

Format: `"ac", "IO", "d", <d>, "v", <v>, "a", <a>, "t", <t>`

## Track IDs

Default track: `32`. Track ID is carried in `RRA` (`t=` attribute) and `RO` (`t` field).

## XML Helpers

Use `escapeXml(value)` for any user-supplied data embedded in XML attributes. Use `escapeForTcp(value)` for values embedded in TCP message fields (escapes `\x1e` and `\x04`).

Builder methods for common XML payloads: `buildUcuXml`, `buildRclgXml`, `buildRnXml`, `buildRraXml`, `buildLobbyRoomsXml`, `buildRoomQueueXml`, `buildRoomUsersXml`.

## Key Implementation Rules

- **Never invent protocol values** — all timing arrays, attribute names, and field values must come from decompiled Flash source (`tmp_ffdec_*`) or live capture data.
- `I` and `S` must be checked **before** the single-char bootstrap handler to avoid misrouting.
- Single-char types not matching `I`/`S` are bootstrap handshake packets — ack with `"ac", "<type>", "s", 1` and send lobby bootstrap.
- `RD` without a prior `RR` must still be acked and trigger engine wear.
- Pending challenges are cleaned up every 5 minutes via `cleanupStaleChallenges()`.
- Race pair deduplication uses `buildRacePairKey(playerAId, playerBId)` (sorted, joined with `:`).
