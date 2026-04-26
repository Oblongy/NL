import assert from "node:assert/strict";
import test from "node:test";

import {
  handleBuyEnginePart,
  handleBuyPart,
  handleInstallPart,
  handleUninstallPart,
} from "./game-actions/parts.js";

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
      return Number(rowValue ?? 0) >= Number(filter.value ?? 0);
    }
    return true;
  });
}

function createPartsModuleSupabaseStub({
  playerId = 14,
  money = 50000,
  points = 100,
  gameCarId = 6100,
  failGameCarsPartsUpdate = false,
  partsXml = "",
  inventoryRows = [],
} = {}) {
  const nowIso = new Date().toISOString();
  const sessionKey = `parts-module-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    sessionRows: [{
      session_key: sessionKey,
      player_id: playerId,
      last_seen_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    }],
    playerRows: [{
      id: playerId,
      username: "PartsModuleTester",
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
    }],
    carRows: [{
      game_car_id: gameCarId,
      account_car_id: gameCarId,
      player_id: playerId,
      catalog_car_id: 1,
      parts_xml: partsXml,
      wheel_xml: "",
      color_code: "FFFFFF",
      paint_id: 0,
      owned_engine_id: 7100,
      installed_engine_id: 7100,
      image_index: 0,
      locked: 0,
      aero: 0,
      selected: true,
    }],
    ownedEngineRows: [{
      id: 7100,
      player_id: playerId,
      installed_on_car_id: gameCarId,
      catalog_engine_part_id: 0,
      engine_type_id: 1,
      parts_xml: "",
      created_at: nowIso,
      updated_at: nowIso,
    }],
    inventoryRows: inventoryRows.map((row) => ({ ...row })),
  };

  const tables = {
    game_sessions: state.sessionRows,
    game_players: state.playerRows,
    game_cars: state.carRows,
    game_owned_engines: state.ownedEngineRows,
    game_parts_inventory: state.inventoryRows,
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
        gte(field, value) {
          filters.push({ type: "gte", field, value });
          return query;
        },
        order() {
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
        if (tableName === "game_cars" && failGameCarsPartsUpdate && payload && Object.hasOwn(payload, "parts_xml")) {
          return { data: null, error: new Error("forced parts save failure") };
        }

        const rows = matchedRows();
        for (const row of rows) {
          Object.assign(row, payload || {});
        }
        return { data: rows, error: null };
      }

      function applyInsert() {
        const rows = Array.isArray(payload) ? payload : [payload];
        const nextId = table.reduce((maxId, row) => Math.max(maxId, Number(row.id || 0)), 0) + 1;
        const inserted = rows.map((row, index) => {
          const nextRow = {
            id: row?.id ?? (nextId + index),
            ...row,
          };
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
  };

  return { supabase, state, sessionKey };
}

function createBaseContext({ supabase, sessionKey, params }) {
  return {
    supabase,
    params,
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    services: {},
    remoteAddress: "127.0.0.1",
  };
}

test("handleBuyPart sanitizes custom graphic decal ids before saving xml", async () => {
  const { supabase, state, sessionKey } = createPartsModuleSupabaseStub();

  const result = await handleBuyPart(createBaseContext({
    supabase,
    sessionKey,
    params: new Map([
      ["aid", String(state.playerRows[0].id)],
      ["sk", sessionKey],
      ["acid", String(state.carRows[0].game_car_id)],
      ["pid", "6001"],
      ["pt", "p"],
      ["pr", "190"],
      ["did", "../54'321<&>"],
      ["fx", "png"],
    ]),
  }));

  assert.equal(result?.source, "supabase:buypart");
  assert.equal(state.playerRows[0].money, 49810);
  assert.match(state.carRows[0].parts_xml, /pdi='54321'/);
  assert.match(state.carRows[0].parts_xml, /di='54321'/);
  assert.ok(!state.carRows[0].parts_xml.includes("../54'321<&>"));
  assert.ok(!state.carRows[0].parts_xml.includes(".."));
});

test("handleBuyPart leaves money untouched when saving the purchased part fails", async () => {
  const { supabase, state, sessionKey } = createPartsModuleSupabaseStub({
    failGameCarsPartsUpdate: true,
  });

  const result = await handleBuyPart(createBaseContext({
    supabase,
    sessionKey,
    params: new Map([
      ["aid", String(state.playerRows[0].id)],
      ["sk", sessionKey],
      ["acid", String(state.carRows[0].game_car_id)],
      ["pid", "6001"],
      ["pt", "p"],
      ["pr", "190"],
      ["did", "54321"],
      ["fx", "png"],
    ]),
  }));

  assert.equal(result?.source, "supabase:buypart:update-failed");
  assert.equal(state.playerRows[0].money, 50000);
  assert.equal(state.carRows[0].parts_xml, "");
});

test("handleBuyEnginePart leaves money untouched when saving the purchased part fails", async () => {
  const { supabase, state, sessionKey } = createPartsModuleSupabaseStub({
    failGameCarsPartsUpdate: true,
  });

  const result = await handleBuyEnginePart(createBaseContext({
    supabase,
    sessionKey,
    params: new Map([
      ["aid", String(state.playerRows[0].id)],
      ["sk", sessionKey],
      ["acid", String(state.carRows[0].game_car_id)],
      ["epid", "200"],
      ["pr", "500"],
    ]),
  }));

  assert.equal(result?.source, "supabase:buyenginepart:update-failed");
  assert.equal(state.playerRows[0].money, 50000);
  assert.equal(state.carRows[0].parts_xml, "");
});

test("handleInstallPart does not return the replaced part to inventory if the parts save fails", async () => {
  const existingPartXml = "<p ai='installed-201' i='201' pi='96' t='e' n='Injen Short Ram Intake' p='350' pp='4' g='C' di='2' pdi='2' b='injen' bn='Injen' mn='Short Ram Intake' l='100' in='1' mo='0' hp='10' tq='5' wt='0' cc='0'/>";
  const { supabase, state, sessionKey } = createPartsModuleSupabaseStub({
    failGameCarsPartsUpdate: true,
    partsXml: existingPartXml,
    inventoryRows: [{
      id: 900,
      player_id: 14,
      part_catalog_id: 200,
      quantity: 1,
    }],
  });

  const result = await handleInstallPart(createBaseContext({
    supabase,
    sessionKey,
    params: new Map([
      ["aid", String(state.playerRows[0].id)],
      ["sk", sessionKey],
      ["acid", String(state.carRows[0].game_car_id)],
      ["acpid", "900"],
      ["pid", "200"],
    ]),
  }));

  assert.equal(result?.source, "supabase:installpart:update-failed");
  assert.equal(state.carRows[0].parts_xml, existingPartXml);
  assert.deepEqual(
    state.inventoryRows.map((row) => ({ id: row.id, part_catalog_id: row.part_catalog_id, quantity: row.quantity })),
    [{ id: 900, part_catalog_id: 200, quantity: 1 }],
  );
});

test("handleUninstallPart does not add inventory when the parts save fails", async () => {
  const installedPartXml = "<p ai='installed-200' i='200' pi='96' t='e' n='AEM Cold Air Intake' p='500' pp='5' g='C' di='1' pdi='1' b='aem' bn='AEM' mn='Cold Air Intake' l='100' in='1' mo='0' hp='15' tq='8' wt='0' cc='0'/>";
  const { supabase, state, sessionKey } = createPartsModuleSupabaseStub({
    failGameCarsPartsUpdate: true,
    partsXml: installedPartXml,
  });

  const result = await handleUninstallPart(createBaseContext({
    supabase,
    sessionKey,
    params: new Map([
      ["aid", String(state.playerRows[0].id)],
      ["sk", sessionKey],
      ["acid", String(state.carRows[0].game_car_id)],
      ["acpids", "installed-200"],
      ["pids", "200"],
    ]),
  }));

  assert.equal(result?.source, "supabase:uninstallpart:update-failed");
  assert.equal(state.carRows[0].parts_xml, installedPartXml);
  assert.deepEqual(state.inventoryRows, []);
});
