import test from "node:test";
import assert from "node:assert/strict";
import { TcpServer } from "./src/tcp-server.js";
import { decodePayload, encryptPayload } from "./src/nitto-cipher.js";

function createHarness() {
  const writes = [];
  const logger = {
    info() {},
    warn() {},
    error() {},
  };

  const server = new TcpServer({
    logger,
    notify: null,
    proxy: null,
    supabase: null,
    raceRoomRegistry: null,
  });
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;

  const conn = {
    id: 1,
    socket: {
      write(data) {
        writes.push(Buffer.isBuffer(data) ? data.toString("latin1") : String(data));
      },
    },
    buffer: "",
    playerId: null,
    sessionKey: null,
    bootstrapSent: false,
    lobbyRoomsSent: false,
  };

  return { server, conn, writes };
}

function encodeMessage(decoded, seed) {
  return encryptPayload(decoded, seed);
}

function decodeWrites(writes) {
  return writes.map((wireMessage) => {
    assert.ok(wireMessage.endsWith("\x04"), "wire message should end with delimiter");
    return decodePayload(wireMessage.slice(0, -1)).decoded;
  });
}

test("single-character client packets do not trigger lobby bootstrap", async () => {
  const { server, conn, writes } = createHarness();

  await server.handleMessage(conn, encodeMessage("H", 71));
  await server.handleMessage(conn, encodeMessage("X\x1e*\x1e0\x1e3\t7", 14));
  await server.handleMessage(conn, encodeMessage("T\x1e'\x1e3\x1e586", 56));

  assert.deepEqual(writes, []);
  assert.equal(conn.bootstrapSent, false);
  assert.equal(conn.lobbyRoomsSent, false);
});

test("LRCR2 still returns the canonical room list payload", async () => {
  const { server, conn, writes } = createHarness();

  await server.handleMessage(conn, encodeMessage("LRCR2\x1e9\x1ex", 90));

  const decoded = decodeWrites(writes);
  assert.equal(decoded.length, 1);
  assert.match(decoded[0], /^"ac", "LRCR2", "d", "/);
  assert.equal(conn.bootstrapSent, false);
  assert.equal(conn.lobbyRoomsSent, true);
});
