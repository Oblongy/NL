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

function parseAttrs(node) {
  return Object.fromEntries(
    [...node.matchAll(/([a-z0-9]+)='([^']*)'/gi)].map(([, key, value]) => [key, value]),
  );
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

test("buypart installs rims into the wheel slot and wheel xml", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const result = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "1004"],
      ["pt", "m"],
      ["pr", "720"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.match(state.carRow.wheel_xml, /wid='2'/);
  assert.match(state.carRow.wheel_xml, /id='1004'/);
  assert.match(state.carRow.wheel_xml, /ws='16'/);
  assert.match(state.carRow.parts_xml, /i='1004'/);
  assert.match(state.carRow.parts_xml, /pi='14'/);
});

test("buypart installs tires into the tire slot without changing wheel xml", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const result = await handleGameAction({
    action: "buypart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "1302"],
      ["pt", "m"],
      ["pr", "1400"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.carRow.wheel_xml, "");
  assert.match(state.carRow.parts_xml, /i='1302'/);
  assert.match(state.carRow.parts_xml, /pi='13'/);
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
  assert.match(state.carRow.parts_xml, /i='6000'/);
  assert.match(state.carRow.parts_xml, /pi='160'/);
  assert.match(state.carRow.parts_xml, /pdi='54321'/);
  assert.match(state.carRow.parts_xml, /di='54321'/);
  assert.match(state.carRow.parts_xml, /n='Custom Graphic'/);
  assert.match(state.carRow.parts_xml, /fe='png'/);
});

test("buypartugg resolves through the same custom graphics purchase handler", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 25 });

  const result = await handleGameAction({
    action: "buypartugg",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["pid", "6001"],
      ["pt", "p"],
      ["pr", "190"],
      ["did", "65432"],
      ["fx", "png"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.playerRow.money, 49810);
  assert.equal(state.playerRow.points, 25);
  assert.match(result.body, /<r s='2' b='49810' ai='/);
  assert.match(state.carRow.parts_xml, /i='6001'/);
  assert.match(state.carRow.parts_xml, /pi='161'/);
  assert.match(state.carRow.parts_xml, /pdi='65432'/);
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
  assert.match(state.carRow.parts_xml, /i='6000'/);
  assert.match(state.carRow.parts_xml, /pi='160'/);
  assert.match(state.carRow.parts_xml, /pdi='11111'/);
  assert.match(state.carRow.parts_xml, /i='6001'/);
  assert.match(state.carRow.parts_xml, /pi='161'/);
  assert.match(state.carRow.parts_xml, /pdi='22222'/);
});

test("getallparts returns the second XML payload the shop screen expects", async () => {
  const result = await handleGameAction({
    action: "getallparts",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    services: {},
  });

  assert.equal(result?.source, "static:getallparts");
  assert.match(result.body, /^"s", 1, "d", "/);
  assert.match(result.body, /"d1", "<n2><\/n2>"$/);
});

test("getallparts restores the wheels and tires category hierarchy", async () => {
  const result = await handleGameAction({
    action: "getallparts",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    services: {},
  });

  const attrsById = new Map(
    [...result.body.matchAll(/<c\b[^>]*>/g)].map((match) => {
      const attrs = parseAttrs(match[0]);
      return [attrs.i, attrs];
    }),
  );

  const wheelsAndTires = attrsById.get("12");
  const rims = attrsById.get("14");
  const tires = attrsById.get("13");

  assert.ok(wheelsAndTires, "shop should expose the Wheels & Tires parent category");
  assert.equal(wheelsAndTires.n, "Wheels &amp; Tires");
  assert.equal(wheelsAndTires.c, "2");
  assert.equal(wheelsAndTires.pi, "0");

  assert.ok(rims, "shop should expose the Rims child category");
  assert.equal(rims.n, "Rims");
  assert.equal(rims.pi, "12");

  assert.ok(tires, "shop should expose the Tires child category");
  assert.equal(tires.n, "Tires");
  assert.equal(tires.pi, "12");
});

test("getallwheelstires returns the second XML payload the shop screen expects", async () => {
  const result = await handleGameAction({
    action: "getallwheelstires",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    services: {},
  });

  assert.equal(result?.source, "generated:getallwheelstires");
  assert.match(result.body, /^"s", 1, "d", "/);
  assert.match(result.body, /"d1", "<n2><\/n2>"$/);
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

test("getinstalledenginepartbyaccountcar merges legacy engine-owned parts from the car row with owned engine parts", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub();
  state.engineRow.parts_xml = "<p ai='8001' i='206' pi='87'/>";
  state.carRow.parts_xml = "<p ai='8002' i='214' pi='21'/>";

  const result = await handleGameAction({
    action: "getinstalledenginepartbyaccountcar",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:getinstalledenginepartbyaccountcar");
  assert.match(result.body, /i='206'/);
  assert.match(result.body, /ai='8001'/);
  assert.match(result.body, /i='214'/);
  assert.match(result.body, /ai='8002'/);
});

test("getinstalledenginepartbyaccountcar prefers owned engine parts over legacy car parts for the same slot", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub();
  state.engineRow.parts_xml = "<p ai='8003' i='215' pi='21'/>";
  state.carRow.parts_xml = "<p ai='8004' i='214' pi='21'/>";

  const result = await handleGameAction({
    action: "getinstalledenginepartbyaccountcar",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:getinstalledenginepartbyaccountcar");
  assert.match(result.body, /i='215'/);
  assert.match(result.body, /ai='8003'/);
  assert.doesNotMatch(result.body, /i='214'/);
  assert.doesNotMatch(result.body, /ai='8004'/);
});

test("installed engine parts affect generated engine payload stats for getonecarengine and practice", async () => {
  const { supabase, state, sessionKey } = createPartPurchaseSupabaseStub({ money: 50000, points: 100 });

  const purchaseResult = await handleGameAction({
    action: "buyenginepart",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
      ["epid", "260"],
      ["pt", "m"],
      ["pr", "3000"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(purchaseResult?.source, "supabase:buyenginepart");
  assert.equal(state.playerRow.money, 47000);
  assert.match(state.engineRow.parts_xml, /i='260'/);

  const getOneCarEngineResult = await handleGameAction({
    action: "getonecarengine",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(getOneCarEngineResult?.source, "generated:getonecarengine");
  assert.match(getOneCarEngineResult.body, /r='2642'/);
  assert.match(getOneCarEngineResult.body, /x='5\.861'/);
  assert.match(getOneCarEngineResult.body, /y='32\.236'/);
  assert.match(getOneCarEngineResult.body, /z='5\.861'/);

  const practiceResult = await handleGameAction({
    action: "practice",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.carRow.game_car_id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(practiceResult?.source, "generated:practice");
  assert.match(practiceResult.body, /r='2642'/);
  assert.match(practiceResult.body, /x='5\.861'/);
  assert.match(practiceResult.body, /y='32\.236'/);
  assert.match(practiceResult.body, /z='5\.861'/);
});
