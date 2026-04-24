import test from "node:test";
import assert from "node:assert/strict";
import { buildWheelsTiresCatalogXml } from "./wheels-catalog.js";

const EXPECTED_MAPPINGS = [
  {
    label: "Stock OEM",
    brandSlug: "oem",
    brandName: "OEM",
    modelName: "Stock OEM",
    wheels: [
      [1168, "15"],
      [1169, "16"],
      [1170, "17"],
      [1171, "18"],
      [1172, "19"],
      [1173, "20"],
    ],
  },
  {
    label: "HRE 895R Carbon Fiber",
    brandSlug: "hre",
    brandName: "HRE",
    modelName: "895R Carbon Fiber",
    wheels: [
      [1174, "15"],
      [1175, "16"],
      [1176, "17"],
      [1177, "18"],
      [1178, "19"],
      [1179, "20"],
    ],
  },
];

test("wheel catalog keeps the corrected wheel variants mapped to 1168-1179", () => {
  const xml = buildWheelsTiresCatalogXml();

  for (const mapping of EXPECTED_MAPPINGS) {
    for (const [partId, size] of mapping.wheels) {
      const match = xml.match(new RegExp(`<p[^>]*i='${partId}'[^>]*/>`));
      assert.ok(match, `expected wheel ${partId} to be present`);

      const node = match[0];
      assert.match(node, new RegExp(`b='${mapping.brandSlug}'`), `expected wheel ${partId} to use the ${mapping.label} brand slug`);
      assert.match(node, new RegExp(`bn='${mapping.brandName}'`), `expected wheel ${partId} to use the ${mapping.label} brand name`);
      assert.match(node, new RegExp(`mn='${mapping.modelName}'`), `expected wheel ${partId} to use the ${mapping.label} model name`);
      assert.match(node, new RegExp(`n='${mapping.label} ${size}&quot;'`), `expected wheel ${partId} to use the ${size}" ${mapping.label} label`);
      assert.match(node, new RegExp(`ps='${size}'`), `expected wheel ${partId} to keep the ${size}" size value`);
    }
  }
});
