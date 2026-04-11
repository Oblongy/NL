import { decodePayload } from "./src/nitto-cipher.js";
import fs from "node:fs";

// Decode all fixtures and look for race-related TCP messages
const data1 = JSON.parse(fs.readFileSync("fixtures/20260402_221744.decoded_http_responses.json", "utf8"));
const data2 = JSON.parse(fs.readFileSync("fixtures/20260402_223530.decoded_http_responses.json", "utf8"));

for (const [name, data] of [["fixture1", data1], ["fixture2", data2]]) {
  const entries = Object.values(data);
  for (const entry of entries) {
    const q = entry.decoded_query || "";
    if (q.includes("practice") || q.includes("getgearinfo") || q.includes("getracerscars") || q.includes("gettworacers")) {
      console.log(`\n[${name}] ${q}`);
      if (entry.decoded_response_body) {
        console.log("Response:", entry.decoded_response_body.substring(0, 300));
      } else if (entry.response_body_ascii && entry.response_seed) {
        try {
          const decoded = decodePayload(entry.response_body_ascii, Number(entry.response_seed));
          console.log("Decoded:", decoded.decoded?.substring(0, 300));
        } catch (e) {
          console.log("Error:", e.message);
        }
      }
    }
  }
}
