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
              : [];
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
        order() {
          return query;
        },
        maybeSingle: async () => ({
          data: rows.find((row) => matchesFilters(row, filters)) || null,
          error: null,
        }),
        then(resolve, reject) {
          if (mode === "update") {
            for (const row of rows) {
              if (matchesFilters(row, filters)) {
                Object.assign(row, payload || {});
              }
            }
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

test("buydyno returns quoted scalar fields for the Director callback contract", async () => {
  const sessionKey = "buydyno-regression";
  const gameCarId = 9101;
  const result = await handleGameAction({
    action: "buydyno",
    params: new Map([
      ["key", sessionKey],
      ["acid", String(gameCarId)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: createBuyDynoSupabaseStub({ sessionKey, gameCarId }),
    services: {},
  });

  assert.equal(result.source, "supabase:buydyno");
  assert.match(result.body, /^"s", "1", "b", "4500", "bs", "5", "mp", "10", "cs", "0", "sl", "7200", "rl", "7800"$/);
});

test("buydyno already-owned path also returns quoted scalar fields", async () => {
  const sessionKey = "buydyno-already-owned";
  const gameCarId = 9102;
  const result = await handleGameAction({
    action: "buydyno",
    params: new Map([
      ["key", sessionKey],
      ["acid", String(gameCarId)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: createBuyDynoSupabaseStub({ sessionKey, gameCarId, hasDyno: 1, money: 4321 }),
    services: {},
  });

  assert.equal(result.source, "supabase:buydyno:already-owned");
  assert.match(result.body, /^"s", "1", "b", "4321", "bs", "5", "mp", "10", "cs", "0", "sl", "7200", "rl", "7800"$/);
});
