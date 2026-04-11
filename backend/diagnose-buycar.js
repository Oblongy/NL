#!/usr/bin/env node
/**
 * Buycar Protocol Diagnostic Tool
 *
 * This script tests what parameter combinations work with the backend
 * and helps identify if Flash is sending the right parameters.
 *
 * Usage:
 *   node diagnose-buycar.js [--verbose]
 */

import { handleGameAction } from "./src/game-actions.js";
import { createGameSupabase } from "./src/supabase-client.js";
import { config } from "./src/config.js";

const logger = {
  info: (...args) => console.log("[INFO]", ...args),
  warn: (...args) => console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args),
};

const verbose = process.argv.includes("--verbose");

// Test data
const testCases = [
  {
    name: "✅ Standard: cid + pr",
    query: "action=buycar&sk=TEST&aid=1&cid=6&pr=15000",
    expect: "success",
  },
  {
    name: "✅ Alternate: acid instead of cid",
    query: "action=buycar&sk=TEST&aid=1&acid=6&pr=15000",
    expect: "success",
  },
  {
    name: "✅ Alternate: ci instead of cid",
    query: "action=buycar&sk=TEST&aid=1&ci=6&pr=15000",
    expect: "success",
  },
  {
    name: "✅ Alternate: carid instead of cid",
    query: "action=buycar&sk=TEST&aid=1&carid=6&pr=15000",
    expect: "success",
  },
  {
    name: "✅ Alternate: id instead of cid",
    query: "action=buycar&sk=TEST&aid=1&id=6&pr=15000",
    expect: "success",
  },
  {
    name: "✅ Without price (backend calculates)",
    query: "action=buycar&sk=TEST&aid=1&cid=6",
    expect: "success",
  },
  {
    name: "✅ Extra params: pt + c (Flash might send)",
    query: "action=buycar&sk=TEST&aid=1&cid=6&pt=0&c=C0C0C0&pr=15000",
    expect: "success",
  },
  {
    name: "❌ Missing session key",
    query: "action=buycar&aid=1&cid=6&pr=15000",
    expect: "missing-session",
  },
  {
    name: "❌ Missing car ID",
    query: "action=buycar&sk=TEST&aid=1&pr=15000",
    expect: "missing-car",
  },
  {
    name: "❌ Invalid car ID (0)",
    query: "action=buycar&sk=TEST&aid=1&cid=0&pr=15000",
    expect: "missing-car",
  },
  {
    name: "❌ Invalid car ID (999)",
    query: "action=buycar&sk=TEST&aid=1&cid=999&pr=15000",
    expect: "missing-car",
  },
  {
    name: "❌ Missing player ID",
    query: "action=buycar&sk=TEST&cid=6&pr=15000",
    expect: "bad-session",
  },
];

// Mock Supabase with test data
class MockSupabase {
  from(table) {
    return {
      select: () => ({
        eq: (col, val) => ({
          single: async () => {
            if (table === "game_players" && col === "id" && val === 1) {
              return {
                data: {
                  id: 1,
                  money: 1000000,
                  username: "TestPlayer",
                },
                error: null,
              };
            }
            return { data: null, error: new Error("Not found") };
          },
        }),
      }),
      insert: (payload) => ({
        single: async () => ({
          data: {
            game_car_id: 1,
            ...payload,
          },
          error: null,
        }),
      }),
      update: (payload) => ({
        eq: () => ({
          single: async () => ({
            data: payload,
            error: null,
          }),
        }),
      }),
    };
  }
}

// Mock session store
class MockSessionStore {
  find() {
    return null;
  }
}

async function testBackendSupport() {
  console.log("\n🔍 BUYCAR PROTOCOL DIAGNOSTIC\n");
  console.log("Testing what parameters the backend accepts...\n");

  const supabase = new MockSupabase();
  const fixtureStore = new MockSessionStore();

  // First, ensure session exists
  await supabase.from("game_sessions").insert({
    session_key: "TEST",
    player_id: 1,
  });

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    console.log(`Test: ${testCase.name}`);

    try {
      const params = new URLSearchParams(testCase.query);
      const result = await handleGameAction({
        action: "buycar",
        params,
        rawQuery: testCase.query,
        decodedQuery: testCase.query,
        fixtureStore,
        supabase: supabase,
        logger,
      });

      const isSuccess = result.body.includes('"s", 1');
      const source = result.source || "unknown";

      if (verbose) {
        console.log(`  Source: ${source}`);
        console.log(`  Response: ${result.body.substring(0, 100)}...`);
      }

      if (testCase.expect === "success") {
        if (isSuccess) {
          console.log(`  ✅ PASS\n`);
          passed++;
        } else {
          console.log(`  ❌ FAIL - Expected success but got failure`);
          console.log(`     Source: ${source}\n`);
          failed++;
        }
      } else {
        if (!isSuccess && source.includes(testCase.expect)) {
          console.log(`  ✅ PASS (correctly rejected)\n`);
          passed++;
        } else {
          console.log(`  ❌ FAIL - Expected rejection but got different result`);
          console.log(`     Expected: ${testCase.expect}`);
          console.log(`     Got source: ${source}\n`);
          failed++;
        }
      }
    } catch (err) {
      console.log(`  ❌ ERROR: ${err.message}\n`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  if (failed === 0) {
    console.log("✅ Backend accepts all standard parameter variations!");
    console.log("\nIf Flash is still not working, the issue is likely:");
    console.log("  1. Flash is sending to the wrong server URL");
    console.log("  2. Flash's session key is invalid");
    console.log("  3. Flash's response parsing is broken");
    console.log("  4. Flash is not sending requests at all\n");
  } else {
    console.log("⚠️  Some tests failed. Check the backend implementation.\n");
  }
}

console.log("Initializing test environment...");

try {
  await testBackendSupport();
} catch (err) {
  console.error("Fatal error:", err.message);
  if (verbose) {
    console.error(err.stack);
  }
  process.exit(1);
}
