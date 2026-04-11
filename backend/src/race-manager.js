export class RaceInstance {
  constructor(id, roomId, type, players, trackId) {
    this.id = id; // Unique ID for this race instance
    this.roomId = roomId; // ID of the room it originated from
    this.type = type; // Type of race (e.g., "team", "tournament")
    this.players = players; // Array of player objects participating in this race
    this.trackId = trackId; // ID of the chosen track for the race
    this.status = "pending"; // "pending", "running", "completed", "cancelled"
    this.startTime = null; // Timestamp when the race officially starts
    this.results = new Map(); // Map to store player results (playerId -> result data)
  }

  // Methods to update status, record results, etc.
  startRace() {
    this.status = "running";
    this.startTime = Date.now();
    // Potentially notify players or other systems
  }

  completeRace(playerResults) {
    this.status = "completed";
    playerResults.forEach(result => {
      this.results.set(result.playerId, result);
    });
    // Potentially calculate overall standings, award prizes, etc.
  }

  cancelRace() {
    this.status = "cancelled";
    // Notify players
  }
}

export class RaceManager {
  constructor() {
    this.activeRaces = new Map(); // Stores active RaceInstance objects (raceId -> RaceInstance)
    this.nextRaceId = 1; // Simple counter for unique race IDs
  }

  createRace(roomId, roomType, players, trackId) {
    const raceId = this.nextRaceId++;
    const newRace = new RaceInstance(raceId, roomId, roomType, players, trackId);
    this.activeRaces.set(raceId, newRace);
    return newRace;
  }

  getRace(raceId) {
    return this.activeRaces.get(raceId) || null;
  }

  removeRace(raceId) {
    return this.activeRaces.delete(raceId);
  }

  // Other methods to manage race lifecycle, e.g., update player progress, handle disconnections, etc.
}
