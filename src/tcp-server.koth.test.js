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

test("createRaceSession sends KOTH racers a parseable RCLG XML payload with a race guid", async () => {
  const server = createServer();
  const connA = { id: 701, playerId: 41, roomId: 3, messages: [] };
  const connB = { id: 702, playerId: 42, roomId: 3, messages: [] };

  server.connections.set(connA.id, connA);
  server.connections.set(connB.id, connB);

  await server.createRaceSession(
    {
      connId: connA.id,
      requesterPlayerId: connA.playerId,
      requesterCarId: 111,
      roomId: 3,
      lane: 0,
      bet: 0,
    },
    {
      connId: connB.id,
      requesterPlayerId: connB.playerId,
      requesterCarId: 222,
      roomId: 3,
      lane: 1,
      bet: 0,
    },
  );

  for (const conn of [connA, connB]) {
    assert.equal(conn.messages.length, 1);
    assert.match(conn.messages[0], /^"ac", "RCLG", "d", "/);
    assert.match(conn.messages[0], /r='[0-9a-f-]+'/i);
    assert.match(conn.messages[0], /i='41'/);
    assert.match(conn.messages[0], /ci='42'/);
  }
});

test("KOTH-created race sessions still reach the normal ready broadcast once both racers confirm", async () => {
  const server = createServer();
  const connA = { id: 801, playerId: 51, roomId: 4, messages: [] };
  const connB = { id: 802, playerId: 52, roomId: 4, messages: [] };

  server.connections.set(connA.id, connA);
  server.connections.set(connB.id, connB);

  await server.createRaceSession(
    {
      connId: connA.id,
      requesterPlayerId: connA.playerId,
      requesterCarId: 311,
      roomId: 4,
      lane: 0,
      bet: 0,
    },
    {
      connId: connB.id,
      requesterPlayerId: connB.playerId,
      requesterCarId: 322,
      roomId: 4,
      lane: 1,
      bet: 0,
    },
  );

  connA.messages = [];
  connB.messages = [];

  server.handleRaceReady(connA, ["RRS", connA.raceId]);
  server.handleRaceReady(connB, ["RRS", connB.raceId]);

  for (const conn of [connA, connB]) {
    assert.equal(conn.messages.length, 3);
    assert.match(conn.messages[0], /^"ac", "RRS", "s", 1, "i", "/);
    assert.match(conn.messages[1], /^"ac", "RN", "d", "/);
    assert.match(conn.messages[2], /^"ac", "RRA", "d", "/);
  }
});

test("broadcastKothQueueUpdate emits both KU and LR snapshots for queued room members", () => {
  const server = createServer();
  const connA = { id: 901, playerId: 61, roomId: 3, messages: [], kingOfHillSelection: { carId: 111, lane: 0 } };
  const connB = { id: 902, playerId: 62, roomId: 3, messages: [], kingOfHillSelection: { carId: 222, lane: 1 } };

  server.connections.set(connA.id, connA);
  server.connections.set(connB.id, connB);
  server.rooms.set(3, [
    { connId: connA.id, playerId: connA.playerId, username: "Alpha", teamId: 0, clientRole: 5 },
    { connId: connB.id, playerId: connB.playerId, username: "Bravo", teamId: 0, clientRole: 5 },
  ]);

  server.broadcastKothQueueUpdate(3);

  for (const conn of [connA, connB]) {
    assert.equal(conn.messages.length, 2);
    assert.match(conn.messages[0], /^"ac", "KU", "s", "<q>/);
    assert.match(conn.messages[1], /^"ac", "LR", "s", "<q>/);
    assert.match(conn.messages[0], /i='61'/);
    assert.match(conn.messages[0], /i='62'/);
    assert.match(conn.messages[1], /i='61'/);
    assert.match(conn.messages[1], /i='62'/);
  }
});

test("JK waits for async KOTH race-session creation before handleMessage resolves", async () => {
  const server = createServer();
  const connA = { id: 903, playerId: 71, roomId: 4, username: "Alpha", messages: [] };
  const connB = { id: 904, playerId: 72, roomId: 4, username: "Bravo", messages: [], kingOfHillSelection: { carId: 444, lane: 1 } };

  server.connections.set(connA.id, connA);
  server.connections.set(connB.id, connB);
  server.rooms.set(4, [
    { connId: connA.id, playerId: connA.playerId, username: connA.username, teamId: 0, clientRole: 5 },
    { connId: connB.id, playerId: connB.playerId, username: connB.username, teamId: 0, clientRole: 5 },
  ]);

  let createRaceSessionResolved = false;
  server.createRaceSession = async () => {
    await Promise.resolve();
    createRaceSessionResolved = true;
  };

  await server.handleMessage(connA, "JK\x1e333\x1e0");

  assert.equal(createRaceSessionResolved, true);
});
