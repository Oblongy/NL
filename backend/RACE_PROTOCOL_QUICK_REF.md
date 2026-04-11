# Race Protocol Quick Reference

## Message Flow Diagram

```
LOBBY CONNECTION                    RACE CHANNEL CONNECTION
================                    =======================

Player A          Server          Player B
   |                |                |
   |----L---------->|                |          Login
   |<---ac,L--------|                |
   |                |                |
   |----LRCR2------>|                |          Get rooms
   |<---ac,LRCR2----|                |
   |                |                |
   |----JRC-------->|                |          Join room
   |<---ac,JR-------|                |
   |<---ac,LR-------|                |
   |<---ac,LRCU-----|                |
   |                |<----JRC--------|
   |                |-----ac,JR----->|
   |                |-----ac,LR----->|
   |                |-----ac,LRCU--->|
   |<---ac,LRCU-----|-----ac,LRCU--->|
   |                |                |
   |----RRQ-------->|                |          Challenge
   |<---ac,RRQ------|                |
   |                |-----UCU------->|
   |                |-----RCLG------>|          (with GUID)
   |                |                |
   |                |<----RRS--------|          Accept
   |                |-----ac,RRS---->|
   |----RRS-------->|                |          Confirm
   |<---ac,RRS------|                |
   |                |                |
   |<---ac,RN-------|-----ac,RN----->|          Race announce
   |<---ac,RRA------|-----ac,RRA---->|          Race ready
   |<---ac,RO-------|-----ac,RO----->|          Race open
   |<---ac,IO-------|-----ac,IO----->|          Initial frames
   |                |                |
   |                |                |
   |                |                |          [NEW CONNECTIONS]
   |                |                |
   A-Race          |          B-Race
      |            |            |
      |---SRC----->|            |               Race channel open
      |<--ac,SRC---|            |
      |<--ac,RRA---|            |
      |<--ac,RO----|            |
      |<--ac,IO----|            |
      |            |<---SRC-----|
      |            |----ac,SRC->|
      |            |----ac,RRA->|
      |            |----ac,RO-->|
      |            |----ac,IO-->|
      |            |            |
      |---I------->|            |               Position sync
      |            |----I------>|               (forwarded raw)
      |            |<---I-------|
      |<---I-------|            |               (forwarded raw)
      |            |            |
      [... race continues with I/S packets ...]
      |            |            |
      |            |            |
   A-Lobby        |        B-Lobby             [BACK TO LOBBY]
      |            |            |
      |---RR------>|            |               Race result
      |<--ac,RR----|            |
      |<--ac,UR----|            |
      |<--ac,OR----|            |
      |            |<---RR------|
      |            |----ac,RR-->|
      |            |----ac,UR-->|
      |            |----ac,OR-->|
      |            |            |
      |---RD------>|            |               Race done
      |<--ac,RD----|            |
      |            |<---RD------|
      |            |----ac,RD-->|
      |            |            |
      [Race cleaned up after both RD received]
```

## Connection Types

### Lobby Connection
- **Purpose**: Room management, chat, race setup
- **Lifetime**: Persistent (entire session)
- **Messages**: L, HTI, LRCR2, JRC, LRC, GR, TC, RRQ, RRS, RN, RRA, RO, RR, RD, TE, CRC, LO
- **Identifier**: `conn.roomId` is set

### Race Channel Connection  
- **Purpose**: High-frequency position sync
- **Lifetime**: Temporary (during race only)
- **Messages**: SRC, I, S
- **Identifier**: `conn.raceId` is set, `conn.roomId` is NOT set

## Critical Rules

### 1. I and S Packets
```javascript
// ❌ WRONG - Do not ack
if (messageType === "I") {
  this.sendMessage(conn, '"ac", "I", "s", 1');  // NO!
}

// ✅ CORRECT - Forward raw to opponent
if (messageType === "I") {
  opponentConn.socket.write(
    Buffer.from(conn._lastRaw + MESSAGE_DELIMITER, "latin1")
  );
  // No ack!
}
```

### 2. Connection Lookup
```javascript
// ❌ WRONG - May return race channel
const conn = this.findConnectionByPlayerId(playerId);
this.sendMessage(conn, '"ac", "LRCU", ...');  // Fails if race channel

// ✅ CORRECT - Exclude race channels for lobby messages
const conn = this.findConnectionByPlayerId(playerId, true);
this.sendMessage(conn, '"ac", "LRCU", ...');
```

### 3. Race Player Lookup
```javascript
// ❌ WRONG - Fails when RRS comes from lobby connection
const player = race.players.find(p => p.connId === conn.id);

// ✅ CORRECT - Match by playerId
const player = race.players.find(p => 
  Number(p.playerId) === Number(conn.playerId)
);
```

### 4. SRC Handling
```javascript
// ✅ CORRECT - Update race player's connId to race channel
const racePlayer = race.players.find(p => 
  Number(p.playerId) === Number(conn.playerId)
);
if (racePlayer) {
  racePlayer.connId = conn.id;  // Now points to race channel
}
```

## Message Format Reference

### RRQ (Race Request)
```
RRQ <requesterCarId> <targetPlayerId> <targetCarId> <lane> <bracketTime>
```
Example: `RRQ\x1e1\x1e2\x1e1\x1e1\x1e-1`

### RCLG (Race Challenge)
```xml
<r i='<challengerPlayerId>' ci='<challengedPlayerId>' 
   icid='<challengerCarId>' cicid='<challengedCarId>' 
   bt='0' b='<bracketTime>' r='<raceGuid>'/>
```

### RRS (Race Ready Status)
```
RRS <raceGuid>
```
Example: `RRS\x1e550e8400-e29b-41d4-a716-446655440000`

### SRC (Start Race Connection)
```
SRC <sessionKey> <raceGuid>
```
Example: `SRC\x1eabc123\x1e550e8400-e29b-41d4-a716-446655440000`

### I (Position Sync)
```
I <distance> <velocity> <acceleration> <frame>
```
Example: `I\x1e1177.41\x1e364.607\x1e34.355\x1e7088`

### RRA (Race Ready Announce)
```xml
<r r1id='<player1Id>' r2id='<player2Id>' 
   r1cid='<car1Id>' r2cid='<car2Id>' 
   b1='-1' b2='-1' bt='0' sc1='0' sc2='0' t='<trackId>'/>
```

## Timing Reference

| Event | Typical Timing |
|-------|---------------|
| RRQ → RCLG | < 100ms |
| RRS → RN/RRA | < 500ms |
| SRC → race start | < 1000ms |
| I packet frequency | ~33ms (30 Hz) |
| Race duration | 10-15 seconds |
| RR → RD | < 2000ms |

## State Machine

```
IDLE
  ↓ (L)
LOGGED_IN
  ↓ (JRC)
IN_ROOM
  ↓ (RRQ/RRS)
RACE_PENDING
  ↓ (RN/RRA)
RACE_ANNOUNCED
  ↓ (SRC)
RACE_ACTIVE
  ↓ (RR)
RACE_FINISHING
  ↓ (RD)
RACE_COMPLETE
  ↓
IN_ROOM
```

## Debugging Commands

### Check active races
```javascript
console.log('Active races:', this.races.size);
for (const [id, race] of this.races) {
  console.log(`  ${id}:`, race.players.map(p => 
    `P${p.playerId} (conn ${p.connId})`
  ));
}
```

### Check player connections
```javascript
const playerId = 123;
const conns = [];
for (const [id, conn] of this.connections) {
  if (conn.playerId === playerId) {
    conns.push({
      id,
      type: conn.roomId ? 'lobby' : 'race',
      raceId: conn.raceId
    });
  }
}
console.log(`Player ${playerId} connections:`, conns);
```

### Monitor I/S packets
```javascript
// In handleMessage, add:
if (messageType === 'I' || messageType === 'S') {
  const parts = decodedMessage.split(FIELD_DELIMITER);
  console.log(`[${conn.id}] ${messageType}:`, {
    distance: parts[1],
    velocity: parts[2],
    raceId: conn.raceId,
    forwarded: !!syncRace
  });
}
```

## Common Issues

### Issue: "I/S packet received without active race"
**Cause**: Race channel connection doesn't have `conn.raceId` set
**Fix**: Ensure SRC properly sets `conn.raceId` and updates `race.players[].connId`

### Issue: "RRS received from unknown race player"
**Cause**: Looking up player by `connId` instead of `playerId`
**Fix**: Use `playerId` for lookup since RRS comes from lobby connection

### Issue: Cars not moving for opponent
**Cause**: I packets not being forwarded
**Fix**: Check that race channel connections are properly linked in race object

### Issue: Multiple connections per player
**Cause**: Normal - one lobby, one race channel
**Fix**: Use `excludeRaceChannels` parameter when looking up lobby connection

## Performance Tips

1. **Minimize I/S packet processing** - Forward raw, don't decode
2. **Use Map for race lookup** - O(1) instead of O(n)
3. **Cache connection lookups** - Store in race object
4. **Batch cleanup** - Don't clean up race until both RD received
5. **Limit logging** - Use debug level for I/S packets
