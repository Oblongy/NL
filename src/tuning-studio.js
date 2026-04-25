import { FULL_CAR_CATALOG } from "./car-catalog.js";
import {
  DEFAULT_COLOR_CODE,
  DEFAULT_PAINT_INDEX,
  getDefaultPartsXmlForCar,
  getDefaultWheelXmlForCar,
} from "./car-defaults.js";
import {
  getStaticPartsCatalogXml,
  getStaticPartsCategoriesBody,
} from "./catalog-data-source.js";
import { getEngineTypeIdForCar, getEffectiveEngineString } from "./car-engine-state.js";
import { buildCarRaceSpec, getRedLine } from "./engine-physics.js";
import { summarizeInstalledEnginePartStats } from "./engine-part-stats.js";
import { renderOwnedGarageCar } from "./game-xml.js";
import { normalizeOwnedPartsXmlValue } from "./parts-xml.js";
import { getShowroomCarSpec, hasShowroomCarSpec } from "./showroom-car-specs.js";

const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)=['"]([^'"]*)['"]/g;
const CATEGORY_XML_REGEX = /<c\b([^>]*)>/g;

const DEFAULT_DYNO_PURCHASE_STATE = Object.freeze({
  boostSetting: 5,
  maxPsi: 10,
  chipSetting: 0,
  shiftLightRpm: 7200,
});

const BOOST_CONTROLLER_SLOT_IDS = ["23", "2005"];
const AFR_CONTROLLER_SLOT_IDS = ["2006", "174", "134"];
const SHIFT_LIGHT_SLOT_IDS = ["26"];
const GEAR_TUNE_SLOT_IDS = ["22", "2013"];
const RESERVED_PART_OVERRIDE_ATTRS = new Set(["ai", "i", "pi", "ci"]);
const SUPPORTED_PART_OVERRIDE_ATTRS = Object.freeze([
  "n",
  "t",
  "p",
  "pp",
  "g",
  "di",
  "pdi",
  "b",
  "bn",
  "mn",
  "l",
  "mo",
  "hp",
  "tq",
  "wt",
  "cc",
  "ps",
]);

let cachedCatalog = null;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parseXmlAttributes(rawEntry) {
  const attrs = {};
  let match;
  while ((match = PART_XML_ATTR_REGEX.exec(String(rawEntry || ""))) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_XML_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

function listInstalledPartEntries(partsXml) {
  const entries = [];
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(String(partsXml || ""))) !== null) {
    entries.push({
      raw: match[0],
      attrs: parseXmlAttributes(match[0]),
    });
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return entries;
}

function serializePartXmlAttributes(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}='${escapeXml(String(value))}'`)
    .join(" ");
}

function replaceInstalledPartEntry(partsXml, originalRaw, nextAttrs) {
  return String(partsXml || "").replace(originalRaw, `<p ${serializePartXmlAttributes(nextAttrs)}/>`);
}

function findInstalledPartEntryBySlots(partsXml, slotIds = []) {
  const allowedSlots = new Set(slotIds.map((slotId) => String(slotId)));
  return listInstalledPartEntries(partsXml).find(({ attrs }) => {
    const slotId = String(attrs.ci || attrs.pi || "");
    return allowedSlots.has(slotId);
  }) || null;
}

function saveTuneAttrsToPartsXml(partsXml, attrs, preferredSlotIds) {
  const carrier = findInstalledPartEntryBySlots(partsXml, preferredSlotIds);
  if (!carrier) {
    return null;
  }

  return replaceInstalledPartEntry(partsXml, carrier.raw, {
    ...carrier.attrs,
    ...attrs,
  });
}

function buildInstalledCatalogPartXml(catalogPart, installId, overrides = {}) {
  const attrs = {
    ai: installId,
    i: overrides.i ?? catalogPart.i ?? "",
    pi: overrides.pi ?? catalogPart.pi ?? "",
    t: overrides.t ?? catalogPart.t ?? "",
    n: overrides.n ?? catalogPart.n ?? "",
    p: overrides.p ?? catalogPart.p ?? "0",
    pp: overrides.pp ?? catalogPart.pp ?? "0",
    g: overrides.g ?? catalogPart.g ?? "",
    di: overrides.di ?? catalogPart.di ?? "",
    pdi: overrides.pdi ?? catalogPart.pdi ?? catalogPart.di ?? "",
    b: overrides.b ?? catalogPart.b ?? "",
    bn: overrides.bn ?? catalogPart.bn ?? "",
    mn: overrides.mn ?? catalogPart.mn ?? "",
    l: overrides.l ?? catalogPart.l ?? "100",
    in: "1",
    mo: overrides.mo ?? catalogPart.mo ?? "0",
    hp: overrides.hp ?? catalogPart.hp ?? "0",
    tq: overrides.tq ?? catalogPart.tq ?? "0",
    wt: overrides.wt ?? catalogPart.wt ?? "0",
    cc: overrides.cc ?? catalogPart.cc ?? "",
    ps: overrides.ps ?? catalogPart.ps ?? "",
  };

  return `<p ${serializePartXmlAttributes(attrs)}/>`;
}

function parseExtraPartAttrText(rawText) {
  const extraAttrs = {};
  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/i.test(key) || RESERVED_PART_OVERRIDE_ATTRS.has(key)) {
      continue;
    }
    extraAttrs[key] = value;
  }
  return extraAttrs;
}

function normalizePartOverrideMap(partOverrides, selectedBySlot, partsById) {
  const normalized = {};

  for (const [slotId, requestedOverrides] of Object.entries(partOverrides || {})) {
    if (!selectedBySlot.has(String(slotId))) {
      continue;
    }

    const selectedPartId = String(selectedBySlot.get(String(slotId)) || "");
    const catalogPart = partsById.get(selectedPartId);
    if (!catalogPart) {
      continue;
    }

    const nextOverrides = {};
    for (const key of SUPPORTED_PART_OVERRIDE_ATTRS) {
      if (!(key in (requestedOverrides || {}))) {
        continue;
      }

      const rawValue = requestedOverrides[key];
      if (rawValue === undefined || rawValue === null || rawValue === "") {
        continue;
      }
      nextOverrides[key] = String(rawValue);
    }

    Object.assign(nextOverrides, parseExtraPartAttrText(requestedOverrides?.extraAttrs));

    if (Object.keys(nextOverrides).length > 0) {
      normalized[String(slotId)] = nextOverrides;
    }
  }

  return normalized;
}

function getPartMetricValue(part, overrides, key) {
  const overriddenValue = overrides?.[key];
  if (overriddenValue !== undefined && overriddenValue !== null && overriddenValue !== "") {
    const numericValue = Number(overriddenValue);
    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return Number(part?.[key === "hp" ? "horsepower" : key === "tq" ? "torque" : "weight"] || 0);
}

function parsePartsCatalog() {
  const partsById = new Map();
  const partsBySlot = new Map();

  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(getStaticPartsCatalogXml())) !== null) {
    const attrs = parseXmlAttributes(match[0]);
    const partId = String(attrs.i || "");
    const slotId = String(attrs.pi || attrs.ci || "");
    if (!partId || !slotId) {
      continue;
    }

    const part = Object.freeze({
      id: partId,
      slotId,
      name: attrs.n || `Part ${partId}`,
      brand: attrs.bn || attrs.b || "",
      model: attrs.mn || "",
      type: attrs.t || "",
      group: attrs.g || "",
      locationId: attrs.l || "100",
      price: Number(attrs.p || 0),
      pointPrice: Number(attrs.pp || 0),
      horsepower: Number(attrs.hp || 0),
      torque: Number(attrs.tq || 0),
      weight: Number(attrs.wt || 0),
      designId: attrs.di || "",
      size: attrs.ps || "",
      raw: attrs,
    });

    partsById.set(partId, part);
    const bucket = partsBySlot.get(slotId) || [];
    bucket.push(part);
    partsBySlot.set(slotId, bucket);
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;

  for (const bucket of partsBySlot.values()) {
    bucket.sort((left, right) => {
      if (left.price !== right.price) {
        return left.price - right.price;
      }
      return left.name.localeCompare(right.name);
    });
  }

  return { partsById, partsBySlot };
}

function parseCategoryCatalog() {
  const categoriesById = new Map();
  let match;
  while ((match = CATEGORY_XML_REGEX.exec(getStaticPartsCategoriesBody())) !== null) {
    const attrs = parseXmlAttributes(match[0]);
    const id = String(attrs.i || "");
    if (!id) {
      continue;
    }

    categoriesById.set(id, Object.freeze({
      id,
      parentId: String(attrs.pi || "0"),
      name: attrs.n || `Category ${id}`,
      childCount: Number(attrs.c || 0),
      shopType: String(attrs.s || "0"),
    }));
  }
  CATEGORY_XML_REGEX.lastIndex = 0;

  return categoriesById;
}

function getShowroomSpecHorsepower(spec, catalogCarId) {
  const directHp = Number(spec?.hp);
  if (Number.isFinite(directHp) && directHp > 0) {
    return directHp;
  }

  const hpMatch = String(spec?.et || "").match(/^([\d.]+)/);
  if (hpMatch) {
    return Number(hpMatch[1]);
  }

  throw new Error(`Missing showroom horsepower for catalog car ${catalogCarId}`);
}

function getShowroomSpecWeight(spec, catalogCarId) {
  const weight = Number(spec?.sw);
  if (Number.isFinite(weight) && weight > 0) {
    return weight;
  }

  throw new Error(`Missing showroom weight for catalog car ${catalogCarId}`);
}

function getShowroomSpecTorque(spec, catalogCarId) {
  const torque = Number(spec?.tq || 0);
  if (Number.isFinite(torque) && torque > 0) {
    return torque;
  }

  const horsepower = getShowroomSpecHorsepower(spec, catalogCarId);
  return Math.max(100, Math.round(horsepower * 0.92));
}

function getCapturedTimingCurveProfile(spec) {
  const engine = String(spec?.eo || "").toLowerCase();
  const transmission = String(spec?.tt || "").toLowerCase();
  const isV8 = engine.includes("v8") || engine.includes("hemi");
  const isV10 = engine.includes("v10") || engine.includes("10-cyl");
  const isV6 = engine.includes("v6");
  const isRotary = engine.includes("rotary");
  const isBoosted =
    engine.includes("turbo")
    || engine.includes("supercharged")
    || /\btt\b/.test(engine)
    || /\bsc\b/.test(engine)
    || /\bt\b/.test(engine);
  const isSixSpeed = transmission.includes("6-speed");

  if (isV8 || isV10) {
    return { startFactor: 0.4, endFactor: isSixSpeed ? 0.406 : 0.404, curvePower: 1.7, length: 102 };
  }
  if (isV6) {
    return { startFactor: 0.395, endFactor: 0.425, curvePower: 1.45, length: 102 };
  }
  if (isRotary) {
    return { startFactor: 0.39, endFactor: 0.46, curvePower: 1.2, length: 102 };
  }
  if (isBoosted) {
    return { startFactor: 0.4, endFactor: 0.43, curvePower: 1.35, length: 102 };
  }
  return { startFactor: 0.4, endFactor: 0.47, curvePower: 1.15, length: 102 };
}

function generateTimingArray(catalogCarId, engineTypeId, performanceStats = null) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const torque = Number(performanceStats?.torque ?? getShowroomSpecTorque(spec, catalogCarId));
  const profile = getCapturedTimingCurveProfile({
    ...spec,
    eo: getEffectiveEngineString(spec.eo, engineTypeId),
  });

  const startValue = torque * profile.startFactor;
  const endValue = Math.max(startValue + 1, torque * profile.endFactor);
  const values = [];

  for (let index = 0; index < profile.length; index += 1) {
    const progress = profile.length <= 1 ? 1 : index / (profile.length - 1);
    const eased = Math.pow(progress, profile.curvePower);
    const value = startValue + ((endValue - startValue) * eased);
    values.push(Math.max(1, Math.round(value)));
  }

  return values;
}

function buildN2Fields(catalogCarId, gearRatioOverrides = null, engineTypeId = null, performanceStats = null) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const horsepower = Number(performanceStats?.horsepower ?? getShowroomSpecHorsepower(spec, catalogCarId));
  const weight = Number(performanceStats?.weight ?? getShowroomSpecWeight(spec, catalogCarId));
  const effectiveEngineStr = getEffectiveEngineString(spec.eo, engineTypeId);
  const engineStr = effectiveEngineStr.toLowerCase();

  const x = Number((horsepower * 0.02859).toFixed(3));
  const z = x;
  const y = Number((x * 5.5).toFixed(3));
  const r = weight + 18;

  let aa = 4;
  if (engineStr.includes("v10") || engineStr.includes("10-cyl")) aa = 10;
  else if (engineStr.includes("v8") || engineStr.includes("8-cyl") || engineStr.includes("hemi")) aa = 8;
  else if (engineStr.includes("v6") || engineStr.includes("6-cyl") || engineStr.includes("i6") || engineStr.includes("h6")) aa = 6;
  else if (engineStr.includes("rotary")) aa = 2;
  else if (engineStr.includes("3-cyl") || engineStr.includes("i3")) aa = 3;

  const sl = getRedLine(effectiveEngineStr, spec.tt);
  const o = sl + (engineStr.includes("vtec") || engineStr.includes("i4") ? 200 : 100);

  let a = sl;
  let n = sl;
  if (engineStr.includes("v8") || engineStr.includes("hemi")) {
    a = Math.round(sl * 0.92);
    n = Math.round(sl * 0.985);
  } else if (engineStr.includes("v6")) {
    a = Math.round(sl * 0.94);
    n = Math.round(sl * 0.985);
  } else if (engineStr.includes("turbo") || engineStr.includes(" tt") || engineStr.includes(" t ") || / t$/.test(engineStr)) {
    a = Math.round(sl * 0.88);
    n = Math.round(sl * 0.68);
  }

  const raceSpec = buildCarRaceSpec({
    horsepower,
    weightLbs: weight,
    engineStr: effectiveEngineStr,
    drivetrainStr: spec.dt,
    transmissionStr: spec.tt,
    bodyTypeStr: spec.ct,
  });
  const ratios = raceSpec.gearbox.forwardRatios;
  const f = Number(gearRatioOverrides?.g1 ?? ratios[0] ?? 3.587);
  const g = Number(gearRatioOverrides?.g2 ?? ratios[1] ?? 2.022);
  const h = Number(gearRatioOverrides?.g3 ?? ratios[2] ?? 1.384);
  const i = Number(gearRatioOverrides?.g4 ?? ratios[3] ?? 1.0);
  const j = Number(gearRatioOverrides?.g5 ?? ratios[4] ?? 0.861);
  const l = Number(gearRatioOverrides?.fg ?? raceSpec.gearbox.finalDrive);

  return { x, y, z, r, aa, sl, a, n, o, f, g, h, i, j, l };
}

function buildDriveableEngineXml({ catalogCarId, gearRatios, engineTypeId, performanceStats = null }) {
  const n2 = buildN2Fields(catalogCarId, gearRatios, engineTypeId, performanceStats);
  const valveCount = n2.aa * 4;

  return (
    `<n2 es='1' sl='${n2.sl}' sg='0' rc='0' tmp='0' r='${n2.r}' v='0' ` +
    `a='${n2.a}' n='${n2.n}' o='${n2.o}' s='0.854' b='0' p='1.8' c='0' e='0' d='N' ` +
    `f='${n2.f}' g='${n2.g}' h='${n2.h}' i='${n2.i}' j='${n2.j}' k='0' l='${n2.l}' ` +
    `q='0' m='0' t='0' u='10' w='0' x='${n2.x}' y='${n2.y}' z='${n2.z}' ` +
    `aa='${n2.aa}' ab='${valveCount}' ac='0' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
    `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
    `at='100' au='100' av='0' aw='100' ax='0'/>`
  );
}

function getDefaultGearRatiosForCar(car) {
  const catalogCarId = String(car?.catalog_car_id || "");
  const defaultRatios = {
    g1: "3.587",
    g2: "2.022",
    g3: "1.384",
    g4: "1.000",
    g5: "0.861",
    g6: "0.000",
    fg: "4.058",
  };

  if (!catalogCarId || !hasShowroomCarSpec(catalogCarId)) {
    return defaultRatios;
  }

  const n2 = buildN2Fields(catalogCarId, null, getEngineTypeIdForCar(car));
  return {
    g1: String(n2.f ?? defaultRatios.g1),
    g2: String(n2.g ?? defaultRatios.g2),
    g3: String(n2.h ?? defaultRatios.g3),
    g4: String(n2.i ?? defaultRatios.g4),
    g5: String(n2.j ?? defaultRatios.g5),
    g6: "0.000",
    fg: String(n2.l ?? defaultRatios.fg),
  };
}

function getPersistedGearRatios(car) {
  const defaults = getDefaultGearRatiosForCar(car);
  const carrier = findInstalledPartEntryBySlots(car?.parts_xml || "", GEAR_TUNE_SLOT_IDS);
  const attrs = carrier?.attrs || {};
  return {
    g1: String(attrs.g1 || defaults.g1),
    g2: String(attrs.g2 || defaults.g2),
    g3: String(attrs.g3 || defaults.g3),
    g4: String(attrs.g4 || defaults.g4),
    g5: String(attrs.g5 || defaults.g5),
    g6: String(attrs.g6 || defaults.g6),
    fg: String(attrs.fg || defaults.fg),
  };
}

function buildPreviewCar(catalogCarId, partsXml, wheelXml) {
  return {
    game_car_id: Number(catalogCarId),
    account_car_id: Number(catalogCarId),
    catalog_car_id: Number(catalogCarId),
    selected: 1,
    paint_index: DEFAULT_PAINT_INDEX,
    plate_name: "",
    locked: 0,
    image_index: 0,
    color_code: DEFAULT_COLOR_CODE,
    wheel_xml: wheelXml,
    parts_xml: partsXml,
  };
}

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numericValue));
}

function formatRatio(value, fallback = "0.000") {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return numericValue.toFixed(3);
}

function buildSelectionMap(defaultPartsXml, selectedPartIds, partsById) {
  const selectedBySlot = new Map();

  for (const entry of listInstalledPartEntries(defaultPartsXml)) {
    const slotId = String(entry.attrs.pi || entry.attrs.ci || "");
    const partId = String(entry.attrs.i || "");
    if (slotId && partId && partsById.has(partId)) {
      selectedBySlot.set(slotId, partId);
    }
  }

  for (const [requestedSlotId, value] of Object.entries(selectedPartIds || {})) {
    const partId = String(value || "").trim();
    const slotId = String(requestedSlotId || "").trim();
    if (!slotId) {
      continue;
    }

    if (!partId) {
      selectedBySlot.delete(slotId);
      continue;
    }

    const catalogPart = partsById.get(partId);
    if (!catalogPart) {
      continue;
    }

    selectedBySlot.set(String(catalogPart.slotId || slotId), partId);
  }

  return selectedBySlot;
}

function buildPartsXmlFromSelection(selectedBySlot, partsById, partOverrideMap = {}) {
  const orderedSelections = [...selectedBySlot.entries()].sort((left, right) => Number(left[0]) - Number(right[0]));
  const partsXml = orderedSelections
    .map(([slotId, partId]) => {
      const catalogPart = partsById.get(String(partId));
      if (!catalogPart) {
        return "";
      }
      return buildInstalledCatalogPartXml(
        catalogPart.raw,
        `studio_${slotId}_${partId}`,
        partOverrideMap[String(slotId)] || {},
      );
    })
    .join("");

  return normalizeOwnedPartsXmlValue(partsXml);
}

function summarizeSelectionStats(selectedBySlot, baselineBySlot, partsById, partOverrideMap = {}) {
  let horsepower = 0;
  let torque = 0;
  let weight = 0;

  const allSlots = new Set([
    ...selectedBySlot.keys(),
    ...baselineBySlot.keys(),
  ]);

  for (const slotId of allSlots) {
    const selectedPart = partsById.get(String(selectedBySlot.get(slotId) || ""));
    const baselinePart = partsById.get(String(baselineBySlot.get(slotId) || ""));
    const selectedOverrides = partOverrideMap[String(slotId)] || null;

    horsepower += getPartMetricValue(selectedPart, selectedOverrides, "hp") - Number(baselinePart?.horsepower || 0);
    torque += getPartMetricValue(selectedPart, selectedOverrides, "tq") - Number(baselinePart?.torque || 0);
    weight += getPartMetricValue(selectedPart, selectedOverrides, "wt") - Number(baselinePart?.weight || 0);
  }

  return {
    horsepower,
    torque,
    weight,
  };
}

function buildDynoGraph({
  catalogCarId,
  engineTypeId,
  gearRatios,
  horsepower,
  torque,
}) {
  const n2 = buildN2Fields(catalogCarId, gearRatios, engineTypeId);
  const redLine = Number(n2.sl || 7000);
  const torquePeakRpm = Number(n2.n || Math.round(redLine * 0.72));
  const powerPeakRpm = Number(n2.a || Math.round(redLine * 0.9));
  const startRpm = 1000;
  const step = 250;
  const points = [];

  const torqueSpread = Math.max(850, Math.round(redLine * 0.18));
  const powerSpread = Math.max(900, Math.round(redLine * 0.2));

  let maxTorqueRaw = 0;
  let maxHorsepowerRaw = 0;
  for (let rpm = startRpm; rpm <= redLine; rpm += step) {
    const torqueBell = Math.exp(-Math.pow(rpm - torquePeakRpm, 2) / (2 * torqueSpread * torqueSpread));
    const powerBell = Math.exp(-Math.pow(rpm - powerPeakRpm, 2) / (2 * powerSpread * powerSpread));
    const combinedBell = Math.max(0.35, Math.min(1.1, 0.58 + (torqueBell * 0.34) + (powerBell * 0.08)));
    const torqueRaw = combinedBell;
    const horsepowerRaw = (torqueRaw * rpm) / 5252;
    maxTorqueRaw = Math.max(maxTorqueRaw, torqueRaw);
    maxHorsepowerRaw = Math.max(maxHorsepowerRaw, horsepowerRaw);
    points.push({ rpm, torqueRaw, horsepowerRaw });
  }

  const torqueScale = maxTorqueRaw > 0 ? Number(torque) / maxTorqueRaw : 1;
  const horsepowerScale = maxHorsepowerRaw > 0 ? Number(horsepower) / maxHorsepowerRaw : 1;

  return {
    redLine,
    horsepowerPeakRpm: powerPeakRpm,
    torquePeakRpm,
    points: points.map((point) => ({
      rpm: point.rpm,
      torque: Math.max(1, Math.round(point.torqueRaw * torqueScale)),
      horsepower: Math.max(1, Math.round(point.horsepowerRaw * horsepowerScale)),
    })),
  };
}

function validateGearRatios(gearRatios, defaultHasSixth) {
  const numericRatios = Object.fromEntries(
    Object.entries(gearRatios).map(([key, value]) => [key, Number(value)]),
  );

  if (Object.values(numericRatios).some((value) => !Number.isFinite(value) || value < 0)) {
    return "Gear ratios must be finite positive numbers.";
  }
  if (Object.values(numericRatios).some((value) => value > 10)) {
    return "Gear ratios cannot exceed 10.000.";
  }
  if (numericRatios.g1 < 2.5) {
    return "First gear must be at least 2.500.";
  }
  if (!defaultHasSixth && numericRatios.g6 > 0) {
    return "This car does not support a sixth gear tune.";
  }

  const forwardRatios = [numericRatios.g1, numericRatios.g2, numericRatios.g3, numericRatios.g4, numericRatios.g5];
  if (numericRatios.g6 > 0) {
    forwardRatios.push(numericRatios.g6);
  }
  for (let index = 0; index < forwardRatios.length - 1; index += 1) {
    if (forwardRatios[index] <= forwardRatios[index + 1]) {
      return "Forward gears must stay in descending order.";
    }
  }

  return "";
}

function buildSlotDescriptor(slotId, categoriesById, parts) {
  const slot = categoriesById.get(slotId);
  const parent = categoriesById.get(String(slot?.parentId || ""));

  return {
    id: slotId,
    name: slot?.name || `Slot ${slotId}`,
    parentId: parent?.id || slot?.parentId || "0",
    parentName: parent?.name || "Misc",
    itemCount: parts.length,
    parts: parts.map((part) => ({
      id: part.id,
      name: part.name,
      brand: part.brand,
      model: part.model,
      price: part.price,
      pointPrice: part.pointPrice,
      horsepower: part.horsepower,
      torque: part.torque,
      weight: part.weight,
      type: part.type,
      designId: part.designId,
      locationId: part.locationId,
      size: part.size,
      editableAttrs: {
        n: part.raw.n || "",
        t: part.raw.t || "",
        p: part.raw.p || "0",
        pp: part.raw.pp || "0",
        g: part.raw.g || "",
        di: part.raw.di || "",
        pdi: part.raw.pdi || part.raw.di || "",
        b: part.raw.b || "",
        bn: part.raw.bn || part.raw.b || "",
        mn: part.raw.mn || "",
        l: part.raw.l || "100",
        mo: part.raw.mo || "0",
        hp: part.raw.hp || "0",
        tq: part.raw.tq || "0",
        wt: part.raw.wt || "0",
        cc: part.raw.cc || "",
        ps: part.raw.ps || "",
      },
    })),
  };
}

function buildCatalogCache() {
  const { partsById, partsBySlot } = parsePartsCatalog();
  const categoriesById = parseCategoryCatalog();

  const cars = FULL_CAR_CATALOG
    .filter(([catalogCarId]) => hasShowroomCarSpec(catalogCarId))
    .map(([id, name, price, locationId]) => {
      const spec = getShowroomCarSpec(id);
      const defaultPartsXml = getDefaultPartsXmlForCar(id);
      const defaultPartIdsBySlot = Object.fromEntries(
        [...buildSelectionMap(defaultPartsXml, {}, partsById).entries()].sort((left, right) => Number(left[0]) - Number(right[0])),
      );

      return {
        id: String(id),
        name,
        make: String(name || "").split(/\s+/)[0] || "Garage",
        price: Number(price || 0),
        locationId: String(locationId || "100"),
        defaultPartIdsBySlot,
        defaultWheelXml: getDefaultWheelXmlForCar(id),
        spec: {
          horsepower: getShowroomSpecHorsepower(spec, id),
          torque: getShowroomSpecTorque(spec, id),
          weight: getShowroomSpecWeight(spec, id),
          engine: spec.eo,
          drivetrain: spec.dt,
          transmission: spec.tt,
          et: spec.st,
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const slots = [...partsBySlot.entries()]
    .map(([slotId, parts]) => buildSlotDescriptor(slotId, categoriesById, parts))
    .sort((left, right) => {
      if (left.parentName !== right.parentName) {
        return left.parentName.localeCompare(right.parentName);
      }
      return left.name.localeCompare(right.name);
    });

  return {
    partsById,
    cars,
    slots,
    version: Date.now(),
  };
}

function getCatalogCache() {
  if (!cachedCatalog) {
    cachedCatalog = buildCatalogCache();
  }
  return cachedCatalog;
}

export function buildTuningStudioCatalog() {
  const catalog = getCatalogCache();
  return {
    generatedAt: new Date().toISOString(),
    tuneSlots: {
      boost: BOOST_CONTROLLER_SLOT_IDS,
      afr: AFR_CONTROLLER_SLOT_IDS,
      shiftLight: SHIFT_LIGHT_SLOT_IDS,
      gears: GEAR_TUNE_SLOT_IDS,
    },
    cars: catalog.cars,
    slots: catalog.slots,
  };
}

export function buildTuningStudioPreview(input = {}) {
  const catalog = getCatalogCache();
  const catalogCarId = String(input.catalogCarId || "").trim();
  const car = catalog.cars.find((entry) => entry.id === catalogCarId);
  if (!car) {
    throw new Error(`Unknown catalog car ${catalogCarId || "<empty>"}`);
  }

  const defaultPartsXml = getDefaultPartsXmlForCar(catalogCarId);
  const defaultSelectedBySlot = buildSelectionMap(
    defaultPartsXml,
    {},
    catalog.partsById,
  );
  const selectedBySlot = buildSelectionMap(
    defaultPartsXml,
    input.selectedPartIds || {},
    catalog.partsById,
  );
  const partOverrideMap = normalizePartOverrideMap(
    input.partOverrides,
    selectedBySlot,
    catalog.partsById,
  );
  let partsXml = buildPartsXmlFromSelection(selectedBySlot, catalog.partsById, partOverrideMap);
  const wheelXml = getDefaultWheelXmlForCar(catalogCarId);
  const warnings = [];

  let previewCar = buildPreviewCar(catalogCarId, partsXml, wheelXml);
  const engineTypeIdBeforeTune = getEngineTypeIdForCar(previewCar);
  const spec = getShowroomCarSpec(catalogCarId);
  const redLine = getRedLine(getEffectiveEngineString(spec.eo, engineTypeIdBeforeTune), spec.tt);
  const defaultShiftLightRpm = Math.max(1000, Math.min(DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm, redLine));

  const requestedBoost = clampNumber(
    input?.tune?.boostSetting,
    0,
    10,
    DEFAULT_DYNO_PURCHASE_STATE.boostSetting,
  );
  const requestedAfr = clampNumber(
    input?.tune?.chipSetting,
    0,
    100,
    DEFAULT_DYNO_PURCHASE_STATE.chipSetting,
  );
  const requestedShiftLight = Math.round(
    clampNumber(
      input?.tune?.shiftLightRpm,
      1000,
      redLine,
      defaultShiftLightRpm,
    ),
  );

  const wantsBoostTune = requestedBoost !== DEFAULT_DYNO_PURCHASE_STATE.boostSetting;
  const wantsAfrTune = requestedAfr !== DEFAULT_DYNO_PURCHASE_STATE.chipSetting;
  const wantsShiftLightTune = requestedShiftLight !== defaultShiftLightRpm;
  const hasBoostController = Boolean(findInstalledPartEntryBySlots(partsXml, BOOST_CONTROLLER_SLOT_IDS));
  const hasAfrController = Boolean(findInstalledPartEntryBySlots(partsXml, AFR_CONTROLLER_SLOT_IDS));
  const hasShiftLightController = Boolean(findInstalledPartEntryBySlots(partsXml, SHIFT_LIGHT_SLOT_IDS));

  if (hasBoostController) {
    partsXml = saveTuneAttrsToPartsXml(partsXml, {
      bs: String(requestedBoost),
      mp: String(DEFAULT_DYNO_PURCHASE_STATE.maxPsi),
    }, BOOST_CONTROLLER_SLOT_IDS) || partsXml;
  } else if (wantsBoostTune) {
    warnings.push("Boost tune was requested but no boost controller slot is installed.");
  }

  if (hasAfrController) {
    partsXml = saveTuneAttrsToPartsXml(partsXml, {
      cs: String(requestedAfr),
    }, AFR_CONTROLLER_SLOT_IDS) || partsXml;
  } else if (wantsAfrTune) {
    warnings.push("Air/fuel tune was requested but no AFR or ECU tuning slot is installed.");
  }

  if (hasShiftLightController) {
    partsXml = saveTuneAttrsToPartsXml(partsXml, {
      slr: String(requestedShiftLight),
      rl: String(redLine),
    }, SHIFT_LIGHT_SLOT_IDS) || partsXml;
  } else if (wantsShiftLightTune) {
    warnings.push("Shift light RPM was requested but no full engine management slot is installed.");
  }

  previewCar = buildPreviewCar(catalogCarId, partsXml, wheelXml);
  const defaultGearRatios = getDefaultGearRatiosForCar(previewCar);
  const submittedGearRatios = {
    g1: formatRatio(input?.tune?.gearRatios?.g1, defaultGearRatios.g1),
    g2: formatRatio(input?.tune?.gearRatios?.g2, defaultGearRatios.g2),
    g3: formatRatio(input?.tune?.gearRatios?.g3, defaultGearRatios.g3),
    g4: formatRatio(input?.tune?.gearRatios?.g4, defaultGearRatios.g4),
    g5: formatRatio(input?.tune?.gearRatios?.g5, defaultGearRatios.g5),
    g6: formatRatio(input?.tune?.gearRatios?.g6, defaultGearRatios.g6),
    fg: formatRatio(input?.tune?.gearRatios?.fg, defaultGearRatios.fg),
  };
  const hasGearSlot = Boolean(findInstalledPartEntryBySlots(partsXml, GEAR_TUNE_SLOT_IDS));
  const defaultHasSixth = Number(defaultGearRatios.g6) > 0;
  const gearValidationError = validateGearRatios(submittedGearRatios, defaultHasSixth);
  const wantsGearTune = Object.entries(submittedGearRatios).some(([key, value]) => String(value) !== String(defaultGearRatios[key]));

  if (gearValidationError) {
    warnings.push(gearValidationError);
  } else if (hasGearSlot) {
    partsXml = saveTuneAttrsToPartsXml(partsXml, submittedGearRatios, GEAR_TUNE_SLOT_IDS) || partsXml;
  } else if (wantsGearTune) {
    warnings.push("Gear ratios were requested but no gear tuning slot is installed.");
  }

  partsXml = normalizeOwnedPartsXmlValue(partsXml);
  previewCar = buildPreviewCar(catalogCarId, partsXml, wheelXml);

  const engineTypeId = getEngineTypeIdForCar(previewCar);
  const gearRatios = getPersistedGearRatios(previewCar);
  const baseHorsepower = getShowroomSpecHorsepower(spec, catalogCarId);
  const baseTorque = getShowroomSpecTorque(spec, catalogCarId);
  const baseWeight = getShowroomSpecWeight(spec, catalogCarId);
  const selectedPartDelta = summarizeSelectionStats(
    selectedBySlot,
    defaultSelectedBySlot,
    catalog.partsById,
    partOverrideMap,
  );
  const installedEnginePartTotals = summarizeInstalledEnginePartStats(partsXml);
  const dynoDelta = {
    horsepower:
      (hasBoostController ? requestedBoost * 2.4 : 0)
      + (hasAfrController ? requestedAfr * 0.22 : 0),
    torque:
      (hasBoostController ? requestedBoost * 3.1 : 0)
      + (hasAfrController ? requestedAfr * 0.18 : 0),
  };
  const builtHorsepower = Math.max(1, Math.round(baseHorsepower + selectedPartDelta.horsepower + dynoDelta.horsepower));
  const builtTorque = Math.max(1, Math.round(baseTorque + selectedPartDelta.torque + dynoDelta.torque));
  const builtWeight = Math.max(1200, Math.round(baseWeight + selectedPartDelta.weight));
  const performanceStats = {
    horsepower: builtHorsepower,
    torque: builtTorque,
    weight: builtWeight,
  };
  const engineXml = buildDriveableEngineXml({
    catalogCarId,
    gearRatios,
    engineTypeId,
    performanceStats,
  });
  const timing = generateTimingArray(catalogCarId, engineTypeId, performanceStats);
  const carXml = renderOwnedGarageCar(previewCar);
  const dynoGraph = buildDynoGraph({
    catalogCarId,
    engineTypeId,
    gearRatios,
    horsepower: builtHorsepower,
    torque: builtTorque,
  });

  return {
    generatedAt: new Date().toISOString(),
    catalogCarId,
    warnings,
    selectedParts: [...selectedBySlot.entries()]
      .map(([slotId, partId]) => {
        const slot = catalog.slots.find((entry) => entry.id === String(slotId));
        const part = catalog.partsById.get(String(partId));
        if (!part) {
          return null;
        }
        return {
          slotId: String(slotId),
          slotName: slot?.name || `Slot ${slotId}`,
          partId: String(partId),
          partName: part.name,
          overrides: partOverrideMap[String(slotId)] || {},
        };
      })
      .filter(Boolean),
    dyno: {
      boostSetting: requestedBoost,
      chipSetting: requestedAfr,
      shiftLightRpm: requestedShiftLight,
      redLine,
      graph: dynoGraph,
    },
    gearRatios,
    xml: {
      partsXml,
      wheelXml,
      engineXml,
      carXml,
    },
    stats: {
      horsepower: builtHorsepower,
      torque: builtTorque,
      weight: builtWeight,
      baseHorsepower,
      baseTorque,
      baseWeight,
      partHorsepowerDelta: Math.round(selectedPartDelta.horsepower),
      partTorqueDelta: Math.round(selectedPartDelta.torque),
      partWeightDelta: Math.round(selectedPartDelta.weight),
      installedPartHorsepowerTotal: Math.round(installedEnginePartTotals.horsepower),
      installedPartTorqueTotal: Math.round(installedEnginePartTotals.torque),
      installedPartWeightTotal: Math.round(installedEnginePartTotals.weight),
      dynoHorsepowerDelta: Math.round(dynoDelta.horsepower),
      dynoTorqueDelta: Math.round(dynoDelta.torque),
      engine: getEffectiveEngineString(spec.eo, engineTypeId),
      drivetrain: spec.dt,
      transmission: spec.tt,
      redLine,
      engineTypeId,
    },
    timing,
  };
}
