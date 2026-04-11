const ALPHABET =
  " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\t!@#$%^&*()`'-=[];,./?_+{}|:<>~";
const SENTINEL = ALPHABET[ALPHABET.length - 1];
const SENTINEL_INDEX = ALPHABET.length - 1;
const STATIC_KEY = "516284";
const FACTOR1 = 986;
const FACTOR2 = 38;
const INDEX = new Map([...ALPHABET].map((char, index) => [char, index]));

function buildDynamicKey(seedNumber) {
  return `${seedNumber * FACTOR1}${seedNumber * FACTOR2}${seedNumber ** 2}${STATIC_KEY}`;
}

function wheelCrypt(plaintext, key) {
  const keyIndexes = [...key].map((char) => INDEX.get(char) ?? 0);
  const out = [];
  let keyPos = 0;

  for (const char of plaintext) {
    const pos = INDEX.get(char);

    if (pos === undefined) {
      if (char === "\n" || char === "\r") {
        out.push(SENTINEL, SENTINEL);
        if (char === "\n") {
          keyPos = (keyPos + 1) % keyIndexes.length;
        }
        continue;
      }

      if (char === "\"") {
        out.push(SENTINEL, "'");
        keyPos = (keyPos + 1) % keyIndexes.length;
        continue;
      }

      out.push(char);
      keyPos = (keyPos + 1) % keyIndexes.length;
      continue;
    }

    const cipherValue = pos ^ keyIndexes[keyPos];
    if (cipherValue < ALPHABET.length) {
      out.push(ALPHABET[cipherValue]);
    } else {
      out.push(SENTINEL, ALPHABET[cipherValue - SENTINEL_INDEX]);
    }

    keyPos = (keyPos + 1) % keyIndexes.length;
  }

  return out.join("");
}

function wheelDecrypt(ciphertext, key) {
  const keyIndexes = [...key].map((char) => INDEX.get(char));
  const out = [];
  let keyPos = 0;
  let escape = false;

  for (const char of ciphertext) {
    const pos = INDEX.get(char);

    if (pos === undefined) {
      out.push(char);
      keyPos = (keyPos + 1) % keyIndexes.length;
      continue;
    }

    let value = pos;

    if (!escape) {
      if (pos === SENTINEL_INDEX) {
        escape = true;
        continue;
      }
    } else {
      escape = false;
      if (pos === SENTINEL_INDEX) {
        out.push("\n");
        keyPos = (keyPos + 1) % keyIndexes.length;
        continue;
      }
      if (char === "'") {
        out.push("\"");
        keyPos = (keyPos + 1) % keyIndexes.length;
        continue;
      }
      value = pos + SENTINEL_INDEX;
    }

    const plainIndex = keyIndexes[keyPos] ^ value;
    out.push(ALPHABET[plainIndex] || "");
    keyPos = (keyPos + 1) % keyIndexes.length;
  }

  return out.join("");
}

export function encryptPayload(plaintext, seedNumber) {
  const dynamicKey = buildDynamicKey(seedNumber);
  const encryptedBody = wheelCrypt(plaintext, dynamicKey);
  const encryptedSeed = wheelCrypt(String(seedNumber), STATIC_KEY);
  return encryptedBody + encryptedSeed;
}

export function decodePayload(payload) {
  if (!payload || payload.length < 2) {
    throw new Error("Payload is too short to contain a seed suffix");
  }

  const body = payload.slice(0, -2);
  const encryptedSeed = payload.slice(-2);
  const seedText = wheelDecrypt(encryptedSeed, STATIC_KEY);

  if (!/^\d+$/.test(seedText)) {
    throw new Error(`Seed suffix did not decode to digits: ${seedText}`);
  }

  const seed = Number(seedText);
  const decoded = wheelDecrypt(body, buildDynamicKey(seed));
  return { seed, encryptedSeed, body, decoded };
}

export function decodeGameCodeQuery(rawQuery) {
  const payloadPart = rawQuery.split("&", 1)[0];
  const encodedPayload = payloadPart.includes("=")
    ? payloadPart.split("=", 2)[1]
    : payloadPart;
  const payload = decodeURIComponent(encodedPayload);
  const decodedPayload = decodePayload(payload);
  const params = new URLSearchParams(decodedPayload.decoded);
  return {
    ...decodedPayload,
    action: params.get("action"),
    params,
  };
}
