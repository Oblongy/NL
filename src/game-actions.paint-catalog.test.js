import assert from "node:assert/strict";
import test from "node:test";

import { handleGameAction } from "./game-actions.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test("getpaintcats matches the legacy category shape for full-car and panel paint", async () => {
  const result = await handleGameAction({
    action: "getpaintcats",
    params: new Map([["lid", "500"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result?.source, "generated:getpaintcats:location=500");
  assert.match(result.body, /<c i='-2' l='500' p='5000' pp='50'\/>/);
  assert.match(result.body, /<c i='-1' l='500' p='5000' pp='50'\/>/);
});

test("getpaints emits location-tiered paint swatches in the legacy xml shape", async () => {
  const topTier = await handleGameAction({
    action: "getpaints",
    params: new Map([["lid", "500"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(topTier?.source, "generated:getpaints:location=500");
  assert.match(topTier.body, /<p i='1' ci='-2' n='Red' c='FF0000' p='5000' l='500'\/>/);
  assert.match(topTier.body, /<p i='17' ci='-2' n='Matte Black' c='1A1A1A' p='5000' l='500'\/>/);
  assert.doesNotMatch(topTier.body, /\bpi='/);
  assert.doesNotMatch(topTier.body, /\bcd='/);
  assert.doesNotMatch(topTier.body, /\bpp='/);

  const entryLevel = await handleGameAction({
    action: "getpaints",
    params: new Map([["lid", "100"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(entryLevel?.source, "generated:getpaints:location=100");
  assert.match(entryLevel.body, /<p i='1' ci='-2' n='Red' c='FF0000' p='500' l='100'\/>/);
  assert.doesNotMatch(entryLevel.body, /Matte Black/);
  assert.doesNotMatch(entryLevel.body, /Chrome/);
});
