#!/usr/bin/env node
/**
 * Buycar Request Analyzer
 *
 * Analyzes a buycar request to show:
 * 1. What parameters are present/missing
 * 2. What the backend would do with them
 * 3. What might go wrong
 *
 * Usage:
 *   node analyze-request.js "action=buycar&sk=TEST&aid=1&cid=6&pr=15000"
 *   node analyze-request.js --from-log live.log
 */

import fs from "node:fs";

function analyzeRequest(query) {
  console.log("\n📋 BUYCAR REQUEST ANALYSIS\n");
  console.log("Raw Query:");
  console.log(`  ${query}\n`);

  const params = new URLSearchParams(query);
  const found = {};
  const missing = [];
  const extra = [];

  // Expected required parameters
  const required = ["action", "sk", "aid", "cid"];
  const optional = ["pr", "price", "cp", "c", "pt", "acid", "ci", "carid", "id"];
  const all = [...required, ...optional];

  // Collect found parameters
  for (const [key, value] of params) {
    found[key] = value;
  }

  // Check for missing required
  for (const param of required) {
    if (!found[param]) {
      missing.push(param);
    }
  }

  // Check for unexpected parameters
  for (const key of Object.keys(found)) {
    if (!all.includes(key)) {
      extra.push(key);
    }
  }

  // Display what was found
  console.log("📊 PARAMETERS:\n");

  if (Object.keys(found).length === 0) {
    console.log("  ⚠️  No parameters found!\n");
  } else {
    console.log("  Found:");
    for (const [key, value] of Object.entries(found)) {
      const isRequired = required.includes(key);
      const isOptional = optional.includes(key);
      const status = isRequired ? "✅ REQUIRED" : isOptional ? "ℹ️  OPTIONAL" : "⚠️  UNEXPECTED";
      console.log(`    ${key}: "${value}" (${status})`);
    }
    console.log();
  }

  // Diagnose car ID parameter
  console.log("🚗 CAR ID DETECTION:\n");
  const carIdVariants = ["cid", "acid", "ci", "carid", "id"];
  const foundCarIdVariant = carIdVariants.find((v) => found[v] !== undefined);

  if (foundCarIdVariant) {
    const carId = Number(found[foundCarIdVariant]);
    console.log(`  ✅ Found: ${foundCarIdVariant} = ${found[foundCarIdVariant]}`);
    if (isNaN(carId)) {
      console.log(`  ❌ ERROR: Not a valid number!`);
    } else if (carId === 0) {
      console.log(`  ⚠️  WARNING: Car ID is 0 (invalid catalog ID)`);
    } else if (carId > 0 && carId <= 142) {
      console.log(`  ✅ Valid: Car ID ${carId} is in valid range (1-142)`);
    } else {
      console.log(`  ❌ ERROR: Car ID ${carId} is outside valid range (1-142)`);
    }
  } else {
    console.log(`  ❌ MISSING: No car ID parameter found!`);
    console.log(`     Backend expects one of: cid, acid, ci, carid, id`);
  }
  console.log();

  // Diagnose session
  console.log("🔐 SESSION:\n");
  if (found.sk) {
    console.log(`  ✅ Session key: "${found.sk}"`);
    if (found.sk.length < 5) {
      console.log(`  ⚠️  WARNING: Very short session key (unusual)`);
    }
  } else {
    console.log(`  ❌ MISSING: No session key (sk parameter)`);
  }
  console.log();

  // Diagnose player
  console.log("👤 PLAYER:\n");
  if (found.aid) {
    const playerId = Number(found.aid);
    if (isNaN(playerId)) {
      console.log(`  ❌ ERROR: aid="${found.aid}" is not a number`);
    } else if (playerId > 0) {
      console.log(`  ✅ Player ID: ${playerId}`);
    } else {
      console.log(`  ❌ ERROR: Player ID ${playerId} is not positive`);
    }
  } else {
    console.log(`  ❌ MISSING: No player ID (aid parameter)`);
  }
  console.log();

  // Diagnose price
  console.log("💰 PRICE:\n");
  const priceVariants = ["pr", "price", "cp"];
  const foundPriceVariant = priceVariants.find((v) => found[v] !== undefined);

  if (foundPriceVariant) {
    const price = Number(found[foundPriceVariant]);
    console.log(`  ✅ Found: ${foundPriceVariant} = ${found[foundPriceVariant]}`);
    if (isNaN(price)) {
      console.log(`  ❌ ERROR: Not a valid number!`);
    } else if (price > 0) {
      console.log(`  ℹ️  Backend will use this price: $${price.toLocaleString()}`);
    } else {
      console.log(`  ⚠️  Price is 0 or negative - backend will look up from catalog`);
    }
  } else {
    console.log(`  ℹ️  No price provided`);
    console.log(`     Backend will look it up from catalog (if car ID is valid)`);
  }
  console.log();

  // Summary
  console.log("🎯 BACKEND VERDICT:\n");

  if (missing.length > 0) {
    console.log(`  ❌ WILL FAIL: Missing required parameters: ${missing.join(", ")}`);
    console.log(`     Expected errors:`);
    if (missing.includes("sk")) {
      console.log(`       - supabase:buycar:missing-session`);
    }
    if (missing.includes("cid") && !found.acid && !found.ci && !found.carid && !found.id) {
      console.log(`       - supabase:buycar:missing-car`);
    }
  } else if (extra.length > 0) {
    console.log(`  ⚠️  Has unexpected params (ignored): ${extra.join(", ")}`);
    console.log(`     Backend will ignore these, should still work`);
  } else {
    console.log(`  ✅ REQUEST LOOKS VALID`);
    console.log(`     Backend should process this request`);
  }

  console.log();
}

function analyzeFromLog(logPath) {
  console.log(`\n📂 ANALYZING LOG: ${logPath}\n`);

  if (!fs.existsSync(logPath)) {
    console.error(`❌ Log file not found: ${logPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.split("\n");
  const buycarLines = lines.filter((line) => line.includes("action=buycar"));

  if (buycarLines.length === 0) {
    console.log("❌ No buycar requests found in log\n");
    console.log("Make sure you ran your Flash client and attempted a purchase.");
    process.exit(1);
  }

  console.log(`Found ${buycarLines.length} buycar request(s):\n`);

  for (let i = 0; i < buycarLines.length; i++) {
    const line = buycarLines[i];
    console.log(`\n--- Request ${i + 1} ---`);

    // Extract query string
    const match = line.match(/action=[^&\s]+(&[^&\s]+)*/);
    if (match) {
      analyzeRequest(match[0]);
    } else {
      console.log(`Could not extract parameters from line:\n${line}`);
    }
  }
}

// Main
const arg1 = process.argv[2];
const arg2 = process.argv[3];

if (!arg1) {
  console.log(`
Usage:
  node analyze-request.js "QUERY_STRING"
  node analyze-request.js --from-log LOG_FILE

Examples:
  node analyze-request.js "action=buycar&sk=TEST&aid=1&cid=6&pr=15000"
  node analyze-request.js --from-log live.log
  node analyze-request.js --from-log backend/live.log
`);
  process.exit(1);
}

if (arg1 === "--from-log") {
  analyzeFromLog(arg2 || "live.log");
} else {
  analyzeRequest(arg1);
}

console.log("=".repeat(60) + "\n");
