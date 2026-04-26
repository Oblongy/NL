import assert from "node:assert/strict";
import test from "node:test";

import { getDefaultPartsXmlForCar } from "./car-defaults.js";
import { handleGameAction } from "./game-actions.js";
import { getPublicIdForPlayer } from "./public-id.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function isNumericLike(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function matchesFilters(row, filters = []) {
  return filters.every((filter) => {
    const rowValue = row?.[filter.field];
    if (filter.type === "eq") {
      if (isNumericLike(rowValue) && isNumericLike(filter.value)) {
        return Number(rowValue) === Number(filter.value);
      }
      return String(rowValue ?? "") === String(filter.value ?? "");
    }
    if (filter.type === "in") {
      return filter.values.some((value) => {
        if (isNumericLike(rowValue) && isNumericLike(value)) {
          return Number(rowValue) === Number(value);
        }
        return String(rowValue ?? "") === String(value ?? "");
      });
    }
    if (filter.type === "ilike") {
      const pattern = String(filter.value ?? "").toLowerCase().replaceAll("%", "");
      return String(rowValue ?? "").toLowerCase().includes(pattern);
    }
    if (filter.type === "gte") {
      return Number(rowValue ?? 0) >= Number(filter.value ?? 0);
    }
    return true;
  });
}

function createGameActionsSupabaseStub({
  players = [],
  sessions = [],
  cars = [],
  ownedEngines = [],
  teams = [],
  teamMembers = [],
  failContributionUpdate = false,
} = {}) {
  const state = {
    players: players.map((row) => ({ ...row })),
    sessions: sessions.map((row) => ({ ...row })),
    cars: cars.map((row) => ({ ...row })),
    ownedEngines: ownedEngines.map((row) => ({ ...row })),
    teams: teams.map((row) => ({ ...row })),
    teamMembers: teamMembers.map((row) => ({ ...row })),
    rpcCalls: [],
  };

  const tables = {
    game_players: state.players,
    game_sessions: state.sessions,
    game_cars: state.cars,
    game_owned_engines: state.ownedEngines,
    game_teams: state.teams,
    game_team_members: state.teamMembers,
  };

  const supabase = {
    from(tableName) {
      const table = tables[tableName] || [];
      const filters = [];
      let mode = "select";
      let payload = null;
      let selectedFields = null;

      const query = {
        select(fields) {
          selectedFields = fields || null;
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
        eq(field, value) {
          filters.push({ type: "eq", field, value });
          return query;
        },
        in(field, values) {
          filters.push({ type: "in", field, values: [...values] });
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
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle: async () => {
          const rows = matchedRows();
          return { data: projectRow(rows[0] || null), error: null };
        },
        single: async () => {
          const result = runMode();
          if (result.error) {
            return { data: null, error: result.error };
          }
          return {
            data: projectRow(Array.isArray(result.data) ? (result.data[0] || null) : result.data),
            error: null,
          };
        },
        then(resolve, reject) {
          return Promise.resolve(runMode()).then((result) => {
            if (result.error) {
              return { data: null, error: result.error };
            }
            return {
              data: Array.isArray(result.data)
                ? result.data.map((row) => projectRow(row))
                : projectRow(result.data),
              error: null,
            };
          }).then(resolve, reject);
        },
      };

      function matchedRows() {
        return table.filter((row) => matchesFilters(row, filters));
      }

      function projectRow(row) {
        if (!row || !selectedFields || selectedFields === "*") {
          return row;
        }
        const fields = String(selectedFields)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        return Object.fromEntries(fields.map((field) => [field, row[field]]));
      }

      function applyUpdate() {
        if (tableName === "game_team_members" && failContributionUpdate) {
          return { data: null, error: new Error("forced contribution update failure") };
        }
        const rows = matchedRows();
        for (const row of rows) {
          Object.assign(row, payload || {});
        }
        return { data: rows, error: null };
      }

      function applyInsert() {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = rows.map((row) => {
          const nextRow = { ...row };
          table.push(nextRow);
          return nextRow;
        });
        return { data: inserted, error: null };
      }

      function applyDelete() {
        const rows = matchedRows();
        for (const row of rows) {
          const index = table.indexOf(row);
          if (index >= 0) {
            table.splice(index, 1);
          }
        }
        return { data: rows, error: null };
      }

      function runMode() {
        if (mode === "update") {
          return applyUpdate();
        }
        if (mode === "insert") {
          return applyInsert();
        }
        if (mode === "delete") {
          return applyDelete();
        }
        return { data: matchedRows(), error: null };
      }

      return query;
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      return { data: null, error: new Error(`RPC ${name} is not available in tests`) };
    },
  };

  return { supabase, state };
}

function createSession(playerId, sessionKey) {
  const nowIso = new Date().toISOString();
  return {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function createPlayer({
  id,
  username,
  money = 50000,
  points = 100,
  teamId = 0,
  teamName = "",
  defaultCarGameId = 0,
} = {}) {
  return {
    id,
    username,
    password_hash: "secret",
    money,
    points,
    score: 0,
    image_id: 0,
    active: true,
    vip: false,
    facebook_connected: false,
    sponsor_rating: 0,
    driver_text: "",
    team_id: teamId,
    team_name: teamName,
    gender: "m",
    respect_level: 0,
    title_id: 0,
    track_rank: 0,
    location_id: 100,
    background_id: 0,
    default_car_game_id: defaultCarGameId,
  };
}

function createCar({
  gameCarId,
  playerId,
  catalogCarId = 1,
  selected = true,
  partsXml = "",
} = {}) {
  return {
    game_car_id: gameCarId,
    account_car_id: gameCarId,
    player_id: playerId,
    catalog_car_id: catalogCarId,
    selected,
    plate_name: "",
    color_code: "FFFFFF",
    image_index: 0,
    locked: 0,
    aero: 0,
    wheel_xml: "",
    parts_xml: partsXml,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function createOwnedEngine({
  id,
  playerId,
  gameCarId,
  partsXml = "",
  engineTypeId = 1,
} = {}) {
  return {
    id,
    player_id: playerId,
    installed_on_car_id: gameCarId,
    catalog_engine_part_id: 0,
    engine_type_id: engineTypeId,
    parts_xml: partsXml,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

test("getonecarengine and practice preserve compression level in driveable engine xml", async () => {
  const playerId = 41;
  const sessionKey = `compression-${Date.now()}`;
  const compressionPartsXml = "<p ai='9001' i='12000' pi='190' di='12'/>";
  const { supabase } = createGameActionsSupabaseStub({
    players: [createPlayer({ id: playerId, username: "Compression", defaultCarGameId: 7001 })],
    sessions: [createSession(playerId, sessionKey)],
    cars: [createCar({
      gameCarId: 7001,
      playerId,
      catalogCarId: 1,
      selected: true,
      partsXml: compressionPartsXml,
    })],
    ownedEngines: [createOwnedEngine({ id: 8101, playerId, gameCarId: 7001 })],
  });

  const getOneCarEngineResult = await handleGameAction({
    action: "getonecarengine",
    params: new Map([
      ["aid", String(playerId)],
      ["sk", sessionKey],
      ["acid", "7001"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(getOneCarEngineResult?.source, "generated:getonecarengine");
  assert.match(getOneCarEngineResult.body, /<n2[^>]* c='12'/);

  const practiceResult = await handleGameAction({
    action: "practice",
    params: new Map([
      ["aid", String(playerId)],
      ["sk", sessionKey],
      ["acid", "7001"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(practiceResult?.source, "generated:practice");
  assert.match(practiceResult.body, /<n2[^>]* c='12'/);
});

test("getallotherusercars does not create a starter car for players with an empty garage", async () => {
  const callerId = 51;
  const targetId = 52;
  const sessionKey = `other-cars-${Date.now()}`;
  const targetPlayer = createPlayer({ id: targetId, username: "GarageViewerTarget" });
  const { supabase, state } = createGameActionsSupabaseStub({
    players: [
      createPlayer({ id: callerId, username: "GarageViewerCaller" }),
      targetPlayer,
    ],
    sessions: [createSession(callerId, sessionKey)],
  });

  const targetPublicId = getPublicIdForPlayer(targetPlayer);
  const result = await handleGameAction({
    action: "getallotherusercars",
    params: new Map([
      ["aid", String(callerId)],
      ["sk", sessionKey],
      ["tid", String(targetPublicId)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:getallotherusercars");
  assert.equal(
    state.cars.filter((car) => Number(car.player_id) === targetId).length,
    0,
    "viewing another player's empty garage must not create a starter car",
  );
});

test("sellcarpart only blocks the true default stock part, not any aftermarket part in the same slot", async () => {
  const playerId = 61;
  const sessionKey = `sell-slot-${Date.now()}`;
  const aftermarketTurboXml = "<p ai='turbo-1' i='206' pi='87' n='Garrett Small Turbo Kit'/>";
  const { supabase, state } = createGameActionsSupabaseStub({
    players: [createPlayer({ id: playerId, username: "Seller", money: 1000, defaultCarGameId: 7201 })],
    sessions: [createSession(playerId, sessionKey)],
    cars: [createCar({
      gameCarId: 7201,
      playerId,
      catalogCarId: 1,
      selected: true,
      partsXml: aftermarketTurboXml,
    })],
    ownedEngines: [createOwnedEngine({ id: 8201, playerId, gameCarId: 7201 })],
  });

  assert.match(getDefaultPartsXmlForCar(1), /pi='87'/, "fixture expects catalog car 1 to define stock slot 87");

  const result = await handleGameAction({
    action: "sellcarpart",
    params: new Map([
      ["aid", String(playerId)],
      ["sk", sessionKey],
      ["acpid", "turbo-1"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:sellcarpart");
  assert.equal(state.cars[0].parts_xml.includes("turbo-1"), false);
  assert.ok(Number(state.players[0].money) > 1000, "selling the aftermarket part should credit money");
});

test("teamdeposit rolls back player and team balances when contribution persistence fails", async () => {
  const playerId = 71;
  const sessionKey = `teamdeposit-${Date.now()}`;
  const teamId = 91;
  const { supabase, state } = createGameActionsSupabaseStub({
    players: [createPlayer({
      id: playerId,
      username: "Depositor",
      money: 1000,
      teamId,
      teamName: "Rollbackers",
    })],
    sessions: [createSession(playerId, sessionKey)],
    teams: [{
      id: teamId,
      name: "Rollbackers",
      score: 0,
      team_fund: 200,
      background_color: "7D7D7D",
      recruitment_type: "open",
      vip: 0,
      created_at: new Date().toISOString(),
      wins: 0,
      losses: 0,
    }],
    teamMembers: [{
      id: 1,
      team_id: teamId,
      player_id: playerId,
      role: 1,
      contribution_score: 50,
      joined_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
    failContributionUpdate: true,
  });

  const services = { teamState: new Map() };
  await assert.rejects(
    handleGameAction({
      action: "teamdeposit",
      params: new Map([
        ["aid", String(playerId)],
        ["sk", sessionKey],
        ["amount", "100"],
      ]),
      rawQuery: "",
      decodedQuery: "",
      logger: createLogger(),
      supabase,
      services,
    }),
    /forced contribution update failure/,
  );

  assert.equal(state.players[0].money, 1000);
  assert.equal(state.teams[0].team_fund, 200);
  assert.equal(state.teamMembers[0].contribution_score, 50);
});
