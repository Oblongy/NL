import {
  getStaticShowroomCarSpecs,
  getStaticShowroomSpecAliases,
} from "./catalog-data-source.js";

const SHOWROOM_SPEC_ALIASES = new Map(
  Object.entries(getStaticShowroomSpecAliases()).map(([carId, specId]) => [
    String(carId),
    String(specId),
  ]),
);

function normalizeEngineString(engine) {
  return String(engine || "").trim().toLowerCase();
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeShowroomCarSpec(carId, rawSpec) {
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new Error(`Invalid showroom spec payload for catalog car ${carId}`);
  }

  const spec = {
    y: String(rawSpec.y || "").trim(),
    eo: String(rawSpec.eo || "").trim(),
    dt: String(rawSpec.dt || "").trim().toUpperCase(),
    np: String(rawSpec.np || "").trim(),
    ct: String(rawSpec.ct || "").trim(),
    et: String(rawSpec.et || "").trim(),
    tt: String(rawSpec.tt || "").trim(),
    sw: String(rawSpec.sw || "").trim(),
    st: String(rawSpec.st || "").trim(),
  };
  const hp = parsePositiveNumber(rawSpec.hp);
  const tq = parsePositiveNumber(rawSpec.tq);

  for (const [field, value] of Object.entries(spec)) {
    if (!value) {
      throw new Error(`Missing showroom spec field ${field} for catalog car ${carId}`);
    }
  }

  if (!parsePositiveNumber(spec.sw)) {
    throw new Error(`Invalid showroom weight for catalog car ${carId}`);
  }
  if (!parsePositiveNumber(spec.st)) {
    throw new Error(`Invalid showroom ET for catalog car ${carId}`);
  }

  const hpMatch = spec.et.match(/^([\d.]+)/);
  if (!hp && !hpMatch) {
    throw new Error(`Missing showroom horsepower for catalog car ${carId}`);
  }

  return Object.freeze({
    ...spec,
    ...(hp ? { hp } : {}),
    ...(tq ? { tq } : {}),
  });
}

function buildShowroomCarSpecs() {
  const rawSpecs = getStaticShowroomCarSpecs();
  const map = new Map();

  for (const [carId, rawSpec] of Object.entries(rawSpecs)) {
    map.set(String(carId), normalizeShowroomCarSpec(carId, rawSpec));
  }

  return map;
}

export const SHOWROOM_CAR_SPECS = buildShowroomCarSpecs();

export function getShowroomCarSpec(carId) {
  const normalizedCarId = String(carId || "");
  const aliasedSpecId = SHOWROOM_SPEC_ALIASES.get(normalizedCarId) || "";
  return (
    SHOWROOM_CAR_SPECS.get(normalizedCarId) ||
    SHOWROOM_CAR_SPECS.get(aliasedSpecId) ||
    null
  );
}

export function hasShowroomCarSpec(carId) {
  return !!getShowroomCarSpec(carId);
}

export function getShowroomCarInduction(carId) {
  const engine = normalizeEngineString(getShowroomCarSpec(carId)?.eo);
  if (!engine) {
    return "0";
  }

  if (engine.includes("supercharged") || /\bsc\b/.test(engine)) {
    return "S";
  }

  if (engine.includes("twin turbo") || /\btt\b/.test(engine)) {
    return "TT";
  }

  if (engine.includes("turbo") || /\bt\b/.test(engine)) {
    return "T";
  }

  return "0";
}

export function getShowroomCarBoostType(carId) {
  const induction = getShowroomCarInduction(carId);
  if (induction === "S") {
    return "S";
  }
  if (induction === "0") {
    return "0";
  }
  return "T";
}
