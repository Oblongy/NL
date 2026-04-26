import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";
import { RaceRoomRegistry } from "./race-room-registry.js";
import { TcpServer } from "./tcp-server.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createServer() {
  const raceRoomRegistry = new RaceRoomRegistry();
  const server = new TcpServer({
    logger: createLogger(),
    notify() {},
    proxy: null,
    supabase: null,
    raceRoomRegistry,
  });
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;

  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };

  return { server, raceRoomRegistry };
}

function seedRegistryRoom(raceRoomRegistry, roomId, players = []) {
  raceRoomRegistry.upsert(roomId, {
    name: `Room ${roomId}`,
    type: "normal",
    status: "waiting",
    maxPlayers: 8,
    players: players.map((player) => ({
      id: Number(player.playerId || player.id || 0),
      publicId: Number(player.publicId || player.playerId || player.id || 0),
      name: player.username || player.name || `Player ${player.playerId || player.id}`,
      ready: Boolean(player.ready),
    })),
  });
}

function createSessionSupabaseStub({ playerId = 14, username = "RoomLeaver" } = {}) {
  const nowIso = new Date().toISOString();
  const sessionKey = `room-leave-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    sessionRow: {
      session_key: sessionKey,
      player_id: playerId,
      created_at: nowIso,
      updated_at: nowIso,
      last_seen_at: nowIso,
    },
    playerRow: {
      id: playerId,
      username,
      money: 0,
      points: 0,
      score: 0,
      image_id: 0,
      active: true,
      vip: false,
      facebook_connected: false,
      sponsor_rating: 0,
      driver_text: "",
      team_name: "",
      gender: "m",
      respect_level: 0,
      title_id: 0,
      track_rank: 0,
      location_id: 100,
      background_id: 0,
      default_car_game_id: 0,
    },
  };

  const tables = {
    game_sessions: [state.sessionRow],
    game_players: [state.playerRow],
  };

  const supabase = {
    from(tableName) {
      const table = tables[tableName] || [];
      let filters = [];
      let mode = "select";
      let payload = null;

      const query = {
        select() {
          return query;
        },
        update(nextPayload) {
          mode = "update";
          payload = nextPayload;
          return query;
        },
        eq(field, value) {
          filters.push({ type: "eq", field, value });
          return query;
        },
        gte(field, value) {
          filters.push({ type: "gte", field, value });
          return query;
        },
        maybeSingle: async () => runMaybeSingle(),
        single: async () => runSingle(),
        then(resolve, reject) {
          return Promise.resolve(mode === "update" ? runUpdate() : runMany()).then(resolve, reject);
        },
      };

      function matchesFilters(row) {
        return filters.every((filter) => {
          const rowValue = row?.[filter.field];
          if (filter.type === "eq") {
            return String(rowValue ?? "") === String(filter.value ?? "");
          }
          if (filter.type === "gte") {
            return String(rowValue ?? "") >= String(filter.value ?? "");
          }
          return true;
        });
      }

      function matchedRows() {
        return table.filter((row) => matchesFilters(row));
      }

      function runMaybeSingle() {
        return { data: matchedRows()[0] || null, error: null };
      }

      function runSingle() {
        if (mode === "update") {
          const rows = applyUpdate();
          return { data: rows[0] || null, error: null };
        }
        return { data: matchedRows()[0] || null, error: null };
      }

      function applyUpdate() {
        const rows = matchedRows();
        for (const row of rows) {
          Object.assign(row, payload || {});
        }
        return rows;
      }

      function runUpdate() {
        return { data: applyUpdate(), error: null };
      }

      function runMany() {
        return { data: matchedRows(), error: null };
      }

      return query;
    },
  };

  return { supabase, sessionKey };
}

test("leaveRoom removes ghost entries for the same player across every room snapshot", () => {
  const { server, raceRoomRegistry } = createServer();
  const conn = { id: 100, playerId: 10, roomId: 1, messages: [], username: "Alpha" };
  const roomMate = { id: 101, playerId: 11, roomId: 1, messages: [], username: "Bravo" };
  const ghostRoomMate = { id: 102, playerId: 12, roomId: 2, messages: [], username: "Charlie" };

  server.connections.set(conn.id, conn);
  server.connections.set(roomMate.id, roomMate);
  server.connections.set(ghostRoomMate.id, ghostRoomMate);
  server.rooms.set(1, [
    { connId: conn.id, playerId: conn.playerId, username: conn.username, teamId: 0, clientRole: 5 },
    { connId: roomMate.id, playerId: roomMate.playerId, username: roomMate.username, teamId: 0, clientRole: 5 },
  ]);
  server.rooms.set(2, [
    { connId: 9999, playerId: conn.playerId, username: conn.username, teamId: 0, clientRole: 5 },
    { connId: ghostRoomMate.id, playerId: ghostRoomMate.playerId, username: ghostRoomMate.username, teamId: 0, clientRole: 5 },
  ]);

  seedRegistryRoom(raceRoomRegistry, 1, server.rooms.get(1));
  seedRegistryRoom(raceRoomRegistry, 2, server.rooms.get(2));

  server.leaveRoom(conn);

  assert.equal(conn.roomId, null);
  assert.deepEqual((server.rooms.get(1) || []).map((player) => player.playerId), [11]);
  assert.deepEqual((server.rooms.get(2) || []).map((player) => player.playerId), [12]);
  assert.equal(raceRoomRegistry.get(1).players.some((player) => player.id === 10), false);
  assert.equal(raceRoomRegistry.get(2).players.some((player) => player.id === 10), false);
  assert.match(roomMate.messages.at(-1) || "", /^"ac", "LRCU", "d", "/);
  assert.doesNotMatch(roomMate.messages.at(-1) || "", /i='10'/);
  assert.match(ghostRoomMate.messages.at(-1) || "", /^"ac", "LRCU", "d", "/);
  assert.doesNotMatch(ghostRoomMate.messages.at(-1) || "", /i='10'/);
});

test("handleLiveTournamentJoin clears stale room membership before adding the player to the tournament room", () => {
  const { server, raceRoomRegistry } = createServer();
  const conn = { id: 200, playerId: 20, roomId: null, messages: [], username: "TournamentPlayer" };
  const oldRoomMate = { id: 201, playerId: 21, roomId: 5, messages: [], username: "OldMate" };

  server.getLiveTournamentEvent = () => ({ id: 77, roomId: 2 });
  server.connections.set(conn.id, conn);
  server.connections.set(oldRoomMate.id, oldRoomMate);
  server.rooms.set(5, [
    { connId: 9998, playerId: conn.playerId, username: conn.username, teamId: 0, clientRole: 5 },
    { connId: oldRoomMate.id, playerId: oldRoomMate.playerId, username: oldRoomMate.username, teamId: 0, clientRole: 5 },
  ]);
  server.rooms.set(2, []);

  seedRegistryRoom(raceRoomRegistry, 5, server.rooms.get(5));
  seedRegistryRoom(raceRoomRegistry, 2, []);

  server.handleLiveTournamentJoin(conn, { spectate: false, parts: ["HTJOIN", "", "444"] });

  assert.equal(conn.roomId, 2);
  assert.deepEqual((server.rooms.get(5) || []).map((player) => player.playerId), [21]);
  assert.deepEqual((server.rooms.get(2) || []).map((player) => player.playerId), [20]);
  assert.equal(raceRoomRegistry.get(5).players.some((player) => player.id === 20), false);
  assert.equal(raceRoomRegistry.get(2).players.some((player) => player.id === 20), true);
  assert.match(oldRoomMate.messages.at(-1) || "", /^"ac", "LRCU", "d", "/);
  assert.doesNotMatch(oldRoomMate.messages.at(-1) || "", /i='20'/);
});

test("leaveroom action updates live tcp rooms and clears the caller connection state", async () => {
  const { server, raceRoomRegistry } = createServer();
  const { supabase, sessionKey } = createSessionSupabaseStub({ playerId: 30, username: "ActionLeaver" });
  const callerConn = { id: 300, playerId: 30, roomId: 1, messages: [], username: "ActionLeaver" };
  const roomMate = { id: 301, playerId: 31, roomId: 1, messages: [], username: "Watcher" };

  server.connections.set(callerConn.id, callerConn);
  server.connections.set(roomMate.id, roomMate);
  server.rooms.set(1, [
    { connId: callerConn.id, playerId: callerConn.playerId, username: callerConn.username, teamId: 0, clientRole: 5 },
    { connId: roomMate.id, playerId: roomMate.playerId, username: roomMate.username, teamId: 0, clientRole: 5 },
  ]);
  seedRegistryRoom(raceRoomRegistry, 1, server.rooms.get(1));

  const result = await handleGameAction({
    action: "leaveroom",
    params: new Map([["sk", sessionKey]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {
      raceRoomRegistry,
      tcpServer: server,
    },
  });

  assert.equal(result.source, "generated:leaveroom");
  assert.match(result.body, /rooms='1'/);
  assert.equal(callerConn.roomId, null);
  assert.deepEqual((server.rooms.get(1) || []).map((player) => player.playerId), [31]);
  assert.equal(raceRoomRegistry.get(1).players.some((player) => player.id === 30), false);
  assert.match(roomMate.messages.at(-1) || "", /^"ac", "LRCU", "d", "/);
  assert.doesNotMatch(roomMate.messages.at(-1) || "", /i='30'/);
});

test("leaveroom action closes sibling room connections for the same player after removing room membership", async () => {
  const { server, raceRoomRegistry } = createServer();
  const { supabase, sessionKey } = createSessionSupabaseStub({ playerId: 40, username: "ActionLeaver" });
  const callerSocket = {
    destroyed: false,
    destroyCalls: 0,
    destroy() {
      this.destroyed = true;
      this.destroyCalls += 1;
    },
  };
  const siblingSocket = {
    destroyed: false,
    destroyCalls: 0,
    destroy() {
      this.destroyed = true;
      this.destroyCalls += 1;
    },
  };
  const callerConn = { id: 400, playerId: 40, roomId: 1, messages: [], username: "ActionLeaver", socket: callerSocket };
  const siblingConn = { id: 401, playerId: 40, roomId: 1, messages: [], username: "ActionLeaver", socket: siblingSocket };
  const roomMate = { id: 402, playerId: 41, roomId: 1, messages: [], username: "Watcher" };

  server.connections.set(callerConn.id, callerConn);
  server.connections.set(siblingConn.id, siblingConn);
  server.connections.set(roomMate.id, roomMate);
  server.rooms.set(1, [
    { connId: callerConn.id, playerId: callerConn.playerId, username: callerConn.username, teamId: 0, clientRole: 5 },
    { connId: siblingConn.id, playerId: siblingConn.playerId, username: siblingConn.username, teamId: 0, clientRole: 5 },
    { connId: roomMate.id, playerId: roomMate.playerId, username: roomMate.username, teamId: 0, clientRole: 5 },
  ]);
  seedRegistryRoom(raceRoomRegistry, 1, server.rooms.get(1));

  const result = await handleGameAction({
    action: "leaveroom",
    params: new Map([["sk", sessionKey]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {
      raceRoomRegistry,
      tcpServer: server,
    },
  });

  assert.equal(result.source, "generated:leaveroom");
  assert.equal(callerConn.roomId, null);
  assert.equal(siblingConn.roomId, null);
  assert.equal(callerSocket.destroyCalls, 0);
  assert.equal(siblingSocket.destroyCalls, 1);
  assert.equal(siblingSocket.destroyed, true);
  assert.deepEqual((server.rooms.get(1) || []).map((player) => player.playerId), [41]);
});

test("leaveroom action treats literal undefined session keys as missing sessions", async () => {
  const { server, raceRoomRegistry } = createServer();
  const { supabase } = createSessionSupabaseStub({ playerId: 50, username: "ActionLeaver" });

  const result = await handleGameAction({
    action: "leaveroom",
    params: new Map([["sk", "undefined"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {
      raceRoomRegistry,
      tcpServer: server,
    },
  });

  assert.equal(result.source, "leaveroom:missing-session");
  assert.match(result.body, /<leave s='0'\/>/);
});
