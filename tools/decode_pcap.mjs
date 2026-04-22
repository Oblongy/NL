/**
 * Decodes all HTTP response bodies from a tshark hex dump file.
 * Run: node backend/tools/decode_pcap.mjs <hex_dump_file>
 *
 * Generate hex dump with:
 *   tshark -r capture.pcapng -Y "http.response" -T fields -e frame.number -e http.file_data > hex_dump.txt
 */
import { readFileSync } from 'fs';
import { decodePayload } from '../src/nitto-cipher.js';

const file = process.argv[2];
if (!file) { console.error('Usage: node decode_pcap.mjs <hex_dump_file>'); process.exit(1); }

const lines = readFileSync(file, 'latin1').split('\n');

for (const line of lines) {
  const parts = line.trim().split('\t');
  if (parts.length < 2) continue;
  const frameNum = parts[0];
  const hex = parts[1].replace(/\s/g, '');
  if (hex.length < 20) continue;

  // Hex → latin1 string
  let raw = '';
  for (let i = 0; i < hex.length; i += 2) {
    raw += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }

  try {
    const { decoded } = decodePayload(raw);
    if (decoded.includes('<n2') || decoded.includes('"s", 1')) {
      console.log(`\n=== Frame ${frameNum} (${raw.length} bytes) ===`);
      console.log(decoded);
    }
  } catch {
    // Not cipher encoded — check if plain useful response
    if (raw.includes('"s", 1') || raw.includes('<n2')) {
      console.log(`\n=== Frame ${frameNum} PLAIN (${raw.length} bytes) ===`);
      console.log(raw.slice(0, 500));
    }
  }
}
