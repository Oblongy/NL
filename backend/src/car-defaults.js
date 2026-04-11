export const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
export const DEFAULT_PAINT_INDEX = 4;
export const DEFAULT_COLOR_CODE = "C0C0C0";
export const DEFAULT_STOCK_PARTS_XML = "";
export const DEFAULT_OWNED_STOCK_WHEEL_XML = "<ws><w wid='1' id='1000' ws='17'/></ws>";

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
