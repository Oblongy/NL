import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createBuyDynoSupabaseStub({
  playerId = 77,
  sessionKey = "buydyno-session-test",
  money = 5000,
  hasDyno = 0,
  gameCarId = 9100,
  partsXml = "",
} = {}) {
  const sessionRow = {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: new Date().toISOString(),
  };
  const playerRow = {
    id: playerId,
    username: "DynoTester",
    money,
    points: 0,
    score: 0,
    default_car_game_id: gameCarId,
    has_dyno: hasDyno,
  };
  const carRow = {
    game_car_id: gameCarId,
    player_id: playerId,
    catalog_car_id: 1,
    parts_xml: partsXml,
    wheel_xml: "",
    color_code: "FFFFFF",
    paint_id: 0,
    owned_engine_id: 0,
    installed_engine_id: 0,
    image_index: 0,
    locked: 0,
    aero: 0,
  };
  const ownedEngineRows = [];
  let nextOwnedEngineId = 1;

  function matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.type === "eq") {
        return String(row?.[filter.field] ?? "") === String(filter.value ?? "");
      }
      if (filter.type === "gte") {
        return String(row?.[filter.field] ?? "") >= String(filter.value ?? "");
      }
      return true;
    });
  }

  return {
    from(table) {
      const filters = [];
      let mode = "select";
      let payload = null;
      const rows =
        table === "game_sessions" ? [sessionRow]
          : table === "game_players" ? [playerRow]
            : table === "game_cars" ? [carRow]
              : table === "game_owned_engines" ? ownedEngineRows
                : [];
      const query = {
        select() {
          return query;
        },
        insert(nextPayload) {
          mode = "insert";
          payload = nextPayload;
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
        order() {
          return query;
        },
        maybeSingle: async () => ({
          data: rows.find((row) => matchesFilters(row, filters)) || null,
          error: null,
        }),
        single: async () => {
          if (mode === "insert") {
            const inserted = Array.isArray(payload) ? payload : [payload];
            for (const entry of inserted) {
              rows.push({
                id: nextOwnedEngineId++,
                ...entry,
              });
            }
            mode = "select";
            payload = null;
          }
          if (mode === "update") {
            for (const row of rows) {
              if (matchesFilters(row, filters)) {
                Object.assign(row, payload || {});
              }
            }
            mode = "select";
            payload = null;
          }
          return {
            data: rows.find((row) => matchesFilters(row, filters)) || null,
            error: null,
          };
        },
        then(resolve, reject) {
          if (mode === "insert") {
            const inserted = Array.isArray(payload) ? payload : [payload];
            for (const entry of inserted) {
              rows.push({
                id: nextOwnedEngineId++,
                ...entry,
              });
            }
            mode = "select";
            payload = null;
          }
          if (mode === "update") {
            for (const row of rows) {
              if (matchesFilters(row, filters)) {
                Object.assign(row, payload || {});
              }
            }
            mode = "select";
            payload = null;
          }
          return Promise.resolve({
            data: rows.filter((row) => matchesFilters(row, filters)),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("buydyno returns the seven garageDynoBuyCB callback args in order", async () => {
  const sessionKey = "buydyno-regression";
  const gameCarId = 9101;
  const result = await handleGameAction({
    action: "buydyno",
    params: new Map([
      ["sk", sessionKey],
      ["acid", String(gameCarId)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: createBuyDynoSupabaseStub({ sessionKey, gameCarId }),
    services: {},
  });

  assert.equal(result.source, "supabase:buydyno");
  assert.match(result.body, /^1, "4500", "5", "10", "0", "7200", "7600"$/);
});

test("buydyno already-owned path also returns the seven garageDynoBuyCB callback args in order", async () => {
  const sessionKey = "buydyno-already-owned";
  const gameCarId = 9102;
  const result = await handleGameAction({
    action: "buydyno",
    params: new Map([
      ["sk", sessionKey],
      ["acid", String(gameCarId)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: createBuyDynoSupabaseStub({ sessionKey, gameCarId, hasDyno: 1, money: 4321 }),
    services: {},
  });

  assert.equal(result.source, "supabase:buydyno:already-owned");
  assert.match(result.body, /^1, "4321", "5", "10", "0", "7200", "7600"$/);
});
