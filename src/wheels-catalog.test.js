import test from "node:test";
import assert from "node:assert/strict";
import { buildWheelsTiresCatalogXml } from "./wheels-catalog.js";

const EXPECTED_MAPPINGS = [
  {
    label: "Mazda Bergenholtz Rims",
    brandSlug: "mazda",
    brandName: "Mazda",
    modelName: "Bergenholtz Rims",
    wheels: [
      [1132, "15"],
      [1133, "16"],
      [1134, "17"],
      [1135, "18"],
      [1136, "19"],
      [1137, "20"],
    ],
  },
  {
    label: "OEM Corvette Rims",
    brandSlug: "oem",
    brandName: "OEM",
    modelName: "OEM Corvette Rims",
    wheels: [
      [1036, "15"],
      [1037, "16"],
      [1038, "17"],
      [1039, "18"],
      [1040, "19"],
      [1041, "20"],
    ],
  },
  {
    label: "BBS sport LM",
    brandSlug: "bbs",
    brandName: "BBS",
    modelName: "sport LM",
    wheels: [
      [1060, "15"],
      [1061, "16"],
      [1062, "17"],
      [1063, "18"],
      [1064, "19"],
      [1065, "20"],
    ],
  },
  {
    label: "OEM Optional 5-spoke Alloy Wheels",
    brandSlug: "oem",
    brandName: "OEM",
    modelName: "OEM Optional 5-spoke Alloy Wheels",
    wheels: [
      [1168, "15"],
      [1169, "16"],
      [1170, "17"],
      [1171, "18"],
    ],
  },
  {
    label: "Stock OEM",
    brandSlug: "oem",
    brandName: "OEM",
    modelName: "Stock OEM",
    wheels: [
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
  {
    label: "HRE 441R",
    brandSlug: "hre",
    brandName: "HRE",
    modelName: "441R",
    wheels: [
      [1180, "15"],
      [1181, "16"],
      [1182, "17"],
      [1183, "18"],
      [1184, "19"],
      [1185, "20"],
    ],
  },
  {
    label: "HRE C22",
    brandSlug: "hre",
    brandName: "HRE",
    modelName: "C22",
    wheels: [
      [1186, "15"],
      [1187, "16"],
      [1188, "17"],
      [1189, "18"],
      [1190, "19"],
      [1191, "20"],
    ],
  },
  {
    label: "HRE 547R",
    brandSlug: "hre",
    brandName: "HRE",
    modelName: "547R",
    wheels: [
      [1192, "15"],
      [1193, "16"],
      [1194, "17"],
      [1195, "18"],
      [1196, "19"],
      [1197, "20"],
    ],
  },
];

test("wheel catalog keeps the corrected wheel variants mapped to 1036-1197", () => {
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
