import test from "node:test";
import assert from "node:assert/strict";
import { TcpServer } from "./tcp-server.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createServer() {
  const server = new TcpServer({
    logger: createLogger(),
    notify() {},
    proxy: null,
    supabase: null,
  });
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;

  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };
  server.recordRaceDebugEvent = () => {};
  server.maybeBroadcastRivalsReady = () => {};
  server.maybeStartRaceSequence = () => {};

  return server;
}

function createConn(id, playerId) {
  return {
    id,
    playerId,
    messages: [],
    socket: {
      destroyed: false,
      writable: true,
      rawWrites: 0,
      rawFrames: [],
      write(buffer) {
        this.rawWrites += 1;
        this.rawFrames.push(Buffer.from(buffer).toString("latin1"));
      },
    },
  };
}

function bindRace(server, { sequenceStarted, lastStateUpdate, roomId = 5 } = {}) {
  const senderConn = createConn(801, 51);
  const opponentConn = createConn(802, 52);
  const race = {
    id: "race-telemetry-test",
    roomId,
    players: [
      { playerId: 51, connId: senderConn.id, opened: true },
      { playerId: 52, connId: opponentConn.id, opened: true },
    ],
    sequenceStarted: Boolean(sequenceStarted),
    lastStateUpdate: lastStateUpdate ?? 0,
  };

  senderConn.raceId = race.id;
  opponentConn.raceId = race.id;
  server.connections.set(senderConn.id, senderConn);
  server.connections.set(opponentConn.id, opponentConn);
  server.races.set(race.id, race);
  server.raceIdByPlayerId.set(senderConn.playerId, race.id);
  server.raceIdByPlayerId.set(opponentConn.playerId, race.id);

  return { race, senderConn, opponentConn };
}

test("handleRaceTelemetry does not relay prelaunch S frames before the race sequence starts", () => {
  const server = createServer();
  const { opponentConn, senderConn, race } = bindRace(server, {
    sequenceStarted: false,
  });

  server.handleRaceTelemetry(senderConn, "S", ["S", "-13", "0", "0"]);

  assert.deepEqual(opponentConn.messages, []);
  assert.equal(opponentConn.socket.rawWrites, 0);
  assert.equal(race.players[0].isStaged, false);
});

test("handleRaceTelemetry does not relay prelaunch team rivals frames before the race starts", () => {
  const server = createServer();
  const { opponentConn, senderConn, race } = bindRace(server, {
    sequenceStarted: false,
    roomId: 1,
  });

  server.handleRaceTelemetry(senderConn, "S", ["S", "-13", "0", "0"]);

  assert.deepEqual(opponentConn.messages, []);
  assert.equal(opponentConn.socket.rawWrites, 0);
  assert.equal(race.players[0].isStaged, false);
});

test("handleRaceTelemetry relays live I frames as IO with the tick preserved", () => {
  const server = createServer();
  const { opponentConn, senderConn } = bindRace(server, {
    sequenceStarted: true,
    lastStateUpdate: Date.now(),
  });

  server.handleRaceTelemetry(senderConn, "I", ["I", "12.345", "150.1", "4.2", "193"]);

  assert.deepEqual(opponentConn.messages, [
    '"ac", "IO", "d", 12.345, "v", 150.1, "a", 4.2, "t", 193',
  ]);
  assert.equal(opponentConn.socket.rawWrites, 0);
});

test("handleRaceTelemetry relays live team rivals frames as IO once the race starts", () => {
  const server = createServer();
  const { opponentConn, senderConn } = bindRace(server, {
    sequenceStarted: true,
    lastStateUpdate: Date.now(),
    roomId: 1,
  });

  server.handleRaceTelemetry(senderConn, "S", ["S", "12.345", "150.1", "4.2", "193"]);

  assert.deepEqual(opponentConn.messages, [
    '"ac", "IO", "d", 12.345, "v", 150.1, "a", 4.2, "t", 193',
  ]);
  assert.equal(opponentConn.socket.rawWrites, 0);
});

test("handleRaceTelemetry does not relay prelaunch koth frames before the race starts", () => {
  const server = createServer();
  const { opponentConn, senderConn, race } = bindRace(server, {
    sequenceStarted: false,
    roomId: 3,
  });

  server.handleRaceTelemetry(senderConn, "S", ["S", "-13", "0", "0"]);

  assert.deepEqual(opponentConn.messages, []);
  assert.equal(opponentConn.socket.rawWrites, 0);
  assert.equal(race.players[0].isStaged, false);
});

test("handleRaceMeta does not relay MO until the race sequence has started", () => {
  const server = createServer();
  const { opponentConn, senderConn } = bindRace(server, {
    sequenceStarted: false,
  });

  server.handleRaceMeta(senderConn, ["MO", "1", "2", "3"]);

  assert.deepEqual(opponentConn.messages, []);
});

test("handleRaceMeta relays MO after the race sequence has started", () => {
  const server = createServer();
  const { opponentConn, senderConn } = bindRace(server, {
    sequenceStarted: true,
  });

  server.handleRaceMeta(senderConn, ["MO", "1", "2", "3"]);

  assert.deepEqual(opponentConn.messages, [
    '"ac", "MO", 1, 2, 3',
  ]);
});
