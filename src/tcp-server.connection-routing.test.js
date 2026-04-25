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

function createTrackedSocket(onDestroy = null) {
  return {
    destroyed: false,
    destroyCalls: 0,
    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;
      this.destroyCalls += 1;
      onDestroy?.();
    },
  };
}

function createTeamCreateSupabaseStub({ playerId, sessionKey, username = "CrewTester" } = {}) {
  const tables = {
    game_sessions: [{
      session_key: sessionKey,
      player_id: playerId,
      last_seen_at: new Date().toISOString(),
    }],
    game_players: [{
      id: playerId,
      username,
      money: 10000,
      points: 50,
      score: 0,
      default_car_game_id: 77,
      team_id: null,
      team_name: "",
      title_id: 0,
      vip: 0,
      track_rank: 0,
      badges_json: null,
      client_role: 5,
    }],
    game_teams: [],
    game_team_members: [],
  };

  function matchesFilters(row, filters) {
    return filters.every((filter) => {
      const value = row?.[filter.field];
      if (filter.type === "eq") {
        return String(value ?? "") === String(filter.value ?? "");
      }
      if (filter.type === "ilike") {
        return String(value ?? "").toLowerCase() === String(filter.value ?? "").toLowerCase();
      }
      if (filter.type === "gte") {
        return String(value ?? "") >= String(filter.value ?? "");
      }
      return true;
    });
  }

  return {
    from(table) {
      let mode = "select";
      let payload = null;
      const filters = [];

      const query = {
        select() {
          return query;
        },
        eq(field, value) {
          filters.push({ type: "eq", field, value });
          return query;
        },
        ilike(field, value) {
          filters.push({ type: "ilike", field, value });
          return query;
        },
        gte(field, value) {
          filters.push({ type: "gte", field, value });
          return query;
        },
        limit() {
          return query;
        },
        update(nextPayload) {
          mode = "update";
          payload = nextPayload;
          return query;
        },
        insert(nextPayload) {
          mode = "insert";
          payload = nextPayload;
          return query;
        },
        delete() {
          mode = "delete";
          return query;
        },
        maybeSingle: async () => {
          const rows = runSelect();
          return { data: rows[0] || null, error: null };
        },
        single: async () => {
          if (mode === "insert") {
            const sourceRow = Array.isArray(payload) ? payload[0] : payload;
            const inserted = {
              id: nextIdFor(table),
              ...(sourceRow || {}),
            };
            tables[table].push(inserted);
            return { data: inserted, error: null };
          }
          if (mode === "update") {
            const rows = runUpdate();
            return { data: rows[0] || null, error: null };
          }
          const rows = runSelect();
          return { data: rows[0] || null, error: null };
        },
        then(resolve, reject) {
          const runner = async () => {
            if (mode === "update") {
              runUpdate();
              return { data: runSelect(), error: null };
            }
            if (mode === "insert") {
              const rows = Array.isArray(payload) ? payload : [payload];
              const insertedRows = rows.map((row) => {
                const inserted = {
                  id: nextIdFor(table),
                  ...(row || {}),
                };
                tables[table].push(inserted);
                return inserted;
              });
              return { data: insertedRows, error: null };
            }
            if (mode === "delete") {
              const rows = tables[table] || [];
              tables[table] = rows.filter((row) => !matchesFilters(row, filters));
              return { data: [], error: null };
            }
            return { data: runSelect(), error: null };
          };

          return Promise.resolve(runner()).then(resolve, reject);
        },
      };

      function nextIdFor(targetTable) {
        return (tables[targetTable] || []).reduce((maxId, row) => Math.max(maxId, Number(row.id || 0)), 0) + 1;
      }

      function runSelect() {
        return (tables[table] || []).filter((row) => matchesFilters(row, filters));
      }

      function runUpdate() {
        const rows = runSelect();
        for (const row of rows) {
          Object.assign(row, payload || {});
        }
        return rows;
      }

      return query;
    },
    tables,
  };
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

test("LR closes sibling race sockets for the leaving player", async () => {
  const server = createServer();
  const lobbyConn = {
    id: 520,
    playerId: 12,
    roomId: 5,
    username: "RoomLeaver",
    carId: 1200,
    messages: [],
    socket: createTrackedSocket(),
  };
  const otherConn = {
    id: 521,
    playerId: 13,
    roomId: 5,
    username: "Opponent",
    carId: 1300,
    messages: [],
    socket: createTrackedSocket(),
  };
  const raceConn = {
    id: 522,
    playerId: 12,
    raceId: "race-room-leave",
    messages: [],
  };
  raceConn.socket = createTrackedSocket(() => server.cleanupConnection(raceConn));

  server.connections.set(lobbyConn.id, lobbyConn);
  server.connections.set(otherConn.id, otherConn);
  server.connections.set(raceConn.id, raceConn);
  server.rooms.set(5, [
    { connId: lobbyConn.id, playerId: 12, username: lobbyConn.username, carId: lobbyConn.carId, teamId: 0, teamRole: "", clientRole: 5 },
    { connId: otherConn.id, playerId: 13, username: otherConn.username, carId: otherConn.carId, teamId: 0, teamRole: "", clientRole: 5 },
  ]);

  await server.handleMessage(lobbyConn, "LR");

  assert.equal(raceConn.socket.destroyCalls, 1);
  assert.equal(server.connections.has(raceConn.id), false);
  assert.equal(lobbyConn.roomId, null);
  assert.deepEqual(server.rooms.get(5), [
    { connId: otherConn.id, playerId: 13, username: otherConn.username, carId: otherConn.carId, teamId: 0, teamRole: "", clientRole: 5 },
  ]);
  assert.deepEqual(lobbyConn.messages, ['"ac", "LR", "s", 1']);
});

test("live tournament join closes sibling race sockets from the previous room", () => {
  const server = createServer();
  const lobbyConn = {
    id: 530,
    playerId: 14,
    roomId: 1,
    username: "TournamentMover",
    carId: 1400,
    messages: [],
    socket: createTrackedSocket(),
  };
  const raceConn = {
    id: 531,
    playerId: 14,
    raceId: "race-tournament-join",
    messages: [],
  };
  raceConn.socket = createTrackedSocket(() => server.cleanupConnection(raceConn));

  server.connections.set(lobbyConn.id, lobbyConn);
  server.connections.set(raceConn.id, raceConn);
  server.rooms.set(1, [
    { connId: lobbyConn.id, playerId: 14, username: lobbyConn.username, carId: lobbyConn.carId, teamId: 0, teamRole: "", clientRole: 5 },
  ]);

  server.handleLiveTournamentJoin(lobbyConn);

  assert.equal(raceConn.socket.destroyCalls, 1);
  assert.equal(server.connections.has(raceConn.id), false);
  assert.equal(lobbyConn.roomId, 2);
  assert.match(lobbyConn.messages[0], /^"ac", "HTJOIN", "s", 1/);
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

test("startPendingRace keeps team rivals lobby bootstrap on RN/RRA only", () => {
  const server = createServer();
  const challengerConn = { id: 603, playerId: 23, roomId: 1, messages: [] };
  const challengedConn = { id: 604, playerId: 24, roomId: 1, messages: [] };

  server.connections.set(challengerConn.id, challengerConn);
  server.connections.set(challengedConn.id, challengedConn);

  const pending = {
    id: "race-guid-team",
    roomId: 1,
    trackId: 32,
    createdAt: Date.now(),
    challenger: {
      connId: challengerConn.id,
      playerId: challengerConn.playerId,
      carId: 333,
      lane: 0,
    },
    challenged: {
      connId: challengedConn.id,
      playerId: challengedConn.playerId,
      carId: 444,
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
    assert.equal(conn.messages.length, 2);
    assert.match(conn.messages[0], /^"ac", "RN", "d", "/);
    assert.match(conn.messages[1], /^"ac", "RRA", "d", "/);
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

test("handleLegacyTeamCreate rehydrates the TCP connection after a successful create", async () => {
  const playerId = 61;
  const sessionKey = "legacy-teamcreate-session";
  const supabase = createTeamCreateSupabaseStub({ playerId, sessionKey });
  const server = new TcpServer({
    logger: createLogger(),
    notify() {},
    proxy: null,
    supabase,
  });
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;
  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };

  const conn = {
    id: 901,
    playerId,
    sessionKey,
    username: "CrewTester",
    messages: [],
  };

  await server.handleLegacyTeamCreate(conn, ["TEAMCREATE", "Fresh Crew"]);

  assert.match(conn.messages[0], /^"ac", "TEAMCREATE", "s", 1, "tid", \d+$/);
  assert.equal(conn.teamId, 1);
  assert.equal(conn.teamRole, "owner");
  assert.equal(supabase.tables.game_players[0].team_id, 1);
  assert.equal(supabase.tables.game_players[0].team_name, "Fresh Crew");
  assert.deepEqual(
    supabase.tables.game_team_members.map(({ team_id, player_id, role }) => ({ team_id, player_id, role })),
    [{ team_id: 1, player_id: 61, role: "owner" }],
  );
});

test("TC creates the team and responds on the TC channel", async () => {
  const playerId = 62;
  const sessionKey = "tc-teamcreate-session";
  const supabase = createTeamCreateSupabaseStub({ playerId, sessionKey, username: "TcTester" });
  const server = new TcpServer({
    logger: createLogger(),
    notify() {},
    proxy: null,
    supabase,
  });
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;
  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };

  const conn = {
    id: 902,
    playerId,
    sessionKey,
    username: "TcTester",
    messages: [],
  };
  server.connections.set(conn.id, conn);

  await server.handleMessage(conn, "TC\x1ePure Insanity");

  assert.match(conn.messages[0], /^"ac", "TC", "s", 1, "tid", \d+$/);
  assert.equal(conn.teamId, 1);
  assert.equal(conn.teamRole, "owner");
  assert.equal(supabase.tables.game_players[0].team_id, 1);
  assert.equal(supabase.tables.game_players[0].team_name, "Pure Insanity");
});
