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
