import assert from 'assert';
import { handleGameAction } from "../src/game-actions.js";
import { failureBody } from "../src/game-xml.js";

function createLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

function createTournamentSupabaseStub({ playerId = 77, sessionKey = "cpu-tournament-session" } = {}) {
  const sessionRow = {
    session_key: sessionKey,
    player_id: playerId,
    last_seen_at: new Date().toISOString(),
  };
  const playerRow = {
    id: playerId,
    username: "CpuTournamentTester",
  };

  return {
    from(table) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        gte() {
          return query;
        },
        maybeSingle: async () => {
          if (table === "game_sessions") {
            return { data: sessionRow, error: null };
          }
          if (table === "game_players") {
            return { data: playerRow, error: null };
          }
          return { data: null, error: null };
        },
        update() {
          return {
            eq: async () => ({ error: null }),
          };
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

async function testCtctSeedsNeutralQualifyPayload() {
  const sessionKey = `cpu-ctct-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({ sessionKey });
  const context = {
    action: 'ctct',
    params: new Map([
      ['aid', '77'],
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
  assert.ok(result, 'ctct should return a seeded payload when session is valid');
  assert.ok(
    result.body.includes(`<q><r i='77' icid='909' ci='77' cicid='909' bt='13.456' b='0'/></q>`),
    'ctct should seed a self-paired RN-style queue payload for qualify',
  );
  assert.strictEqual(result.source, 'generated:ctct');
}

async function testCtrtIncludesOpponentAliases() {
  const sessionKey = `cpu-ctrt-${Date.now()}`;
  const supabase = createTournamentSupabaseStub({ sessionKey });
  const logger = createLogger();

  const saveQualify = {
    action: 'ctct',
    params: new Map([
      ['aid', '77'],
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
      ['aid', '77'],
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
  assert.ok(result.body.includes(`id='1007'`), 'ctrt should expose the opponent id alias');
  assert.ok(result.body.includes(`caid='2007'`), 'ctrt should expose the opponent competitor car id');
  assert.ok(result.body.includes(`cacid='6107'`), 'ctrt should expose the opponent virtual race car id');
  assert.ok(result.body.includes(`n='tourneyA 08'`), 'ctrt should expose the opponent display name');
  assert.strictEqual(result.source, 'generated:ctrt');
}

const tests = [
  ['ctgr variants', testCtgrVariants],
  ['ctjt bad session', testCtjtBadSession],
  ['ctct bad session', testCtctBadSession],
  ['ctrt bad session', testCtrtBadSession],
  ['ctst bad session', testCtstBadSession],
  ['ctct qualify seed', testCtctSeedsNeutralQualifyPayload],
  ['ctrt opponent aliases', testCtrtIncludesOpponentAliases],
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
