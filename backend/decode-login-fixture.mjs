import { decodePayload } from './src/nitto-cipher.js';
import { readFileSync } from 'fs';

for (const file of ['fixtures/20260402_221744.decoded_http_responses.json', 'fixtures/20260402_223530.decoded_http_responses.json']) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const keys = Object.keys(data).sort((a,b)=>Number(a)-Number(b));
  
  // Decode login response
  const loginKey = keys.find(k => (data[k].decoded_query||'').includes('action=login'));
  if (loginKey) {
    const e = data[loginKey];
    const ascii = e.response_body_ascii || '';
    if (ascii) {
      try {
        const r = decodePayload(ascii);
        console.log(`\n=== LOGIN RESPONSE (${file}) ===`);
        console.log(r.decoded.substring(0, 3000));
      } catch(err) { console.log('decode err:', err.message); }
    }
  }

  // Search all responses for IP/host/port/socket references
  for (const k of keys) {
    const e = data[k];
    const ascii = e.response_body_ascii || '';
    if (!ascii) continue;
    try {
      const r = decodePayload(ascii);
      const d = r.decoded;
      if (d.includes('3724') || d.includes('socket') || d.includes('serverip') || 
          d.includes('tcpip') || d.includes('server_ip') || d.match(/\d+\.\d+\.\d+\.\d+/)) {
        console.log(`\n=== FOUND IP/PORT in key=${k} (${(data[k].decoded_query||'').substring(0,60)}) ===`);
        console.log(d.substring(0, 500));
      }
    } catch {}
  }
}
