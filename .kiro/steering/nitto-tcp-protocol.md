---
inclusion: always
---

# Nitto 1320 Legends — TCP Protocol Reference

## Flash Cross-Domain Policy

Flash sends `<policy-file-request/>\0` as the very first bytes on any raw TCP connection before it will allow game data to flow. The server must detect this and respond immediately with:

```xml
<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd"><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0
```

Then return — do not process it as a game message.

## Message Format

All TCP messages use the Nitto wheel cipher (nitto-cipher.js). Delimiter: `\x04` (end of message), `\x1e` (field separator).

Decoded format: `messageType\x1efield1\x1efield2...`

## Message Type Reference

| Type | Direction | Description | Server Response |
|------|-----------|-------------|-----------------|
| `L` | C→S | Login with session key | `"ac", "L", "s", 1, "ni", 1000, "ns", 30, "tid", 1, "trp", 0, "trbp", 0, "lft", "0.5"` + `GNL` |
| `HTI` | C→S | Heartbeat | `"ac", "HTI", "s", "<i ut='...' s='1' li='1' it='1'/>"` |
| `LRCR2` | C→S | Get room list | `"ac", "LRCR2", "d", "<rooms>...</rooms>"` |
| `JRC` | C→S | Join room | `JR` + `LR` + `LRCU` x2 |
| `GR` | C→S | Get race (after join) | `"ac", "GR", "s", 1` — **must ack or client times out** |
| `TC` | C→S | Team/channel select | `"ac", "TC", "s", 1` |
| `RRQ` | C→S | Race request/challenge | `"ac", "RRQ", "s", 1` + send `UCU` + `RCLG` to target |
| `RRS` | C→S | Race ready / accept challenge | `"ac", "RRS", "s", 1, "i", "<raceId>"` |
| `RO` | C→S | Race open | `"ac", "RO", "t", <trackId>` + IO frames |
| `RR` | C→S | Race result | `"ac", "RR", "s", 1` + `UR` + `OR` |
| `RD` | C→S | Race done/data | `"ac", "RD", "s", 1` — **must ack** |
| `SRC` | C→S | Start Race Connection (second TCP connection) | `"ac", "SRC", "s", 1` + link to race + send `RRA` + `RO` + IO frames |
| `I` | C→S | In-race position sync | **Forward raw to opponent — do NOT ack** |
| `S` | C→S | In-race state sync | **Forward raw to opponent — do NOT ack** |
| `LO` | C→S | Logout | Close socket |
| `TE`/`CRC` | C→S | Chat message | Broadcast `TE` to room |

## I Packet Format

```
I\x1e<distance>\x1e<velocity>\x1e<acceleration>\x1e<frame>
```

Example decoded: `I\x1e1177.41\x1e364.607\x1e34.355\x1e7088`

These are high-frequency physics sync packets. Forward the raw encrypted bytes directly to the opponent connection — do not decrypt, re-encrypt, or ack.

## SRC — Second TCP Connection (Race Channel)

The Flash client opens a **second** TCP connection when a race starts. The first message on this connection is `SRC` carrying the session key:

```
SRC\x1e<sessionKey>[\x1e<raceGuid>]
```

Server must:
1. Look up player from session key (same as `L` login)
2. Find the active race by GUID hint or by scanning `this.races` for the player
3. Link `conn.raceId` to the race
4. Respond: `SRC ack` → `RRA` → `RO` → initial IO frames

## Race Flow Sequence

```
L → HTI → LRCR2 → JRC → GR
→ RRQ (challenger sends) → RCLG (server notifies target) → RRS (target accepts)
→ RN + RRA + RO + IO frames (server broadcasts to both)
→ [race runs — I packets forwarded between players]
→ RD (race done data) → RR (race result)
```

## Server-to-Client Messages

| Type | Description |
|------|-------------|
| `LRCU` | Room user list update — `<ul><u i='' un='' .../></ul>` |
| `LR` | Room queue — `<q><r i='' icid='' .../></q>` |
| `UCU` | User came up (challenger info) |
| `RCLG` | Race challenge — `<r i='' ci='' icid='' cicid='' bt='' b='' r='<guid>'/>` |
| `RN` | Race next/announce — `<q><r i='' icid='' ci='' cicid=''/></q>` |
| `RRA` | Race ready announce — `<r r1id='' r2id='' r1cid='' r2cid='' b1='-1' b2='-1' bt='0' sc1='0' sc2='0' t='<trackId>'/>` |
| `RO` | Race open — `"ac", "RO", "t", <trackId>` |
| `IO` | Initial position frames — sent after RO |
| `GNL` | Buddy list — `<buddies></buddies>` |

## Initial IO Frames

Sent after `RO` to bootstrap the race physics:

```javascript
{ d: "-13", v: "0", a: "0", t: "0" }
{ d: "-12.863", v: "0.698", a: "36.072", t: "0" }
{ d: "-12.709", v: "1.213", a: "31.555", t: "0" }
```

Format: `"ac", "IO", "d", <d>, "v", <v>, "a", <a>, "t", <t>`

## Track IDs

Default track: `32`. Track ID is carried in `RRA` (`t=` attribute) and `RO` (`t` field).

## Key Implementation Notes

- Single-char message types (`A`-`Z`, `0`-`9`) that are NOT `I` or `S` are bootstrap handshake packets — ack with `"ac", "<type>", "s", 1` and send lobby bootstrap
- `I` and `S` must be checked **before** the single-char bootstrap handler
- Race sessions in `this.races` use UUID keys; `conn.raceId` links a connection to its race
- When forwarding `I`/`S` packets, scan all races by `playerId` if `conn.raceId` is not set (race channel connection may not have it yet)
- `RD` arriving without a prior `RR` should still be acked and trigger engine wear
