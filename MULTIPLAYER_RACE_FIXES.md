# Multiplayer Racing Fixes

## Overview
This document describes the critical fixes applied to the TCP server to resolve multiplayer racing issues in Nitto 1320 Legends.

## Root Causes Identified

### 1. Dual Connection Architecture Not Properly Handled
The Flash client opens **two separate TCP connections** for each race:
- **Lobby Connection**: Used for room management, chat, and race setup (RRQ, RRS, RN, RRA)
- **Race Channel Connection**: Opened via `SRC` message, used exclusively for high-frequency I/S packets during the race

**Problem**: The server was not properly tracking which connection was which, causing I/S packets to be forwarded to the wrong connection or not forwarded at all.

### 2. Connection ID Confusion
When a player accepts a race challenge (RRS), the server needs to:
1. Send race setup messages (RN, RRA, RO) to the **lobby connection**
2. Wait for the client to open a **race channel connection** via SRC
3. Forward all I/S packets through the **race channel connections** only

**Problem**: The server was using `connId` to track players, but each player has TWO connections during a race. The `connId` in the race object was being overwritten when SRC arrived, breaking the lobby connection reference.

### 3. I/S Packet Forwarding Issues
The protocol spec clearly states:
> "I and S must be checked BEFORE the single-char bootstrap handler"
> "Forward the raw encrypted bytes directly to the opponent connection — do NOT decrypt, re-encrypt, or ack"

**Problem**: 
- I/S packets were not being reliably forwarded to opponents
- Error handling was insufficient, causing silent failures
- Race lookup was failing when `conn.raceId` wasn't set

## Fixes Applied

### Fix 1: Enhanced Connection Lookup
```javascript
findConnectionByPlayerId(playerId, excludeRaceChannels = false)
```
- Now returns ALL connections for a player (lobby + race channel)
- Can filter to return only lobby connections when needed
- Prevents race channel connections from receiving lobby messages

### Fix 2: Improved SRC Handling
When a race channel opens via SRC:
- The race player's `connId` is updated to point to the race channel
- Old connection ID is logged for debugging
- Comprehensive logging shows the connection transition
- Race initialization messages are sent immediately

### Fix 3: Robust I/S Packet Forwarding
```javascript
// Find race via raceId or by scanning for this player
let syncRace = conn.raceId ? this.races.get(conn.raceId) : null;
if (!syncRace && conn.playerId) {
  for (const [, r] of this.races) {
    if (r.players.some(p => Number(p.playerId) === Number(conn.playerId))) {
      syncRace = r;
      conn.raceId = r.id;
      break;
    }
  }
}
```
- Fallback race lookup by playerId if `conn.raceId` isn't set
- Try/catch around socket writes to prevent crashes
- Debug logging for successful forwards
- Warning logging when race is missing

### Fix 4: Player Lookup by ID in RRS
```javascript
// Find player by playerId (not connId) since this might be the lobby connection
const player = existingRace.players.find((entry) => 
  Number(entry.playerId) === Number(conn.playerId)
);
```
- RRS messages come through the lobby connection
- Must look up player by `playerId`, not `connId`
- Prevents "unknown race player" errors

### Fix 5: Enhanced Logging
Added comprehensive logging at every critical point:
- Connection type identification (lobby vs race channel)
- Race state transitions
- I/S packet forwarding success/failure
- Player connection mapping

## Race Flow Sequence (Fixed)

### Phase 1: Challenge Setup (Lobby Connections)
```
Player A → RRQ → Server
Server → RCLG → Player B (lobby connection)
Player B → RRS → Server
Server → RN + RRA + RO → Both Players (lobby connections)
```

### Phase 2: Race Channel Establishment
```
Player A opens 2nd TCP connection → SRC → Server
Server updates race.players[0].connId to race channel
Server → SRC ack + RRA + RO + IO frames → Player A (race channel)

Player B opens 2nd TCP connection → SRC → Server
Server updates race.players[1].connId to race channel
Server → SRC ack + RRA + RO + IO frames → Player B (race channel)
```

### Phase 3: Race Execution (Race Channels)
```
Player A → I packet → Server → Player B (race channel)
Player B → I packet → Server → Player A (race channel)
[continues at ~30 Hz until race completes]
```

### Phase 4: Race Completion (Lobby Connections)
```
Player A → RR → Server → UR + OR acks
Player A → RD → Server → RD ack + engine wear
Player B → RR → Server → UR + OR acks
Player B → RD → Server → RD ack + cleanup race
```

## Testing Checklist

- [ ] Two players can challenge each other in a room
- [ ] Both players receive race setup messages (RN, RRA)
- [ ] Both players successfully open race channels (SRC)
- [ ] I/S packets flow bidirectionally during race
- [ ] Cars move smoothly for both players
- [ ] Race completes successfully with results
- [ ] Engine wear is applied correctly
- [ ] Race cleanup happens after both players send RD
- [ ] No connection leaks or stale races

## Key Protocol Rules

1. **Never ack I or S packets** - they are forwarded raw
2. **SRC establishes the race channel** - all I/S packets flow through it
3. **Lobby connection stays open** - used for RR/RD at race end
4. **Each player has 2 connections during a race** - lobby + race channel
5. **Race cleanup requires both RD messages** - prevents premature cleanup

## Debugging Tips

Enable debug logging to see:
```javascript
this.logger.debug("TCP forwarded I/S packet", {
  fromConnId: conn.id,
  toConnId: opponentConn.id,
  messageType,
  raceId: syncRace.id
});
```

Check for these warning signs:
- "TCP I/S packet received without active race" - race lookup failing
- "TCP SRC ack sent (no active race found)" - race not created before SRC
- "TCP RRS cannot find connection for player" - connection lookup failing
- "TCP I/S forward error" - socket write failing

## Performance Considerations

- I/S packets are sent at ~30 Hz (every 33ms)
- Each packet is ~50-100 bytes encrypted
- Total bandwidth per race: ~3-6 KB/s per player
- Race duration: typically 10-15 seconds
- Peak concurrent races: limited by room capacity

## Future Improvements

1. Add connection timeout detection for stale race channels
2. Implement race spectator support (forward I/S to multiple connections)
3. Add race replay recording (capture all I/S packets)
4. Implement tournament bracket management
5. Add anti-cheat validation for I/S packet data
