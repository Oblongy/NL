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
