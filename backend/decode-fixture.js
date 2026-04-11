import { decodePayload } from "./src/nitto-cipher.js";
import fs from "node:fs";

const data = JSON.parse(fs.readFileSync("fixtures/20260402_221744.decoded_http_responses.json", "utf8"));
const entries = Object.values(data);

// Find all getonecarengine entries
const engineEntries = entries.filter(e => e.action_name === "getonecarengine");

for (const entry of engineEntries) {
  console.log("Query:", entry.decoded_query);
  try {
    const seed = Number(entry.response_seed);
    const decoded = decodePayload(entry.response_body_ascii, seed);
    console.log("Decoded:", decoded);
  } catch (err) {
    console.log("Error:", err.message);
  }
  console.log("---");
}
