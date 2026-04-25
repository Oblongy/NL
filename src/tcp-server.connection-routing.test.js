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

  assert.equal(server.raceIdByPlayerId.get(challengerConn.playerId), pending.id);
  assert.equal(server.raceIdByPlayerId.get(challengedConn.playerId), pending.id);

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

test("SRC with a pending challenge guid only acks and waits for the accepted race", async () => {
  const server = createServer();
  const raceConn = { id: 701, playerId: 31, messages: [] };
  server.connections.set(raceConn.id, raceConn);
  server.pendingRaceChallenges.set("race-guid-pending", {
    id: "race-guid-pending",
    challenger: { playerId: 31 },
    challenged: { playerId: 32 },
    ready: { challenger: true, challenged: false },
  });

  await server.handleMessage(raceConn, "SRC\x1esession_key_123\x1erace-guid-pending");

  assert.equal(raceConn.raceId, undefined);
  assert.deepEqual(raceConn.messages, ['"ac", "SRC", "s", 1']);
});

test("SRC bootstrap does not mark racer opened before client RO or telemetry", async () => {
  const server = createServer();
  const raceConn = { id: 801, playerId: 41, messages: [] };
  server.connections.set(raceConn.id, raceConn);
  server.races.set("race-guid-open", {
    id: "race-guid-open",
    trackId: 33,
    players: [
      { connId: 901, playerId: 41, carId: 411, opened: false, bracketTime: 11.5 },
      { connId: 902, playerId: 42, carId: 422, opened: false, bracketTime: 12.1 },
    ],
    betType: 0,
  });

  await server.handleMessage(raceConn, "SRC\x1esession_key_456\x1erace-guid-open");

  const race = server.races.get("race-guid-open");
  assert.equal(race.players[0].raceConnId, raceConn.id);
  assert.equal(race.players[0].opened, false);
  assert.equal(raceConn.messages[0], '"ac", "SRC", "s", 1');
  assert.match(raceConn.messages[1], /b1='11.5' b2='12.1'.*t='33'/);
  assert.equal(raceConn.messages[2], '"ac", "RO", "t", 33');
});

test("buildRraMessage preserves bracket times, scores, bet type, and track", () => {
  const server = createServer();
  const race = {
    trackId: 44,
    betType: 2,
    players: [
      { playerId: 51, carId: 5101, sc: 123, bracketTime: 10.25 },
      { playerId: 52, carId: 5202, sc: 456, bracketTime: 10.75 },
    ],
  };

  assert.equal(
    server.buildRraMessage(race),
    `"ac", "RRA", "d", "<r r1id='51' r2id='52' r1cid='5101' r2cid='5202' b1='10.25' b2='10.75' bt='2' sc1='123' sc2='456' t='44'/>"`,
  );
});
