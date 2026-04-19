/**
 * capture_practice.mjs
 *
 * Reads a tshark HTTP capture CSV (or stdin) and decodes Nitto cipher responses
 * looking for practice / getonecarengine calls.
 *
 * Usage:
 *   node capture_practice.mjs <capture.csv>
 *   tshark ... | node capture_practice.mjs
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { decodePayload } from "../src/nitto-cipher.js";

const filePath = process.argv[2];
const stream = filePath ? createReadStream(filePath) : process.stdin;
const rl = createInterface({ input: stream });

let lineNum = 0;
const hits = [];

rl.on("line", (line) => {
  lineNum++;
  // Skip header
  if (lineNum === 1 && line.toLowerCase().includes("time")) return;

  // Try to decode any field that looks like a Nitto cipher payload
  const fields = line.split("\t");
  for (const field of fields) {
    const trimmed = field.trim();
    if (trimmed.length < 10) continue;

    try {
      const { decoded } = decodePayload(trimmed);

      // Look for practice/getonecarengine responses
      if (decoded.includes("practice") || decoded.includes("getonecarengine") ||
          decoded.includes("<n2") || decoded.includes('"s", 1')) {
        hits.push({ line: lineNum, raw: trimmed.slice(0, 40), decoded });
        console.log(`\n=== Line ${lineNum} ===`);
        console.log("Decoded:", decoded.slice(0, 500));
      }
    } catch {
      // Not a valid cipher payload — skip
    }
  }
});

rl.on("close", () => {
  console.log(`\nScanned ${lineNum} lines, found ${hits.length} hits.`);
  if (hits.length === 0) {
    console.log("No practice/n2 responses found. Make sure you captured HTTP traffic to 165.227.250.123.");
  }
});
