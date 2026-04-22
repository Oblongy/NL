# TCP Server Performance Optimization

## Problem
The tcp-server.js had O(n) linear scans in hot paths that were executed dozens of times per second during races:

1. **findConnectionByPlayerId**: Scanned all connections on every lookup
2. **findRaceForConnection**: Scanned all races when raceId wasn't cached
3. **S/I packet handling**: Called findRaceForConnection on every position sync packet (dozens per second)

## Solution
Implemented O(1) reverse lookup maps to eliminate linear scans:

### New Data Structures
```javascript
this.connIdByPlayerId = new Map(); // playerId -> connId
this.raceIdByPlayerId = new Map(); // playerId -> raceId
```

### Optimized Methods

#### findConnectionByPlayerId
- **Before**: O(n) scan through all connections
- **After**: O(1) lookup via `connIdByPlayerId` map
- **Fallback**: O(n) scan only if cache miss (rare)

#### findRaceForConnection
- **Before**: O(n) scan through all races if raceId not cached
- **After**: O(1) lookup via `raceIdByPlayerId` map
- **Fallback**: O(n) scan only if cache miss (rare)

### Cache Management

#### Set Operations
- Login (L message): Set `connIdByPlayerId` when player logs in
- Race creation (RRS): Set `raceIdByPlayerId` for both players
- SRC (race channel): Update both maps when player opens race channel

#### Delete Operations
- Connection cleanup (end/close/error): Remove from both maps
- Race cleanup: Remove `raceIdByPlayerId` for all race players
- Stale connection removal: Clean up reverse lookups
- Stale race cleanup: Remove all player mappings

## Performance Impact

### Before
- Every S/I packet: O(n) race scan + O(n) connection scan
- With 10 active races and 20 connections: ~30 iterations per packet
- At 30 packets/second: ~900 iterations/second

### After
- Every S/I packet: O(1) map lookups
- With 10 active races and 20 connections: ~2 map lookups per packet
- At 30 packets/second: ~60 map lookups/second

**Result**: ~15x reduction in operations for position sync packets

## Code Changes
- Added reverse lookup maps in constructor
- Updated all player/race assignment points to set cache
- Updated all cleanup points to remove cache entries
- Modified lookup methods to use O(1) cache with O(n) fallback
- Ensured cache consistency across all code paths
