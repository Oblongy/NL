import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";
import { getRedLine } from "./engine-physics.js";
import { failureBody } from "./game-xml.js";
import { getShowroomCarSpec } from "./showroom-car-specs.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

function createSessionSupabaseStub({
  playerId = 77,
  sessionKey = "showroom-spec-test-session",
  ownedCars = [],
} = {}) {
  const sessionRow = {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: new Date().toISOString(),
  };
  const playerRow = {
    id: playerId,
    username: "ShowroomSpecTester",
    money: 0,
    points: 0,
    score: 0,
    default_car_game_id: Number(ownedCars[0]?.game_car_id || 0),
  };
  const cars = ownedCars.map((car) => ({
    selected: false,
    paint_index: 0,
    plate_name: "",
    color_code: "FFFFFF",
    image_index: 0,
    locked: 0,
    aero: 0,
    wheel_xml: "",
    parts_xml: "",
    test_drive_invitation_id: null,
    test_drive_name: null,
    test_drive_money_price: null,
    test_drive_point_price: null,
    test_drive_expires_at: null,
    ...car,
  }));

  function matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.type === "eq") {
        return String(row?.[filter.field] ?? "") === String(filter.value ?? "");
      }
      return true;
    });
  }

  return {
    from(table) {
      const filters = [];
      let mode = "select";
      let payload = null;
      const query = {
        select() {
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
        eq(field, value) {
          filters.push({ type: "eq", field, value });
          return query;
        },
        gte() {
          return query;
        },
        maybeSingle: async () => {
          if (table === "game_sessions") {
            return {
              data: matchesFilters(sessionRow, filters) ? sessionRow : null,
              error: null,
            };
          }
          if (table === "game_cars") {
            return {
              data: cars.find((car) => matchesFilters(car, filters)) || null,
              error: null,
            };
          }
          if (table === "game_players") {
            return {
              data: matchesFilters(playerRow, filters) ? playerRow : null,
              error: null,
            };
          }
          if (table === "game_owned_engines") {
            const engines = cars.map((car, index) => ({
              id: index + 1,
              player_id: Number(car.player_id || playerId),
              installed_on_car_id: Number(car.game_car_id || 0),
              catalog_engine_part_id: 0,
              engine_type_id: Number(car.engine_type_id || 1),
              parts_xml: "",
            }));
            return {
              data: engines.find((engine) => matchesFilters(engine, filters)) || null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
        then(resolve, reject) {
          const runner = async () => {
            if (table === "game_sessions" && mode === "update") {
              if (matchesFilters(sessionRow, filters)) {
                Object.assign(sessionRow, payload || {});
              }
              return { data: [sessionRow], error: null };
            }
            if (table === "game_cars") {
              return {
                data: cars.filter((car) => matchesFilters(car, filters)),
                error: null,
              };
            }
            if (table === "game_players") {
              return {
                data: matchesFilters(playerRow, filters) ? [playerRow] : [],
                error: null,
              };
            }
            if (table === "game_owned_engines") {
              const engines = cars.map((car, index) => ({
                id: index + 1,
                player_id: Number(car.player_id || playerId),
                installed_on_car_id: Number(car.game_car_id || 0),
                catalog_engine_part_id: 0,
                engine_type_id: Number(car.engine_type_id || 1),
                parts_xml: "",
              }));
              return {
                data: engines.filter((engine) => matchesFilters(engine, filters)),
                error: null,
              };
            }
            return { data: [], error: null };
          };
          return Promise.resolve(runner()).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

test("catalog car 1 showroom spec exposes the B18C1 stock engine label", () => {
  const spec = getShowroomCarSpec(1);

  assert.ok(spec, "expected showroom spec for catalog car 1");
  assert.equal(spec.eo, "B18C1 1.8L I4 VTEC");
  assert.equal(getRedLine(spec.eo, spec.tt), 7600);
});

test("catalog car 102 uses its own showroom spec instead of borrowing spec 101", () => {
  const spec = getShowroomCarSpec(102);

  assert.ok(spec, "expected showroom spec for catalog car 102");
  assert.equal(spec.y, "2006");
  assert.equal(spec.eo, "5.4L V8 SC");
  assert.equal(spec.dt, "RWD");
  assert.equal(spec.tt, "5-speed automatic");
  assert.equal(spec.sw, "3858");
  assert.equal(spec.st, "11.2");
  assert.equal(spec.hp, 617);
});

test("getonecarengine still returns driveable xml and timing for catalog car 1", async () => {
  const playerId = 77;
  const sessionKey = `showroom-b18c1-${Date.now()}`;
  const supabase = createSessionSupabaseStub({
    playerId,
    sessionKey,
    ownedCars: [
      {
        game_car_id: 909,
        player_id: playerId,
        catalog_car_id: 1,
        selected: true,
      },
    ],
  });

  const result = await handleGameAction({
    action: "getonecarengine",
    params: new Map([
      ["aid", String(playerId)],
      ["sk", sessionKey],
      ["acid", "909"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.ok(result, "expected getonecarengine response");
  assert.notEqual(result.body, failureBody());
  assert.equal(result.source, "generated:getonecarengine");
  assert.match(result.body, /"d", "<n2 /);
  assert.match(result.body, /"t", \[/);
  assert.match(result.body, /sl='7600'/);
});

test("getonecarengine marks turbo-equipped cars as turbo in driveable engine xml", async () => {
  const playerId = 77;
  const sessionKey = `showroom-turbo-${Date.now()}`;
  const supabase = createSessionSupabaseStub({
    playerId,
    sessionKey,
    ownedCars: [
      {
        game_car_id: 910,
        player_id: playerId,
        catalog_car_id: 1,
        selected: true,
        parts_xml: "<p ai='studio_87_206' i='206' pi='87' n='Garrett Small Turbo Kit'/>",
      },
    ],
  });

  const result = await handleGameAction({
    action: "getonecarengine",
    params: new Map([
      ["aid", String(playerId)],
      ["sk", sessionKey],
      ["acid", "910"],
    ]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.ok(result, "expected getonecarengine response");
  assert.notEqual(result.body, failureBody());
  assert.equal(result.source, "generated:getonecarengine");
  assert.match(result.body, /<n2[^>]* d='T'/);
});
