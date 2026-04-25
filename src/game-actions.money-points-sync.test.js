import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";
import { buildLoginBody } from "./login-payload.js";
import { PARTS_CATALOG_XML } from "./parts-catalog.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function parseXmlAttrs(rawEntry) {
  const attrs = {};
  for (const match of String(rawEntry || "").matchAll(/(\w+)=['"]([^'"]*)['"]/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function getFirstCatalogEnginePart() {
  for (const match of String(PARTS_CATALOG_XML).matchAll(/<p\b[^>]*\/>/g)) {
    const attrs = parseXmlAttrs(match[0]);
    if (String(attrs.t || "") === "m") {
      return {
        id: Number(attrs.i || 0),
        price: Number(attrs.p || 0),
      };
    }
  }

  throw new Error("Expected at least one engine catalog entry in PARTS_CATALOG_XML");
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
    if (filter.type === "ilike") {
      const pattern = String(filter.value ?? "").toLowerCase().replaceAll("%", "");
      return String(rowValue ?? "").toLowerCase().includes(pattern);
    }
    return true;
  });
}

function createMoneyPointsSyncSupabaseStub({
  playerId = 14,
  money = 50000,
  points = 100,
  gameCarId = 6100,
  passwordHash = "secret",
  transactions = [],
} = {}) {
  const nowIso = new Date().toISOString();
  const sessionKey = `money-points-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      username: "BalanceTester",
      password_hash: passwordHash,
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
    gameCars: [{
      game_car_id: gameCarId,
      player_id: playerId,
      catalog_car_id: 1,
      parts_xml: "",
      wheel_xml: "",
      color_code: "FFFFFF",
      paint_index: 0,
      plate_name: "",
      image_index: 0,
      locked: 0,
      aero: 0,
      selected: true,
      created_at: nowIso,
      updated_at: nowIso,
    }],
    ownedEngines: [{
      id: 7100,
      player_id: playerId,
      installed_on_car_id: gameCarId,
      catalog_engine_part_id: 0,
      engine_type_id: 1,
      parts_xml: "",
      created_at: nowIso,
      updated_at: nowIso,
    }],
    nextOwnedEngineId: 7101,
    transactions: transactions.map((row, index) => ({
      id: index + 1,
      player_id: playerId,
      money_change: 0,
      points_change: 0,
      created_at: nowIso,
      ...row,
    })),
  };

  const tables = {
    game_sessions: [state.sessionRow],
    game_players: [state.playerRow],
    game_cars: state.gameCars,
    game_owned_engines: state.ownedEngines,
    game_transactions: state.transactions,
  };

  const supabase = {
    from(tableName) {
      const table = tables[tableName] || [];
      const filters = [];
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
        ilike(field, value) {
          filters.push({ type: "ilike", field, value });
          return query;
        },
        gte() {
          return query;
        },
        order() {
          return query;
        },
        maybeSingle: async () => runMaybeSingle(),
        single: async () => runSingle(),
        then(resolve, reject) {
          return Promise.resolve(runThen()).then(resolve, reject);
        },
      };

      function matchedRows() {
        return table.filter((row) => matchesFilters(row, filters));
      }

      function runMaybeSingle() {
        return { data: matchedRows()[0] || null, error: null };
      }

      function applyUpdate() {
        const rows = matchedRows();
        for (const row of rows) {
          Object.assign(row, payload || {});
        }
        return rows;
      }

      function applyInsert() {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = rows.map((row) => {
          if (tableName === "game_owned_engines") {
            const nextRow = {
              id: state.nextOwnedEngineId++,
              created_at: nowIso,
              updated_at: nowIso,
              ...row,
            };
            table.push(nextRow);
            return nextRow;
          }

          const nextRow = { ...row };
          table.push(nextRow);
          return nextRow;
        });
        return inserted;
      }

      function applyDelete() {
        const rows = matchedRows();
        for (const row of rows) {
          const index = table.indexOf(row);
          if (index >= 0) {
            table.splice(index, 1);
          }
        }
        return rows;
      }

      function runSingle() {
        if (mode === "update") {
          const rows = applyUpdate();
          return { data: rows[0] || null, error: null };
        }
        if (mode === "insert") {
          const rows = applyInsert();
          return { data: rows[0] || null, error: null };
        }
        return { data: matchedRows()[0] || null, error: null };
      }

      function runThen() {
        if (mode === "update") {
          return { data: applyUpdate(), error: null };
        }
        if (mode === "insert") {
          return { data: applyInsert(), error: null };
        }
        if (mode === "delete") {
          applyDelete();
          return { error: null };
        }
        return { data: matchedRows(), error: null };
      }

      return query;
    },
  };

  return { supabase, state, sessionKey };
}

test("login payload normalizes invalid money and points instead of emitting NaN", () => {
  const body = buildLoginBody({
    id: 99,
    username: "BalanceTester",
    money: "NaN",
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
  }, [], null, "test-session", createLogger());

  assert.match(body, /m='0'/);
  assert.match(body, /p='0'/);
  assert.doesNotMatch(body, /NaN|undefined/);
});

test("login payload includes team id without overwriting title id", () => {
  const body = buildLoginBody({
    id: 99,
    username: "BalanceTester",
    money: 50000,
    points: 10,
    score: 0,
    image_id: 0,
    active: true,
    vip: false,
    facebook_connected: false,
    sponsor_rating: 0,
    driver_text: "",
    team_id: 6,
    team_name: "Pure Insanity",
    gender: "m",
    respect_level: 0,
    title_id: 1,
    track_rank: 0,
    location_id: 100,
    background_id: 0,
    default_car_game_id: 0,
  }, [], null, "test-session", createLogger());

  assert.match(body, /tn='Pure Insanity'/);
  assert.match(body, /ti='1'/);
  assert.match(body, /tid='6'/);
});

test("login recovers invalid money and points from transaction deltas", async () => {
  const { supabase } = createMoneyPointsSyncSupabaseStub({
    money: "NaN",
    points: "NaN",
    transactions: [
      { money_change: -2000, points_change: 10 },
      { money_change: -1500, points_change: -3 },
    ],
  });

  const result = await handleGameAction({
    action: "login",
    params: new Map([
      ["u", "BalanceTester"],
      ["p", "secret"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:login");
  assert.match(result.body, /m='46500'/);
  assert.match(result.body, /p='7'/);
  assert.doesNotMatch(result.body, /NaN|undefined/);
});

test("sellcar preserves the caller's points balance in the response wrapper", async () => {
  const { supabase, state, sessionKey } = createMoneyPointsSyncSupabaseStub({ money: 50000, points: 37 });

  const result = await handleGameAction({
    action: "sellcar",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.gameCars[0].game_car_id)],
      ["pr", "1000"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:sellcar");
  assert.equal(state.playerRow.money, 51000);
  assert.equal(state.playerRow.points, 37);
  assert.match(result.body, /<r s='2' b='51000' ai='0'\/>/);
  assert.match(result.body, /<r s='1' b='37'\/>/);
});

test("buyengine preserves the caller's points balance on success", async () => {
  const enginePart = getFirstCatalogEnginePart();
  const { supabase, state, sessionKey } = createMoneyPointsSyncSupabaseStub({
    money: enginePart.price + 5000,
    points: 62,
  });

  const result = await handleGameAction({
    action: "buyengine",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.gameCars[0].game_car_id)],
      ["eid", String(enginePart.id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buyengine");
  assert.equal(state.playerRow.money, 5000);
  assert.equal(state.playerRow.points, 62);
  assert.match(result.body, /<r s='2' b='5000' ai='/);
  assert.match(result.body, /<r s='1' b='62'><\/r>/);
});

test("buyengine preserves the caller's points balance when funds are insufficient", async () => {
  const enginePart = getFirstCatalogEnginePart();
  const { supabase, state, sessionKey } = createMoneyPointsSyncSupabaseStub({
    money: Math.max(0, enginePart.price - 1),
    points: 19,
  });

  const result = await handleGameAction({
    action: "buyengine",
    params: new Map([
      ["aid", String(state.playerRow.id)],
      ["sk", sessionKey],
      ["acid", String(state.gameCars[0].game_car_id)],
      ["eid", String(enginePart.id)],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.equal(result?.source, "supabase:buyengine:insufficient-funds");
  assert.equal(state.playerRow.money, Math.max(0, enginePart.price - 1));
  assert.equal(state.playerRow.points, 19);
  assert.match(result.body, /<r s='-3' b='/);
  assert.match(result.body, /<r s='0' b='19'\/>/);
});
