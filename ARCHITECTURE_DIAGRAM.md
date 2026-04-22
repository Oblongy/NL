# Multiplayer Racing Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Flash Client A                          │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │  Lobby Connection    │      │  Race Channel Conn   │        │
│  │  (Persistent)        │      │  (Temporary)         │        │
│  │                      │      │                      │        │
│  │  • Room mgmt         │      │  • I packets (30Hz)  │        │
│  │  • Chat              │      │  • S packets         │        │
│  │  • Race setup        │      │  • Position sync     │        │
│  │  • Results           │      │                      │        │
│  └──────────┬───────────┘      └──────────┬───────────┘        │
└─────────────┼──────────────────────────────┼──────────────────┘
              │                              │
              │ L, JRC, RRQ, RRS, RR, RD    │ SRC, I, S
              │                              │
┌─────────────┼──────────────────────────────┼──────────────────┐
│             ▼                              ▼                   │
│  ┌──────────────────────────────────────────────────────┐     │
│  │              TCP Server (Port 3724)                  │     │
│  │                                                       │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │         Connection Manager                  │    │     │
│  │  │  • Tracks all connections (Map)             │    │     │
│  │  │  • Associates playerId with connections     │    │     │
│  │  │  • Distinguishes lobby vs race channels     │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │                                                       │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │         Room Manager                        │    │     │
│  │  │  • Room membership (Map)                    │    │     │
│  │  │  • User lists                               │    │     │
│  │  │  • Chat routing                             │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │                                                       │     │
│  │  ┌─────────────────────────────────────────────┐    │     │
│  │  │         Race Manager                        │    │     │
│  │  │  • Active races (Map)                       │    │     │
│  │  │  • Pending challenges (Map)                 │    │     │
│  │  │  • I/S packet forwarding                    │    │     │
│  │  │  • Race lifecycle                           │    │     │
│  │  └─────────────────────────────────────────────┘    │     │
│  │                                                       │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                 │
│                         Backend Server                          │
└─────────────┬──────────────────────────────┬──────────────────┘
              │                              │
              │ L, JRC, RRQ, RRS, RR, RD    │ SRC, I, S
              │                              │
┌─────────────┼──────────────────────────────┼──────────────────┐
│             ▼                              ▼                   │
│  ┌──────────────────────┐      ┌──────────────────────┐       │
│  │  Lobby Connection    │      │  Race Channel Conn   │       │
│  │  (Persistent)        │      │  (Temporary)         │       │
│  │                      │      │                      │       │
│  │  • Room mgmt         │      │  • I packets (30Hz)  │       │
│  │  • Chat              │      │  • S packets         │       │
│  │  • Race setup        │      │  • Position sync     │       │
│  │  • Results           │      │                      │       │
│  └──────────────────────┘      └──────────────────────┘       │
│                         Flash Client B                         │
└────────────────────────────────────────────────────────────────┘
```

## Connection Lifecycle

```
Player A                                                    Player B
   │                                                           │
   │ ┌─────────────────────────────────────────────────────┐ │
   │ │ Phase 1: Lobby Connection Establishment             │ │
   │ └─────────────────────────────────────────────────────┘ │
   │                                                           │
   ├──[TCP Connect]──────────────────────────────────────────┤
   │                                                           │
   ├──[L: Login]──────────────────────────────────────────────┤
   │                                                           │
   ├──[JRC: Join Room]────────────────────────────────────────┤
   │                                                           │
   │ ┌─────────────────────────────────────────────────────┐ │
   │ │ Phase 2: Race Challenge                             │ │
   │ └─────────────────────────────────────────────────────┘ │
   │                                                           │
   ├──[RRQ: Challenge]────────────────────────────────────────┤
   │                                                           │
   │                                    [RCLG: Notify]◄───────┤
   │                                                           │
   │                                    [RRS: Accept]─────────┤
   │                                                           │
   ├──[RRS: Confirm]──────────────────────────────────────────┤
   │                                                           │
   │◄─────────────────[RN, RRA, RO: Race Setup]──────────────►│
   │                                                           │
   │ ┌─────────────────────────────────────────────────────┐ │
   │ │ Phase 3: Race Channel Establishment                 │ │
   │ └─────────────────────────────────────────────────────┘ │
   │                                                           │
   ├──[New TCP Connect]───────────────────────────────────────┤
   │                                                           │
   ├──[SRC: Race Channel]─────────────────────────────────────┤
   │                                                           │
   │◄─────────────────[SRC ack, RRA, RO, IO]─────────────────►│
   │                                                           │
   │ ┌─────────────────────────────────────────────────────┐ │
   │ │ Phase 4: Race Execution (High Frequency)            │ │
   │ └─────────────────────────────────────────────────────┘ │
   │                                                           │
   ├──[I: Position]───────────────────────────────────────────┤
   │                                    [I: Position]◄────────┤
   │                                                           │
   ├──[I: Position]───────────────────────────────────────────┤
   │                                    [I: Position]◄────────┤
   │                                                           │
   │  [... continues at ~30 Hz for 10-15 seconds ...]         │
   │                                                           │
   │ ┌─────────────────────────────────────────────────────┐ │
   │ │ Phase 5: Race Completion (Back to Lobby)            │ │
   │ └─────────────────────────────────────────────────────┘ │
   │                                                           │
   ├──[RR: Result]────────────────────────────────────────────┤
   │                                                           │
   ├──[RD: Done]──────────────────────────────────────────────┤
   │                                                           │
   │                                    [RR: Result]◄─────────┤
   │                                                           │
   │                                    [RD: Done]◄───────────┤
   │                                                           │
   │◄─────────────────[Race Cleanup]─────────────────────────►│
   │                                                           │
```

## Data Structures

### Connection Object
```javascript
{
  id: 123,                    // Unique connection ID
  socket: Socket,             // TCP socket
  buffer: "",                 // Incoming data buffer
  playerId: 456,              // Associated player ID
  sessionKey: "abc123",       // Session key
  username: "Player1",        // Player username
  carId: 789,                 // Default car ID
  roomId: 1,                  // Current room (lobby only)
  raceId: "uuid",             // Current race (race channel only)
  bootstrapSent: true,        // Lobby bootstrap sent
  lobbyRoomsSent: true,       // Room list sent
  _lastRaw: "encrypted..."    // Last raw message (for forwarding)
}
```

### Race Object
```javascript
{
  id: "550e8400-e29b-41d4-a716-446655440000",  // Race GUID
  roomId: 1,                                    // Origin room
  trackId: 32,                                  // Track ID
  announced: true,                              // RN/RRA sent
  engineWearApplied: false,                     // Engine wear applied
  createdAt: 1234567890,                        // Timestamp
  players: [
    {
      connId: 123,           // Current connection ID (race channel)
      playerId: 456,         // Player ID
      carId: 789,            // Car ID
      lane: 1,               // Lane (1 or 2)
      bet: 0,                // Bet amount
      ready: true,           // Ready status
      opened: true           // RO received
    },
    {
      connId: 124,
      playerId: 457,
      carId: 790,
      lane: 2,
      bet: 0,
      ready: true,
      opened: true
    }
  ]
}
```

### Challenge Object
```javascript
{
  id: "550e8400-e29b-41d4-a716-446655440000",  // Challenge GUID
  roomId: 1,                                    // Origin room
  trackId: 32,                                  // Track ID
  createdAt: 1234567890,                        // Timestamp
  bracketTime: -1,                              // Bracket time
  challenger: {
    connId: 123,
    playerId: 456,
    carId: 789,
    username: "Player1",
    lane: 1
  },
  challenged: {
    connId: 124,
    playerId: 457,
    carId: 790,
    username: "Player2"
  },
  ready: {
    challenger: true,
    challenged: false
  }
}
```

## Message Routing

### Lobby Messages (via Lobby Connection)
```
┌──────────────┐
│   Client A   │
│ (Lobby Conn) │
└──────┬───────┘
       │
       │ RRQ (Challenge Player B)
       ▼
┌──────────────────┐
│   TCP Server     │
│                  │
│ 1. Validate      │
│ 2. Create GUID   │
│ 3. Store pending │
│ 4. Route to B    │
└──────┬───────────┘
       │
       │ RCLG (Challenge notification)
       ▼
┌──────────────┐
│   Client B   │
│ (Lobby Conn) │
└──────────────┘
```

### Race Messages (via Race Channel)
```
┌──────────────┐
│   Client A   │
│ (Race Chan)  │
└──────┬───────┘
       │
       │ I (Position: d=100, v=50)
       ▼
┌──────────────────┐
│   TCP Server     │
│                  │
│ 1. Find race     │
│ 2. Find opponent │
│ 3. Forward raw   │
│ 4. NO ACK        │
└──────┬───────────┘
       │
       │ I (Position: d=100, v=50) [raw forwarded]
       ▼
┌──────────────┐
│   Client B   │
│ (Race Chan)  │
└──────────────┘
```

## Critical Path Analysis

### Race Start Critical Path
```
Time    Event                           Duration    Cumulative
────────────────────────────────────────────────────────────────
0ms     Player A sends RRQ              -           0ms
10ms    Server receives RRQ             10ms        10ms
15ms    Server creates challenge        5ms         15ms
20ms    Server sends RCLG to B          5ms         20ms
30ms    Player B receives RCLG          10ms        30ms
        [Player B clicks Accept]
1000ms  Player B sends RRS              970ms       1000ms
1010ms  Server receives RRS             10ms        1010ms
1015ms  Server marks B ready            5ms         1015ms
        [Player A confirms]
1500ms  Player A sends RRS              485ms       1500ms
1510ms  Server receives RRS             10ms        1510ms
1515ms  Server marks A ready            5ms         1515ms
1520ms  Server sends RN/RRA to both     5ms         1520ms
1530ms  Both receive RN/RRA             10ms        1530ms
        [Clients open race channels]
2000ms  Player A sends SRC              470ms       2000ms
2010ms  Server receives SRC             10ms        2010ms
2015ms  Server links race channel       5ms         2015ms
2020ms  Server sends SRC ack + setup    5ms         2020ms
2100ms  Player B sends SRC              80ms        2100ms
2110ms  Server receives SRC             10ms        2110ms
2115ms  Server links race channel       5ms         2115ms
2120ms  Server sends SRC ack + setup    5ms         2120ms
2130ms  Race starts                     10ms        2130ms
────────────────────────────────────────────────────────────────
Total: ~2.1 seconds from challenge to race start
```

### I Packet Critical Path (During Race)
```
Time    Event                           Duration    Cumulative
────────────────────────────────────────────────────────────────
0ms     Player A physics update         -           0ms
1ms     Player A sends I packet         1ms         1ms
5ms     Server receives I packet        4ms         5ms
6ms     Server finds race               1ms         6ms
7ms     Server finds opponent conn      1ms         7ms
8ms     Server forwards raw bytes       1ms         8ms
12ms    Player B receives I packet      4ms         12ms
13ms    Player B updates opponent pos   1ms         13ms
────────────────────────────────────────────────────────────────
Total: ~13ms latency (acceptable for 30 Hz sync)
```

## Failure Modes

### Connection Loss During Race
```
Player A ──────X (disconnect)
                │
                ▼
         Server detects
                │
                ├─ Remove from race.players
                ├─ Check if race empty
                └─ Clean up if both gone
                │
                ▼
         Player B continues
         (opponent disappears)
```

### Race Channel Not Opened
```
Player A ──[RRS]──► Server ──[RN/RRA]──► Player B
                       │
                       ▼
                  Wait for SRC
                       │
                       ├─ Timeout after 30s
                       ├─ Clean up race
                       └─ Return to lobby
```

### I Packet Forwarding Failure
```
Player A ──[I]──► Server
                    │
                    ├─ Race not found?
                    │  └─ Fallback: search by playerId
                    │
                    ├─ Opponent conn invalid?
                    │  └─ Log error, continue
                    │
                    └─ Socket write fails?
                       └─ Catch error, log, continue
```

## Performance Characteristics

### Resource Usage Per Race
- Memory: ~1 KB (race object + 2 player objects)
- CPU: < 1% (mostly I/O bound)
- Network: ~6 KB/s (I packets at 30 Hz)
- Connections: 4 total (2 lobby + 2 race channels)

### Scalability Limits
- Max concurrent races: ~1000 (limited by CPU)
- Max I/S packets/sec: ~60,000 (30 Hz × 2 players × 1000 races)
- Max connections: ~4000 (2 per player × 2000 players)
- Memory at scale: ~100 MB base + 1 MB per 1000 races

### Bottlenecks
1. **I/S packet forwarding** - Most CPU intensive
2. **Connection lookup** - O(n) without optimization
3. **Race cleanup** - Requires both RD messages
4. **Logging** - Can slow down at high volume
