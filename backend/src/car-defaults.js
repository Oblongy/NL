export const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
export const DEFAULT_PAINT_INDEX = 4;
export const DEFAULT_COLOR_CODE = "C0C0C0";
export const DEFAULT_STOCK_PARTS_XML = "";
export const DEFAULT_OWNED_STOCK_WHEEL_XML = "<ws><w wid='1' id='1000' ws='17'/></ws>";

// Catalog car IDs that come with a factory turbo pre-installed.
// Part i=10005 = Blowfish Beast 40 PSI Turbo (pi=87, free, grade C)
const TURBO_CAR_IDS = new Set([
  2, 10, 11, 14, 15, 16, 17, 19, 21, 23, 29, 33, 35, 38, 40, 52, 55, 57,
  87, 88, 89, 91, 92, 109, 111, 112, 123, 124, 125, 127, 128, 137, 138,
  140, 142, 155, 156,
]);

// Part i=81 = Supercharger (pi=81) — cars that come with a factory supercharger
const SUPERCHARGER_CAR_IDS = new Set([
  7, 45, 68, 90, 98, 101, 102, 104, 133,
]);

function makeInstalledPart(i, pi, n, b, bn, mn) {
  const ai = `default${i}`;
  return `<p ai='${ai}' i='${i}' pi='${pi}' t='e' n='${n}' p='0' pp='0' g='C' di='1' pdi='1' b='${b}' bn='${bn}' mn='${mn}' l='100' in='1' mo='0' hp='0' tq='0' wt='0' cc='0' ps=''/>`;
}

export function getDefaultPartsXmlForCar(catalogCarId) {
  const id = Number(catalogCarId || 0);
  if (TURBO_CAR_IDS.has(id)) {
    return makeInstalledPart(10005, 87, 'Blowfish Beast 40 PSI Turbo', 'blowfish', 'Blowfish', 'Beast 40 PSI Turbo');
  }
  if (SUPERCHARGER_CAR_IDS.has(id)) {
    return makeInstalledPart(10005, 87, 'Blowfish Beast 40 PSI Turbo', 'blowfish', 'Blowfish', 'Beast 40 PSI Turbo');
  }
  return DEFAULT_STOCK_PARTS_XML;
}

const LEGACY_BAD_OWNED_WHEEL_PATTERNS = [
  /<w\b[^>]*\bwid='1000'[^>]*\bid='1'[^>]*\bws='17'[^>]*\/?>/i,
  /<w\b[^>]*\bwid='1'[^>]*\bid='1001'[^>]*\bws='17'[^>]*\/?>/i,
];

export function normalizeOwnedWheelXmlValue(value) {
  const wheelXml = String(value || "").trim();
  if (!wheelXml) {
    return DEFAULT_OWNED_STOCK_WHEEL_XML;
  }

  if (LEGACY_BAD_OWNED_WHEEL_PATTERNS.some((pattern) => pattern.test(wheelXml))) {
    return DEFAULT_OWNED_STOCK_WHEEL_XML;
  }

  if (/^<ws[\s>]/i.test(wheelXml)) {
    return wheelXml;
  }

  if (/^<w\b/i.test(wheelXml)) {
    return `<ws>${wheelXml}</ws>`;
  }

  return wheelXml;
}
