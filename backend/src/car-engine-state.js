import { getDefaultPartsXmlForCar } from "./car-defaults.js";
import { getShowroomCarInduction } from "./showroom-car-specs.js";

export const ENGINE_TYPE_IDS = Object.freeze({
  NATURAL: 1,
  TURBO: 2,
  SUPERCHARGER: 3,
});

const TURBO_PART_REGEX = /<p[^>]*\b(?:ci|pi)=["']87["'][^>]*\/>/i;
const SUPERCHARGER_PART_REGEX = /<p[^>]*\b(?:ci|pi)=["']81["'][^>]*\/>/i;

function detectBoostTypeFromPartsXml(partsXml) {
  const xml = String(partsXml || "");
  if (!xml) {
    return "0";
  }

  if (TURBO_PART_REGEX.test(xml)) {
    return "T";
  }
  if (SUPERCHARGER_PART_REGEX.test(xml)) {
    return "S";
  }
  return "0";
}

export function getEngineTypeIdFromBoostType(boostType) {
  if (boostType === "S") {
    return ENGINE_TYPE_IDS.SUPERCHARGER;
  }
  if (boostType === "T" || boostType === "TT") {
    return ENGINE_TYPE_IDS.TURBO;
  }
  return ENGINE_TYPE_IDS.NATURAL;
}

export function getBoostTypeFromEngineTypeId(engineTypeId) {
  if (Number(engineTypeId) === ENGINE_TYPE_IDS.SUPERCHARGER) {
    return "S";
  }
  if (Number(engineTypeId) === ENGINE_TYPE_IDS.TURBO) {
    return "T";
  }
  return "0";
}

export function getEngineTypeIdForCatalogCar(catalogCarId) {
  const defaultPartsXml = getDefaultPartsXmlForCar(catalogCarId);
  const defaultBoostType = detectBoostTypeFromPartsXml(defaultPartsXml);
  if (defaultBoostType !== "0") {
    return getEngineTypeIdFromBoostType(defaultBoostType);
  }

  return getEngineTypeIdFromBoostType(getShowroomCarInduction(catalogCarId));
}

export function getEngineTypeIdForCar(car) {
  const explicitEngineTypeId = Number(car?.engine_type_id || car?.owned_engine?.engine_type_id || 0);
  if (explicitEngineTypeId > 0) {
    return explicitEngineTypeId;
  }

  const partsBoostType = detectBoostTypeFromPartsXml(car?.parts_xml || "");
  if (partsBoostType !== "0") {
    return getEngineTypeIdFromBoostType(partsBoostType);
  }

  return getEngineTypeIdForCatalogCar(car?.catalog_car_id);
}

export function getBoostTypeForCar(car) {
  return getBoostTypeFromEngineTypeId(getEngineTypeIdForCar(car));
}

export function getCarEngineIdentity(car) {
  const ownedEngineId = Number(car?.owned_engine_id || car?.installed_engine_id || car?.owned_engine?.id || 0);
  return {
    ae: ownedEngineId || Number(car?.account_car_id || car?.game_car_id || 0),
    et: getEngineTypeIdForCar(car),
  };
}

function stripInductionFromEngineString(engineStr) {
  return String(engineStr || "")
    .replace(/\bTwin[- ]Turbo\b/gi, "")
    .replace(/\bSupercharged\b/gi, "")
    .replace(/\bTurbocharged\b/gi, "")
    .replace(/\bTurbo\b/gi, "")
    .replace(/\bTT\b/gi, "")
    .replace(/\bSC\b/gi, "")
    .replace(/\bT\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getEffectiveEngineString(engineStr, engineTypeId) {
  const rawEngine = String(engineStr || "").trim();
  if (!rawEngine) {
    return "";
  }
  if (engineTypeId === null || engineTypeId === undefined || engineTypeId === "") {
    return rawEngine;
  }

  const baseEngine = stripInductionFromEngineString(rawEngine) || rawEngine;
  if (Number(engineTypeId) === ENGINE_TYPE_IDS.SUPERCHARGER) {
    return `${baseEngine} Supercharged`;
  }
  if (Number(engineTypeId) === ENGINE_TYPE_IDS.TURBO) {
    return /\b(rotary|rotor)\b/i.test(baseEngine)
      ? `${baseEngine} Twin Turbo`
      : `${baseEngine} Turbo`;
  }
  return baseEngine;
}
