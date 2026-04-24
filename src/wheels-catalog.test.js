import test from "node:test";
import assert from "node:assert/strict";
import { buildWheelsTiresCatalogXml } from "./wheels-catalog.js";

const EXPECTED_WHEELS = [
  [1174, "15"],
  [1175, "16"],
  [1176, "17"],
  [1177, "18"],
  [1178, "19"],
  [1179, "20"],
];

test("wheel catalog keeps HRE 895R Carbon Fiber variants mapped to 1174-1179", () => {
  const xml = buildWheelsTiresCatalogXml();

  for (const [partId, size] of EXPECTED_WHEELS) {
    const match = xml.match(new RegExp(`<p[^>]*i='${partId}'[^>]*/>`));
    assert.ok(match, `expected wheel ${partId} to be present`);

    const node = match[0];
    assert.match(node, /b='hre'/, `expected wheel ${partId} to use the HRE brand slug`);
    assert.match(node, /bn='HRE'/, `expected wheel ${partId} to use the HRE brand name`);
    assert.match(node, /mn='895R Carbon Fiber'/, `expected wheel ${partId} to use the 895R Carbon Fiber model name`);
    assert.match(node, new RegExp(`n='HRE 895R Carbon Fiber ${size}&quot;'`), `expected wheel ${partId} to use the ${size}" label`);
    assert.match(node, new RegExp(`ps='${size}'`), `expected wheel ${partId} to keep the ${size}" size value`);
  }
});
