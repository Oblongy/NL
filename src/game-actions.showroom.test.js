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

function parseAttrs(node) {
  return Object.fromEntries(
    [...node.matchAll(/([a-z]+)='([^']*)'/gi)].map(([, key, value]) => [key, value]),
  );
}

function getCategoryNodes(xml) {
  return [...xml.matchAll(/<c\b[^>]*\/>/g)].map((match) => parseAttrs(match[0]));
}

function getCategoryNodeByName(nodes, name, parentId = null) {
  return nodes.find((node) => (
    node.n === name &&
    (parentId === null || node.pi === String(parentId))
  ));
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

test("getcarcategories restores the dealership category tree expected by the client", async () => {
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

  const nodes = getCategoryNodes(result.body);
  const oeCars = getCategoryNodeByName(nodes, "OE Cars", "0");
  const premiumCars = getCategoryNodeByName(nodes, "Premium Cars", "0");
  const trophyCars = getCategoryNodeByName(nodes, "Trophy Cars", "0");

  assert.ok(oeCars, "dealership should expose the OE Cars root category");
  assert.ok(premiumCars, "dealership should expose the Premium Cars root category");
  assert.ok(trophyCars, "dealership should expose the Trophy Cars root category");
  assert.equal(oeCars.c, "1", "OE Cars should behave as a parent category");
  assert.equal(premiumCars.c, "1", "Premium Cars should behave as a parent category");
  assert.equal(trophyCars.c, "1", "Trophy Cars should behave as a parent category");

  const fordMake = getCategoryNodeByName(nodes, "Ford", oeCars.i);
  assert.ok(fordMake, "OE Cars should expose Ford as a make");
  assert.equal(fordMake.c, "0", "make nodes should open the model list, not another category tier");
});

test("viewshowroom accepts dealership category and make node ids", async () => {
  const categories = await handleGameAction({
    action: "getcarcategories",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  const nodes = getCategoryNodes(categories.body);
  const oeCars = getCategoryNodeByName(nodes, "OE Cars", "0");
  const fordMake = getCategoryNodeByName(nodes, "Ford", oeCars.i);

  const rootResult = await handleGameAction({
    action: "viewshowroom",
    params: new Map([["cid", oeCars.i]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  const rootNames = [...rootResult.body.matchAll(/<c\b[^>]*\bn='([^']+)'/g)].map((match) => match[1]);
  assert.ok(rootNames.length > 0, "showroom root selection should return at least one car");
  assert.ok(rootNames.includes("Ford GT"), "OE Cars should include the Ford GT stock model");

  const makeResult = await handleGameAction({
    action: "viewshowroom",
    params: new Map([["cid", fordMake.i]]),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  const makeNames = [...makeResult.body.matchAll(/<c\b[^>]*\bn='([^']+)'/g)].map((match) => match[1]);
  assert.ok(makeNames.length > 0, "showroom make selection should return at least one car");
  assert.ok(makeNames.includes("Ford GT"), "Ford make selection should include the Ford GT");
  assert.ok(!makeNames.includes("Honda S2000"), "Ford make selection should not leak unrelated makes");
});

test("viewshowroom without a selected dealership node still returns the mixed catalog", async () => {
  const result = await handleGameAction({
    action: "viewshowroom",
    params: new Map(),
    rawQuery: "",
    decodedQuery: "",
    logger: createLogger(),
    supabase: null,
    services: {},
  });

  assert.equal(result.source, "generated:viewshowroom:lid=100");

  const carNames = [...result.body.matchAll(/<c\b[^>]*\bn='([^']+)'/g)].map((match) => match[1]);
  assert.ok(carNames.includes("Acura Integra GS-R"), "mixed showroom should include entry-level stock");
  assert.ok(carNames.includes("Ford GT"), "mixed showroom should include higher-tier stock");
});
