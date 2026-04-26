import assert from "node:assert/strict";
import test from "node:test";

import { listCarsForPlayer } from "./data-access/cars.js";

function createCarsSupabaseStub() {
  const nowIso = new Date().toISOString();
  const queryCounts = {
    game_cars: 0,
    game_owned_engines: 0,
  };
  const carRows = [
    {
      game_car_id: 42,
      player_id: 7,
      catalog_car_id: 1,
      selected: true,
      paint_index: 0,
      plate_name: "",
      color_code: "FFFFFF",
      image_index: 0,
      locked: 0,
      aero: 0,
      wheel_xml: "",
      parts_xml: "",
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];
  const ownedEngineRows = [
    {
      id: 99,
      player_id: 7,
      installed_on_car_id: 42,
      catalog_engine_part_id: 0,
      engine_type_id: 1,
      parts_xml: "",
      created_at: nowIso,
      updated_at: nowIso,
    },
  ];

  function matchesFilters(row, filters = []) {
    return filters.every((filter) => {
      if (filter.type !== "eq") {
        return true;
      }
      return String(row?.[filter.field] ?? "") === String(filter.value ?? "");
    });
  }

  const supabase = {
    from(tableName) {
      const rows = tableName === "game_cars" ? carRows : tableName === "game_owned_engines" ? ownedEngineRows : [];
      const filters = [];
      let mode = "select";
      let payload = null;

      const query = {
        select() {
          queryCounts[tableName] = (queryCounts[tableName] || 0) + 1;
          return query;
        },
        eq(field, value) {
          filters.push({ type: "eq", field, value });
          return query;
        },
        in() {
          return query;
        },
        order() {
          return query;
        },
        update(nextPayload) {
          mode = "update";
          payload = nextPayload;
          return query;
        },
        then(resolve, reject) {
          const run = async () => {
            if (mode === "update") {
              const matched = rows.filter((row) => matchesFilters(row, filters));
              for (const row of matched) {
                Object.assign(row, payload || {});
              }
              return { data: matched, error: null };
            }
            return {
              data: rows.filter((row) => matchesFilters(row, filters)),
              error: null,
            };
          };
          return Promise.resolve(run()).then(resolve, reject);
        },
      };

      return query;
    },
  };

  return { supabase, queryCounts };
}

test("listCarsForPlayer can skip owned-engine attachment on lightweight read paths", async () => {
  const { supabase, queryCounts } = createCarsSupabaseStub();

  const cars = await listCarsForPlayer(supabase, 7, [], { includeOwnedEngines: false });

  assert.equal(cars.length, 1);
  assert.equal(cars[0].game_car_id, 42);
  assert.equal(queryCounts.game_cars, 1);
  assert.equal(queryCounts.game_owned_engines, 0);
  assert.equal(cars[0].owned_engine_id, undefined);
});
