// race-manager.js
// Fully integrated with TcpServer. No duplicate race state.

export class RaceManager {
  constructor(tcpServer) {
    this.tcpServer = tcpServer;
  }

  createRace(roomId, roomType, players, trackId) {
    // TcpServer already has a canonical race creation path.
    // We simply call into it.
    const raceId = `${Date.now()}-${Math.floor(Math.random() * 999999)}`;

    const race = {
      id: raceId,
      roomId,
      trackId,
      type: roomType,
      players: players.map(p => ({
        playerId: p.playerId,
        carId: p.carId,
        lane: p.lane,
        username: p.username,
        ready: false,
        opened: false,
        isStaged: false,
        stagedSince: 0,
        lastDistance: 0,
        connId: null,
        raceConnId: null,
      })),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      phase: "LOADED",
      announced: false,
      stagedCount: 0,
      allStagedSince: 0,
      sequenceStarted: false,
      rivalsReadyBroadcasted: false,
      resultBroadcasted: false,
      engineWearApplied: false,
      finishResults: new Map(),
      reactionTimes: new Map(),
      lastTelemetryByPlayer: new Map(),
      telemetryCountsByPlayer: new Map(),
      metaByPlayer: new Map(),
      rivalsReadyAcks: new Map(),
    };

    // Register race in TcpServer
    this.tcpServer.races.set(raceId, race);

    // Map players → race
    for (const p of race.players) {
      this.tcpServer.raceIdByPlayerId.set(Number(p.playerId), raceId);
    }

    return race;
  }

  getRace(raceId) {
    return this.tcpServer.races.get(String(raceId)) || null;
  }

  removeRace(raceId) {
    const race = this.tcpServer.races.get(String(raceId));
    if (!race) return false;

    this.tcpServer.clearRaceMappings(race);
    this.tcpServer.races.delete(String(raceId));
    return true;
  }
}