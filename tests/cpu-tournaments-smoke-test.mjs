import assert from 'assert';
import { handleGameAction } from "../src/game-actions.js";
import { createTournamentKeyCode } from "../src/http-server.js";
import { buildLoginBody } from "../src/login-payload.js";
import { failureBody } from "../src/game-xml.js";

function createLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function createTournamentSupabaseStub({
  playerId = 77,
  sessionKey = "cpu-tournament-session",
  extraPlayers = [],
  ownedCars = [],
} = {}) {
  const sessionRow = {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: new Date().toISOString(),
  };
  const basePlayer = {
    id: playerId,
    username: "CpuTournamentTester",
    money: 0,
    points: 0,
    score: 0,
    default_car_game_id: 0,
  };
  const players = [
    basePlayer,
    ...extraPlayers.map((player) => ({
      money: 0,
      points: 0,
      score: 0,
      default_car_game_id: 0,
      ...player,
    })),
  ];
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
  const ownedEngines = cars.map((car, index) => ({
    id: index + 1,
    player_id: Number(car.player_id || playerId),
    installed_on_car_id: Number(car.game_car_id || 0),
    catalog_engine_part_id: 0,
    engine_type_id: Number(car.engine_type_id || 1),
    parts_xml: "",
  }));

  function matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.type === "eq") {
        return String(row?.[filter.field] ?? "") === String(filter.value ?? "");
      }
      if (filter.type === "in") {
        return filter.values.map((value) => String(value)).includes(String(row?.[filter.field] ?? ""));
      }
      if (filter.type === "ilike") {
        const needle = String(filter.value ?? "").replace(/%/g, "").toLowerCase();
        return String(row?.[filter.field] ?? "").toLowerCase().includes(needle);
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
        in(field, values) {
          filters.push({ type: "in", field, values: Array.isArray(values) ? values : [] });
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
        maybeSingle: async () => {
          if (table === "game_sessions") {
            return {
              data: matchesFilters(sessionRow, filters) ? sessionRow : null,
              error: null,
            };
          }
          if (table === "game_players") {
            return {
              data: players.find((player) => matchesFilters(player, filters)) || null,
              error: null,
            };
          }
          if (table === "game_cars") {
            return {
              data: cars.find((car) => matchesFilters(car, filters)) || null,
              error: null,
            };
          }
          if (table === "game_owned_engines") {
            return {
              data: ownedEngines.find((engine) => matchesFilters(engine, filters)) || null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
        update(updatePayload) {
          mode = "update";
          payload = updatePayload;
          return query;
        },
        single: async () => {
          if (table === "game_players" && mode === "update") {
            const player = players.find((entry) => matchesFilters(entry, filters)) || null;
            if (player) {
              Object.assign(player, payload || {});
            }
            return { data: player, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve, reject) {
          const runner = async () => {
            if (table === "game_players") {
              if (mode === "update") {
                const player = players.find((entry) => matchesFilters(entry, filters)) || null;
                if (player) {
                  Object.assign(player, payload || {});
                }
                return { data: player ? [player] : [], error: null };
              }

              return {
                data: players.filter((player) => matchesFilters(player, filters)),
                error: null,
              };
            }

            if (table === "game_cars") {
              return {
                data: cars.filter((car) => matchesFilters(car, filters)),
                error: null,
              };
            }

            if (table === "game_owned_engines") {
              return {
                data: ownedEngines.filter((engine) => matchesFilters(engine, filters)),
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

async function testCtgrCtId2() {
  const context = {
    action: 'ctgr',
    params: new Map([['ctid', '2']]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctgr with ctid=2 should produce a result');
  assert.ok(result.body.includes('<n2'), 'ctgr should return computer tournament field xml');
  assert.strictEqual((result.body.match(/<r\b/g) || []).length, 32, 'ctgr should expose a 32-racer bracket');
  assert.ok(result.source.startsWith('generated:ctgr:tournament='), 'ctgr source should indicate tournament id');
}

async function testCtgrTid3() {
  const context = {
    action: 'ctgr',
    params: new Map([['tid', '3']]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctgr with tid=3 should produce a result');
  assert.ok(result.body.includes('<n2'), 'ctgr should return computer tournament field xml');
  assert.strictEqual((result.body.match(/<r\b/g) || []).length, 32, 'ctgr should expose a 32-racer bracket');
  assert.ok(result.source.startsWith('generated:ctgr:tournament='), 'ctgr source should indicate tournament id');
}

async function testCtgrVariants() {
  await testCtgrCtId2();
  await testCtgrTid3();
}

async function testCtjtBadSession() {
  const context = {
    action: 'ctjt',
    params: new Map(),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctjt with no supabase should return a response');
  assert.strictEqual(result.body, failureBody(), 'ctjt should return failure body on no-supabase');
  assert.strictEqual(result.source, 'supabase:ctjt:bad-session');
}

async function testCtctBadSession() {
  const context = {
    action: 'ctct',
    params: new Map(),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctct with no supabase should return a response');
  assert.strictEqual(result.body, failureBody(), 'ctct should return failure body on no-supabase');
  assert.strictEqual(result.source, 'supabase:ctct:bad-session');
}

async function testCtrtBadSession() {
  const context = {
    action: 'ctrt',
    params: new Map(),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctrt with no supabase should return a response');
  assert.strictEqual(result.body, failureBody(), 'ctrt should return failure body on no-supabase');
  assert.strictEqual(result.source, 'supabase:ctrt:bad-session');
}

async function testCtstBadSession() {
  const context = {
    action: 'ctst',
    params: new Map(),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase: null,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctst with no supabase should return a response');
  assert.strictEqual(result.body, failureBody(), 'ctst should return failure body on no-supabase');
  assert.strictEqual(result.source, 'supabase:ctst:bad-session');
}

async function testCtctReturnsEngineTimingForQualifyCar() {
  const playerId = 77;
  const sessionKey = `cpu-ctct-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({
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
  const context = {
    action: 'ctct',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', 'tourney-key-1'],
      ['bt', '13.456'],
      ['acid', '909'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctct should return an engine payload when session is valid');
  assert.ok(
    result.body.includes(`"d", "<n2 `),
    'ctct should return driveable engine xml for the qualifying car',
  );
  assert.ok(
    result.body.includes(`"t", [`),
    'ctct should return the timing array alongside the engine xml',
  );
  assert.ok(
    !result.body.includes(`<q><r `),
    'ctct should not return the queue-seed xml shape',
  );
  assert.strictEqual(result.source, 'generated:ctct:with-engine-timing');
}

async function testCtctLegacyDialKeyReturnsEngineTiming() {
  const playerId = 78;
  const sessionKey = `cpu-ctct-legacy-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({
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
  const context = {
    action: 'ctct',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', '16'],
      ['bt', '12.000'],
      ['acid', '909'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase,
    services: {},
  };
  const result = await handleGameAction(context);
  assert.ok(result, 'ctct should return a payload for legacy dial key path');
  assert.ok(
    result.body.includes(`"d", "<n2 `),
    'ctct should still return driveable engine xml when the client submits a numeric dial key',
  );
  assert.ok(
    result.body.includes(`"t", [`),
    'ctct should keep returning the timing array for the legacy dial key path',
  );
  assert.ok(
    !result.body.includes(`"k", "16"`),
    'ctct should not echo the numeric dial key back in the response body',
  );
  assert.strictEqual(result.source, 'generated:ctct:with-engine-timing');
}

async function testCpuTournamentKeyMatchesReferenceFlow() {
  const playerId = "63";
  const cpuKey = createTournamentKeyCode(playerId, "0", "cpu");
  const blankTypeKey = createTournamentKeyCode(playerId, "999", "");

  assert.strictEqual(cpuKey, "28", 'CPU tournament key should match the reference deterministic dial key');
  assert.strictEqual(blankTypeKey, cpuKey, 'Missing tournament type should still follow the CPU tournament key path');
}

function createOwnedCar(overrides = {}) {
  return {
    game_car_id: 210,
    catalog_car_id: 54,
    selected: true,
    plate_name: "CPU TEST",
    locked: 0,
    color_code: "FF0000",
    image_index: 0,
    test_drive_active: 0,
    test_drive_expired: 0,
    test_drive_invitation_id: "",
    test_drive_name: "",
    test_drive_money_price: 0,
    test_drive_point_price: 0,
    test_drive_hours_remaining: 0,
    wheel_xml: "",
    parts_xml: "",
    ...overrides,
  };
}

function createBuyCarSupabaseStub({
  playerId = 14,
  sessionKey = "buycar-session",
  startingMoney = 50000,
  startingPoints = 100,
  existingCars = [],
} = {}) {
  const sessionRow = {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: new Date().toISOString(),
  };
  const playerRow = {
    id: playerId,
    username: "GarageColorTester",
    money: startingMoney,
    points: startingPoints,
    default_car_game_id: existingCars[0]?.game_car_id ?? 0,
    location_id: 100,
  };
  const gameCars = existingCars.map((car) => ({
    player_id: playerId,
    ...car,
  }));
  let nextGameCarId = gameCars.reduce((maxId, car) => Math.max(maxId, Number(car.game_car_id || 0)), 242) + 1;

  function matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.type === "eq") {
        return String(row?.[filter.field] ?? "") === String(filter.value ?? "");
      }
      if (filter.type === "in") {
        return filter.values.map((value) => String(value)).includes(String(row?.[filter.field] ?? ""));
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
        gte() {
          return query;
        },
        in(field, values) {
          filters.push({ type: "in", field, values: Array.isArray(values) ? values : [] });
          return query;
        },
        order() {
          return query;
        },
        update(patch) {
          mode = "update";
          payload = patch;
          return query;
        },
        insert(insertPayload) {
          mode = "insert";
          payload = insertPayload;
          return query;
        },
        maybeSingle: async () => runMaybeSingle(),
        single: async () => runSingle(),
        then(resolve, reject) {
          return Promise.resolve(mode === "update" ? runUpdate() : runMany()).then(resolve, reject);
        },
      };

      function getRows() {
        if (table === "game_cars") {
          return gameCars;
        }
        if (table === "game_owned_engines") {
          return [];
        }
        return [];
      }

      function runMaybeSingle() {
        if (table === "game_sessions") {
          return { data: sessionRow, error: null };
        }
        if (table === "game_players") {
          return { data: playerRow, error: null };
        }
        if (table === "game_cars") {
          const row = getRows().find((entry) => matchesFilters(entry, filters)) || null;
          return { data: row, error: null };
        }
        return { data: null, error: null };
      }

      function runSingle() {
        if (table === "game_players" && mode === "update") {
          Object.assign(playerRow, payload || {});
          return { data: playerRow, error: null };
        }
        if (table === "game_cars" && mode === "update") {
          for (const car of gameCars) {
            if (matchesFilters(car, filters)) {
              Object.assign(car, payload || {});
              return { data: car, error: null };
            }
          }
          return { data: null, error: null };
        }
        if (table === "game_cars" && mode === "insert") {
          const insertedRow = {
            game_car_id: nextGameCarId++,
            account_car_id: null,
            image_index: 0,
            locked: 0,
            aero: 0,
            test_drive_invitation_id: null,
            test_drive_name: null,
            test_drive_money_price: null,
            test_drive_point_price: null,
            test_drive_expires_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...payload,
          };
          gameCars.push(insertedRow);
          return { data: insertedRow, error: null };
        }
        return { data: null, error: null };
      }

      function runMany() {
        if (mode === "update") {
          return runUpdate();
        }
        if (table === "game_cars") {
          return {
            data: getRows().filter((row) => matchesFilters(row, filters)),
            error: null,
          };
        }
        if (table === "game_owned_engines") {
          return { data: [], error: null };
        }
        return { data: [], error: null };
      }

      function runUpdate() {
        if (table === "game_players") {
          Object.assign(playerRow, payload || {});
          return { error: null };
        }
        if (table === "game_cars") {
          for (const car of gameCars) {
            if (matchesFilters(car, filters)) {
              Object.assign(car, payload || {});
            }
          }
          return { error: null };
        }
        return { error: null };
      }

      return query;
    },
  };
}

async function testLoginPayloadSeedsHiddenTournamentPlaceholderCar() {
  const body = buildLoginBody(
    {
      id: 77,
      username: "CpuTournamentTester",
      money: 1000,
      points: 50,
      score: 25,
      image_id: 0,
      active: true,
      vip: false,
      facebook_connected: false,
      sponsor_rating: 0,
      driver_text: "",
      team_name: "",
      respect_level: 0,
      title_id: 0,
      track_rank: 0,
      location_id: 100,
      background_id: 0,
      default_car_game_id: 210,
    },
    [createOwnedCar()],
    "",
    "cpu-login-placeholder",
    createLogger(),
  );

  assert.ok(
    body.includes("<n id='getallcars'><c i='210'"),
    'login payload should still include the player-owned garage car',
  );
  assert.ok(
    body.includes("<empty i=''/>"),
    'login payload should append a lane placeholder empty node',
  );
}

async function testBuyCarReturnsClientPurchaseBalances() {
  const playerId = 14;
  const sessionKey = `buycar-color-${Date.now()}`;
  const supabase = createBuyCarSupabaseStub({ playerId, sessionKey });
  const result = await handleGameAction({
    action: 'buycar',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['cid', '105'],
      ['c', '0033FF'],
      ['pt', 'm'],
      ['pr', '1000'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.ok(result, 'buycar should return a response');
  assert.strictEqual(result.source, 'supabase:buycar');
  assert.ok(result.body.includes(`"d1", "<r s='2' b='49000' ai='243'/>"`), 'buycar should return the updated money balance in the legacy balance wrapper');
  assert.ok(result.body.includes(`"d", "<r s='1' b='100'></r>"`), 'buycar should preserve the current points balance in the purchase response');
}

async function testBuyCarParsesFormattedPrices() {
  const playerId = 22;
  const sessionKey = `buycar-formatted-${Date.now()}`;
  const supabase = createBuyCarSupabaseStub({ playerId, sessionKey, startingMoney: 50000 });
   const result = await handleGameAction({
    action: 'buycar',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['cid', '105'],
      ['c', 'FF6600'],
      ['pt', 'm'],
      ['pr', '$35,000'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.ok(result, 'buycar with formatted price should return a response');
  assert.strictEqual(result.source, 'supabase:buycar');
  assert.ok(result.body.includes(`"d1", "<r s='2' b='15000' ai='243'/>"`), 'buycar should normalize formatted showroom prices before charging money');
}

async function testBuyCarSupportsPointPurchases() {
  const playerId = 33;
  const sessionKey = `buycar-points-${Date.now()}`;
  const supabase = createBuyCarSupabaseStub({ playerId, sessionKey, startingMoney: 50000, startingPoints: 90 });
  const result = await handleGameAction({
    action: 'buycar',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['cid', '105'],
      ['pt', 'p'],
      ['pr', '35'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger: createLogger(),
    supabase,
    services: {},
  });

  assert.ok(result, 'buycar points purchase should return a response');
  assert.strictEqual(result.source, 'supabase:buycar');
  assert.ok(result.body.includes(`"d1", "<r s='2' b='50000' ai='243'/>"`), 'buycar points purchase should leave money unchanged');
  assert.ok(result.body.includes(`"d", "<r s='1' b='55'></r>"`), 'buycar points purchase should deduct points and return the updated points balance');
}

async function testCtrtLegacyDialKeyPrefersPlayerSession() {
  const playerId = 79;
  const sessionKey = `cpu-ctrt-legacy-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({ playerId, sessionKey });
  const logger = createLogger();

  await handleGameAction({
    action: 'ctct',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', '16'],
      ['bt', '12.000'],
      ['acid', '909'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  const joinTournament = await handleGameAction({
    action: 'ctjt',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['ctid', '3'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });
  assert.strictEqual(joinTournament.body, `"s", 1`, 'ctjt should only acknowledge success for the client');

  const fetchOpponent = await handleGameAction({
    action: 'ctrt',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', '16'],
      ['caid', '0'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  assert.ok(fetchOpponent, 'ctrt should return a payload when player has an active tournament session');
  assert.ok(
    fetchOpponent.body.includes(`n='tourneyP `),
    'ctrt should resolve legacy dial keys through player-bound tournament session state',
  );
  assert.strictEqual(fetchOpponent.source, 'generated:ctrt');
}

async function testCtrtIncludesOpponentAliases() {
  const playerId = 80;
  const sessionKey = `cpu-ctrt-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({ playerId, sessionKey });
  const logger = createLogger();

  const saveQualify = {
    action: 'ctct',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', 'tourney-key-2'],
      ['bt', '13.456'],
      ['acid', '909'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  };
  await handleGameAction(saveQualify);

  const fetchOpponent = {
    action: 'ctrt',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['k', 'tourney-key-2'],
      ['caid', '2107'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  };
  const result = await handleGameAction(fetchOpponent);
  assert.ok(result, 'ctrt should return an opponent payload when session is valid');
  assert.ok(result.body.includes(`id='2107'`), 'ctrt should echo the requested bracket id alias');
  assert.ok(result.body.includes(`cid='2107'`), 'ctrt should expose the requested bracket id in the cid alias');
  assert.ok(result.body.includes(`caid='2107'`), 'ctrt should expose the opponent competitor car id');
  assert.ok(result.body.includes(`cacid='6107'`), 'ctrt should expose the opponent virtual race car id');
  assert.ok(result.body.includes(`n='tourneyA 08'`), 'ctrt should expose the opponent display name');
  assert.strictEqual(result.source, 'generated:ctrt');
}

async function testGetUserReturnsSyntheticTournamentCompetitor() {
  const playerId = 81;
  const sessionKey = `cpu-getuser-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({ playerId, sessionKey });
  const logger = createLogger();

  await handleGameAction({
    action: 'ctjt',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['ctid', '1'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  const result = await handleGameAction({
    action: 'getuser',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['tid', '2107'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  assert.ok(result, 'getuser should return a payload for synthetic tournament competitors');
  assert.ok(result.body.includes(`i='2107'`), 'getuser should preserve the requested tournament public id');
  assert.ok(result.body.includes(`u='tourneyA 08'`), 'getuser should expose the synthetic tournament username');
  assert.strictEqual(result.source, 'generated:getuser:computer-tournament');
}

async function testGetUsersTracksSyntheticSourcesExplicitly() {
  const playerId = 82;
  const teammateId = 83;
  const sessionKey = `cpu-getusers-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({
    playerId,
    sessionKey,
    extraPlayers: [
      { id: teammateId, username: 'RealPlayerTwo', score: 10 },
    ],
  });
  const logger = createLogger();

  await handleGameAction({
    action: 'ctjt',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['ctid', '1'],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  const mixedResult = await handleGameAction({
    action: 'getusers',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['aids', `${playerId},2107`],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  assert.ok(mixedResult.body.includes(`u='CpuTournamentTester'`), 'getusers should still include real players');
  assert.ok(mixedResult.body.includes(`u='tourneyA 08'`), 'getusers should include synthetic tournament players');
  assert.strictEqual(mixedResult.source, 'generated:getusers:computer-tournament');

  const realOnlyResult = await handleGameAction({
    action: 'getusers',
    params: new Map([
      ['aid', String(playerId)],
      ['sk', sessionKey],
      ['aids', `${playerId},${teammateId}`],
    ]),
    rawQuery: '',
    decodedQuery: '',
    logger,
    supabase,
    services: {},
  });

  assert.ok(realOnlyResult.body.includes(`u='CpuTournamentTester'`), 'getusers should include the caller in real-only queries');
  assert.ok(realOnlyResult.body.includes(`u='RealPlayerTwo'`), 'getusers should include additional real players');
  assert.strictEqual(realOnlyResult.source, 'supabase:getusers');
}

const tests = [
  ['ctgr variants', testCtgrVariants],
  ['ctjt bad session', testCtjtBadSession],
  ['ctct bad session', testCtctBadSession],
  ['ctrt bad session', testCtrtBadSession],
  ['ctst bad session', testCtstBadSession],
  ['cpu tournament key matches reference flow', testCpuTournamentKeyMatchesReferenceFlow],
  ['ctct returns engine timing for qualify car', testCtctReturnsEngineTimingForQualifyCar],
  ['ctct legacy dial key returns engine timing', testCtctLegacyDialKeyReturnsEngineTiming],
  ['login payload seeds hidden tournament placeholder car', testLoginPayloadSeedsHiddenTournamentPlaceholderCar],
  ['buycar returns client purchase balances', testBuyCarReturnsClientPurchaseBalances],
  ['buycar parses formatted prices', testBuyCarParsesFormattedPrices],
  ['buycar supports point purchases', testBuyCarSupportsPointPurchases],
  ['ctrt legacy dial key prefers player session', testCtrtLegacyDialKeyPrefersPlayerSession],
  ['ctrt opponent aliases', testCtrtIncludesOpponentAliases],
  ['getuser synthetic tournament competitor', testGetUserReturnsSyntheticTournamentCompetitor],
  ['getusers explicit synthetic source tracking', testGetUsersTracksSyntheticSourcesExplicitly],
];

let failed = false;
for (const [name, testFn] of tests) {
  try {
    await testFn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}`, error);
  }
}

if (failed) {
  process.exitCode = 1;
}
