import { decodePayload } from "./src/nitto-cipher.js";
import fs from "node:fs";

// Look for TCP-related data in fixtures
const data1 = JSON.parse(fs.readFileSync("fixtures/20260402_221744.decoded_http_responses.json", "utf8"));
const entries = Object.values(data1);

// Find entries that might have TCP message data
for (const entry of entries) {
  const q = entry.decoded_query || "";
  if (q.includes("SRC") || q.includes("RRA") || q.includes("sockConn") || q.includes("race")) {
    console.log("Found:", q.substring(0, 100));
  }
}

// Also check if there's a TCP log file
try {
  const tcpLog = fs.readFileSync("tmp_tcp_test.out.log", "utf8");
  console.log("\nTCP log:", tcpLog.substring(0, 2000));
} catch (e) {
  console.log("No TCP log file");
}
