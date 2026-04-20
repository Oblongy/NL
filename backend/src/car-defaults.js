import { getStaticPartsCatalogXml } from "./catalog-data-source.js";
import { getShowroomCarInduction } from "./showroom-car-specs.js";

export const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
export const DEFAULT_PAINT_INDEX = 4;
export const DEFAULT_COLOR_CODE = "C0C0C0";
export const DEFAULT_STOCK_PARTS_XML = "";
export const DEFAULT_OWNED_STOCK_WHEEL_XML = "<ws><w wid='1' id='1000' ws='17'/></ws>";

const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)='([^']*)'/g;
const FACTORY_INDUCTION_PART_ID_BY_KIND = Object.freeze({
  T: 10005,
  TT: 269,
  S: 208,
});

let partsCatalogById = null;

function parsePartXmlAttributes(rawEntry) {
  const attrs = {};
  let match;
  while ((match = PART_XML_ATTR_REGEX.exec(rawEntry)) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_XML_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

function getPartsCatalogById() {
  if (partsCatalogById) {
    return partsCatalogById;
  }

  partsCatalogById = new Map();
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(getStaticPartsCatalogXml())) !== null) {
    const attrs = parsePartXmlAttributes(match[0]);
    const id = Number(attrs.i || 0);
    if (id > 0) {
      partsCatalogById.set(id, attrs);
    }
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return partsCatalogById;
}

function buildInstalledCatalogPartXml(catalogPart) {
  if (!catalogPart?.i) {
    return DEFAULT_STOCK_PARTS_XML;
  }

  const attrs = {
    ai: `default${catalogPart.i}`,
    i: catalogPart.i,
    pi: catalogPart.pi || "",
    t: catalogPart.t || "",
    n: catalogPart.n || "",
    p: "0",
    pp: "0",
    g: catalogPart.g || "",
    di: catalogPart.di || "",
    pdi: catalogPart.pdi || catalogPart.di || "",
    b: catalogPart.b || "",
    bn: catalogPart.bn || "",
    mn: catalogPart.mn || "",
    l: catalogPart.l || "100",
    in: "1",
    mo: catalogPart.mo || "0",
    hp: catalogPart.hp || "0",
    tq: catalogPart.tq || "0",
    wt: catalogPart.wt || "0",
    cc: catalogPart.cc || "0",
    ps: catalogPart.ps || "",
  };

  const orderedKeys = ["ai", "i", "pi", "t", "n", "p", "pp", "g", "di", "pdi", "b", "bn", "mn", "l", "in", "mo", "hp", "tq", "wt", "cc", "ps"];
  const serialized = orderedKeys
    .filter((key) => attrs[key] !== "" && attrs[key] !== undefined)
    .map((key) => `${key}='${attrs[key]}'`)
    .join(" ");
  return `<p ${serialized}/>`;
}

export function getDefaultPartsXmlForCar(catalogCarId) {
  const inductionKind = getShowroomCarInduction(catalogCarId);
  const partId = FACTORY_INDUCTION_PART_ID_BY_KIND[inductionKind];
  if (!partId) {
    return DEFAULT_STOCK_PARTS_XML;
  }

  return buildInstalledCatalogPartXml(getPartsCatalogById().get(partId));
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
