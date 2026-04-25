import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
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
    if (filter.type === "gte") {
      return String(rowValue ?? "") >= String(filter.value ?? "");
    }
    return true;
  });
}

function createPartPurchaseSupabaseStub({
  playerId = 14,
  money = 50000,
  points = 100,
  gameCarId = 6100,
  ownedEngineId = 7100,
} = {}) {
  const nowIso = new Date().toISOString();
  const sessionKey = `parts-buy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    sessionRow: {
      session_key: sessionKey,
      player_id: playerId,
      last_seen_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    },
    playerRow: {
      id: playerId,
      username: "PartsBuyer",
      money,
      points,
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
      default_car_game_id: gameCarId,
    },
    carRow: {
      game_car_id: gameCarId,
      player_id: playerId,
      catalog_car_id: 1,
      parts_xml: "",
      wheel_xml: "",
      color_code: "FFFFFF",
      paint_id: 0,
      owned_engine_id: ownedEngineId,
      installed_engine_id: ownedEngineId,
      image_index: 0,
      locked: 0,
      aero: 0,
    },
    engineRow: {
      id: ownedEngineId,
      player_id: playerId,
      installed_on_car_id: gameCarId,
      catalog_engine_part_id: 0,
      engine_type_id: 1,
      parts_xml: "",
      created_at: nowIso,
      updated_at: nowIso,
    },
  };

  const tables = {
    game_sessions: [state.sessionRow],
    game_players: [state.playerRow],
    game_cars: [state.carRow],
    game_owned_engines: [state.engineRow],
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
        order() {
          return query;
        },
        maybeSingle: async () => runMaybeSingle(),
        single: async () => runSingle(),
        then(resolve, reject) {
          return Promise.resolve(mode === "update" ? runUpdate() : runMany()).then(resolve, reject);
        },
      };

      function matchedRows() {
        return table.filter((row) => matchesFilters(row, filters));
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

  return { supabase, state, sessionKey };
}

test("buypart charges points instead of money when the client requests a points purchase", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 100 });

  const result = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "214"],
      ["pt", "p"],
      ["pr", "30"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.playerRow.money, 50000);
  assert.equal(state.playerRow.points, 70);
  assert.match(result.body, /<r s='2' b='50000' ai='/);
  assert.match(result.body, /<r s='1' b='70'>/);
  assert.match(state.carRow.parts_xml, /i='214'/);
});

test("buypart keeps the existing points balance in the purchase response for cash buys", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const result = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "200"],
      ["pt", "m"],
      ["pr", "500"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.playerRow.money, 49500);
  assert.equal(state.playerRow.points, 25);
  assert.match(result.body, /<r s='2' b='49500' ai='/);
  assert.match(result.body, /<r s='1' b='25'>/);
});

test("buypart treats custom graphics as cash purchases even though they use pt=p", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const result = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "6000"],
      ["pt", "p"],
      ["pr", "110"],
      ["did", "54321"],
      ["fx", "png"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.playerRow.money, 49890);
  assert.equal(state.playerRow.points, 25);
  assert.match(result.body, /<r s='2' b='49890' ai='/);
  assert.match(result.body, /<r s='1' b='25'>/);
  assert.match(state.carRow.parts_xml, /i='16001'/);
  assert.match(state.carRow.parts_xml, /pi='160'/);
  assert.match(state.carRow.parts_xml, /pdi='54321'/);
  assert.match(state.carRow.parts_xml, /di='1'/);
  assert.match(state.carRow.parts_xml, /bn='Graphics'/);
  assert.match(state.carRow.parts_xml, /mn='Hood Graphic'/);
  assert.match(state.carRow.parts_xml, /fe='png'/);
});

test("buypart keeps custom graphics installed across multiple panel slots", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const hoodPurchase = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "6000"],
      ["pt", "p"],
      ["pr", "110"],
      ["did", "11111"],
      ["fx", "png"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  const sidePurchase = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "6001"],
      ["pt", "p"],
      ["pr", "190"],
      ["did", "22222"],
      ["fx", "png"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(hoodPurchase?.source, "supabase:buypart");
  assert.equal(sidePurchase?.source, "supabase:buypart");
  assert.equal(state.playerRow.money, 49700);
  assert.equal(state.playerRow.points, 25);
  assert.match(state.carRow.parts_xml, /i='16001'/);
  assert.match(state.carRow.parts_xml, /pi='160'/);
  assert.match(state.carRow.parts_xml, /pdi='11111'/);
  assert.match(state.carRow.parts_xml, /i='16101'/);
  assert.match(state.carRow.parts_xml, /pi='161'/);
  assert.match(state.carRow.parts_xml, /pdi='22222'/);
});

test("buyenginepart charges points instead of money when the engine part is bought with points", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 100 });

  const result = await handleGameAction({
    action: "buyenginepart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["epid", "215"],
      ["pt", "p"],
      ["pr", "50"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buyenginepart");
  assert.equal(state.playerRow.money, 50000);
  assert.equal(state.playerRow.points, 50);
  assert.match(result.body, /<r s='2' b='50000' ai='/);
  assert.match(result.body, /<r s='1' b='50'>/);
  assert.match(state.engineRow.parts_xml, /i='215'/);
});
