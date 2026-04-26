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

test("viewshowroom keeps the applied preview paint inside paint-state xml only", async () => {
  const result = await handleGameAction({
    action: "viewshowroom",
    params: new Map([["lid", "200"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result.source, "generated:viewshowroom:lid=200");

  const carBodies = [...result.body.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map((match) => match[1]);
  assert.ok(carBodies.length > 0, "showroom should include at least one car");

  for (const carBody of carBodies) {
    assert.match(
      carBody,
      /<ps><p i='\d+' cd='[0-9A-F]+'\/><\/ps>/,
      "showroom car should include one applied preview paint state",
    );

    const bodyWithoutPaintState = carBody.replace(/<ps><p i='\d+' cd='[0-9A-F]+'\/><\/ps>/g, "");
    assert.doesNotMatch(
      bodyWithoutPaintState,
      /<p i='\d+' cd='[0-9A-F]+'\/>/,
      "showroom car should not serialize extra swatches as installed-part nodes",
    );
  }
});

test("viewshowroom only returns cars for the requested showroom tier", async () => {
  const result = await handleGameAction({
    action: "viewshowroom",
    params: new Map([["lid", "100"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result.source, "generated:viewshowroom:lid=100");

  const locationIds = [...result.body.matchAll(/<c\b[^>]*\bl='(\d+)'/g)].map((match) => Number(match[1]));
  assert.ok(locationIds.length > 0, "showroom should include at least one car");
  assert.ok(locationIds.every((locationId) => locationId === 100), "Toreno showroom should only include Toreno-tier cars");
});

test("viewshowroom accepts showroom category ids when selecting a dealer tier", async () => {
  const result = await handleGameAction({
    action: "viewshowroom",
    params: new Map([["cid", "1002"]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result.source, "generated:viewshowroom:lid=200");

  const locationIds = [...result.body.matchAll(/<c\b[^>]*\bl='(\d+)'/g)].map((match) => Number(match[1]));
  assert.ok(locationIds.length > 0, "showroom should include at least one car");
  assert.ok(locationIds.every((locationId) => locationId === 200), "Newburge category should only include Newburge-tier cars");
});

test("getcarcategories preserves the legacy category flags expected by the client", async () => {
  const result = await handleGameAction({
    action: "getcarcategories",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result.source, "stub:getcarcategories");
  assert.match(result.body, /<c i='1001' pi='0' c='0' p='0' n='Toreno Showroom' cl='55AACC' l='100'\/>/);
  assert.match(result.body, /<c i='1005' pi='0' c='0' p='0' n='Diamond Point Showroom' cl='CC55CC' l='500'\/>/);
});
