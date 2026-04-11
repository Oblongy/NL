import { readFileSync } from "node:fs";

// Read the last 100 lines of the log file
const logContent = readFileSync("./backend/live.log", "utf8");
const lines = logContent.split("\n").filter(Boolean).slice(-100);

console.log("=== Last 100 Log Entries ===\n");

// Filter for relevant actions
const relevantActions = [
  "login",
  "viewshowroom",
  "getstartershowroom",
  "buycar",
  "buyshowroomcar",
  "getcarcategories",
  "getallcars",
];

let foundRelevant = false;

for (const line of lines) {
  // Check if line contains any relevant action
  const hasRelevantAction = relevantActions.some((action) =>
    line.toLowerCase().includes(action.toLowerCase())
  );

  if (hasRelevantAction || line.includes("[error]") || line.includes("[warn]")) {
    console.log(line);
    foundRelevant = true;
  }
}

if (!foundRelevant) {
  console.log("No relevant showroom/car purchase activity found in recent logs.");
  console.log("\nShowing last 10 lines instead:\n");
  lines.slice(-10).forEach((line) => console.log(line));
}

console.log("\n=== Analysis ===");
console.log("If you don't see 'viewshowroom' or 'buycar' actions above,");
console.log("it means the client isn't sending requests to the server.");
console.log("\nPossible causes:");
console.log("1. Client is not connected to the server");
console.log("2. Client is using a different server URL");
console.log("3. Server is not running");
console.log("\nTo verify server is running:");
console.log("  curl http://localhost/gameCode1_00.aspx?action=getcode");
console.log("  (Should return a UUID)");
