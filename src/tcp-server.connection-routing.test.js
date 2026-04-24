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

  return server;
}

test("findConnectionByPlayerId prefers the lobby socket when a race channel is also open", () => {
  const server = createServer();
  const lobbyConn = { id: 101, playerId: 7, roomId: 1, messages: [] };
  const raceConn = { id: 202, playerId: 7, raceId: "race-1", messages: [] };

  server.connections.set(lobbyConn.id, lobbyConn);
  server.connections.set(raceConn.id, raceConn);
  server.connIdByPlayerId.set(7, raceConn.id);

  assert.equal(server.findConnectionByPlayerId(7)?.id, lobbyConn.id);
  assert.equal(server.connIdByPlayerId.get(7), lobbyConn.id);
  assert.equal(server.findConnectionByPlayerId(7, true)?.id, lobbyConn.id);
  assert.equal(
    server.findConnectionByPlayerId(7, { preferRaceChannels: true })?.id,
    raceConn.id,
  );
});

test("findConnectionByPlayerId can exclude race-only sockets entirely", () => {
  const server = createServer();
  const raceConn = { id: 303, playerId: 9, raceId: "race-2", messages: [] };

  server.connections.set(raceConn.id, raceConn);
  server.connIdByPlayerId.set(9, raceConn.id);

  assert.equal(server.findConnectionByPlayerId(9, true), null);
  assert.equal(server.findConnectionByPlayerId(9)?.id, raceConn.id);
});

test("sendToPlayer keeps generic notifications on the lobby socket", () => {
  const server = createServer();
  const lobbyConn = { id: 404, playerId: 11, roomId: 2, messages: [] };
  const raceConn = { id: 505, playerId: 11, raceId: "race-3", messages: [] };

  server.connections.set(lobbyConn.id, lobbyConn);
  server.connections.set(raceConn.id, raceConn);
  server.connIdByPlayerId.set(11, raceConn.id);

  assert.equal(server.sendToPlayer(11, '"ac", "NIM", "s", 1'), true);
  assert.deepEqual(lobbyConn.messages, ['"ac", "NIM", "s", 1']);
  assert.deepEqual(raceConn.messages, []);
});

test("startPendingRace sends RO and captured IO bootstrap frames on the lobby sockets", () => {
  const server = createServer();
  const challengerConn = { id: 601, playerId: 21, roomId: 5, messages: [] };
  const challengedConn = { id: 602, playerId: 22, roomId: 5, messages: [] };

  server.connections.set(challengerConn.id, challengerConn);
  server.connections.set(challengedConn.id, challengedConn);

  const pending = {
    id: "race-guid-1",
    roomId: 5,
    trackId: 32,
    createdAt: Date.now(),
    challenger: {
      connId: challengerConn.id,
      playerId: challengerConn.playerId,
      carId: 111,
      lane: 0,
    },
    challenged: {
      connId: challengedConn.id,
      playerId: challengedConn.playerId,
      carId: 222,
      lane: 1,
    },
    bracketTime: -1,
    ready: {
      challenger: true,
      challenged: true,
    },
  };

  server.pendingRaceChallenges.set(pending.id, pending);
  server.startPendingRace(pending);

  for (const conn of [challengerConn, challengedConn]) {
    assert.equal(conn.messages.length, 6);
    assert.match(conn.messages[0], /^"ac", "RN", "d", "/);
    assert.match(conn.messages[1], /^"ac", "RRA", "d", "/);
    assert.equal(conn.messages[2], '"ac", "RO", "t", 32');
    assert.deepEqual(conn.messages.slice(3), [
      '"ac", "IO", "d", -13, "v", 0, "a", 0, "t", 0',
      '"ac", "IO", "d", -12.863, "v", 0.698, "a", 36.072, "t", 0',
      '"ac", "IO", "d", -12.709, "v", 1.213, "a", 31.555, "t", 0',
    ]);
  }
});
