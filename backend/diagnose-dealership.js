import { readFileSync, existsSync } from "node:fs";

console.log("=== Dealership Diagnostic Tool ===\n");

// Check if live.log exists
if (!existsSync("./backend/live.log")) {
  console.log("❌ No live.log file found");
  console.log("   The server may not be running or logging is disabled");
  console.log("\nTo enable logging, ensure your server is started with logging enabled.");
  process.exit(1);
}

// Read the log file
const logContent = readFileSync("./backend/live.log", "utf8");
const lines = logContent.split("\n").filter(Boolean);

console.log(`📊 Total log entries: ${lines.length}\n`);

// Look for dealership-related actions
const dealershipActions = [
  "viewshowroom",
  "getstartershowroom",
  "buycar",
  "buyshowroomcar",
  "buystartercar",
  "buydealercar",
  "buytestdrivecar",
  "checktestdrive",
  "getcarcategories",
];

console.log("🔍 Searching for dealership actions...\n");

const foundActions = new Map();
const errors = [];
const warnings = [];

for (const line of lines) {
  // Check for dealership actions
  for (const action of dealershipActions) {
    if (line.toLowerCase().includes(`action=${action}`) || 
        line.toLowerCase().includes(`"action":"${action}"`)) {
      if (!foundActions.has(action)) {
        foundActions.set(action, []);
      }
      foundActions.get(action).push(line);
    }
  }
  
  // Collect errors and warnings
  if (line.includes("[ERROR]") && dealershipActions.some(a => line.toLowerCase().includes(a))) {
    errors.push(line);
  }
  if (line.includes("[WARN]") && dealershipActions.some(a => line.toLowerCase().includes(a))) {
    warnings.push(line);
  }
}

// Report findings
if (foundActions.size === 0) {
  console.log("❌ NO DEALERSHIP ACTIONS FOUND IN LOGS");
  console.log("\nThis means:");
  console.log("  1. The Flash client is not sending dealership requests to the server");
  console.log("  2. The client might be using a different server URL");
  console.log("  3. The dealership UI in 3.swf might not be triggering network calls");
  console.log("\n📝 Next steps:");
  console.log("  - Decompile 3.swf and check the ActionScript for:");
  console.log("    • URLLoader or URLRequest calls in sectionDealer");
  console.log("    • The exact action parameter being sent");
  console.log("    • Any hardcoded server URLs");
  console.log("  - Check if the Flash client is showing any error messages");
  console.log("  - Verify the client is connected to your server (check login logs)");
} else {
  console.log(`✅ Found ${foundActions.size} dealership action types:\n`);
  
  for (const [action, entries] of foundActions) {
    console.log(`📌 ${action}: ${entries.length} requests`);
    console.log(`   Last request: ${entries[entries.length - 1].substring(0, 150)}...`);
    console.log();
  }
}

if (errors.length > 0) {
  console.log(`\n⚠️  Found ${errors.length} errors:\n`);
  errors.slice(-5).forEach(err => console.log(`   ${err}`));
}

if (warnings.length > 0) {
  console.log(`\n⚠️  Found ${warnings.length} warnings:\n`);
  warnings.slice(-5).forEach(warn => console.log(`   ${warn}`));
}

// Check for successful purchases
const successfulPurchases = lines.filter(line => 
  line.includes("buycar") && line.includes('"s", 1')
);

if (successfulPurchases.length > 0) {
  console.log(`\n✅ Found ${successfulPurchases.length} successful car purchases`);
} else {
  console.log("\n❌ No successful car purchases found in logs");
}

// Show parameter patterns
console.log("\n📋 Parameter patterns found:");
const paramPatterns = new Set();
for (const [action, entries] of foundActions) {
  for (const entry of entries) {
    const match = entry.match(/action=[^&\s]+(&[^&\s]+)*/);
    if (match) {
      paramPatterns.add(match[0]);
    }
  }
}

if (paramPatterns.size > 0) {
  Array.from(paramPatterns).slice(0, 10).forEach(pattern => {
    console.log(`   ${pattern}`);
  });
} else {
  console.log("   (No parameter patterns detected)");
}

console.log("\n=== Diagnostic Complete ===");
