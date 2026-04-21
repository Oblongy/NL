import { getStaticPartsCatalogXml, getStaticStockWheelFitments } from "./catalog-data-source.js";
import { getShowroomCarInduction } from "./showroom-car-specs.js";

export const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
export const DEFAULT_PAINT_INDEX = 4;
export const DEFAULT_COLOR_CODE = "C0C0C0";
export const DEFAULT_STOCK_PARTS_XML = "";
export const DEFAULT_OWNED_STOCK_WHEEL_XML = "<ws><w wid='1' id='1000' ws='17'/></ws>";
const DEFAULT_STOCK_WHEEL_FITMENT = Object.freeze({
  kind: "stock",
  size: 17,
});
const STOCK_WHEEL_KIND_META = Object.freeze({
  stock: Object.freeze({ designId: "1", partId: "1000", label: "Stock" }),
  factory: Object.freeze({ designId: "2", partId: "1003", label: "Factory" }),
});

const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)='([^']*)'/g;
const FACTORY_INDUCTION_PART_ID_BY_KIND = Object.freeze({
  T: 10005,
  TT: 269,
  S: 208,
});
const DEFAULT_SHOWROOM_VISIBLE_PARTS_BY_CAR_ID = Object.freeze({
  4: Object.freeze([
    Object.freeze({ categoryId: 13, designId: 1, partSize: "10", name: "Stock Tires" }),
    Object.freeze({ categoryId: 71, designId: 1, name: "Stock Hood" }),
    Object.freeze({ categoryId: 76, designId: 1, name: "Stock Headlights" }),
    Object.freeze({ categoryId: 77, designId: 1, name: "Stock Tail Lights" }),
    Object.freeze({ categoryId: 128, designId: 1, name: "Stock Front Bumper" }),
    Object.freeze({ categoryId: 129, designId: 1, name: "Stock Side Skirts" }),
    Object.freeze({ categoryId: 130, designId: 1, name: "Stock Rear Bumper" }),
    Object.freeze({ categoryId: 140, designId: 1, name: "Stock Grille" }),
  ]),
  6: Object.freeze([
    Object.freeze({ categoryId: 13, designId: 1, partSize: "10", name: "Stock Tires" }),
    Object.freeze({ categoryId: 65, designId: 1, name: "Stock Spoiler" }),
    Object.freeze({ categoryId: 71, designId: 1, name: "Stock Hood" }),
    Object.freeze({ categoryId: 76, designId: 1, name: "Stock Headlights" }),
    Object.freeze({ categoryId: 77, designId: 1, name: "Stock Tail Lights" }),
    Object.freeze({ categoryId: 128, designId: 1, name: "Stock Front Bumper" }),
    Object.freeze({ categoryId: 129, designId: 1, name: "Stock Side Skirts" }),
    Object.freeze({ categoryId: 130, designId: 1, name: "Stock Rear Bumper" }),
    Object.freeze({ categoryId: 140, designId: 1, name: "Stock Grille" }),
  ]),
});

let partsCatalogById = null;
let stockWheelFitmentsByCarId = null;

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

function normalizeStockWheelFitment(carId, rawFitment) {
  if (!rawFitment || typeof rawFitment !== "object" || Array.isArray(rawFitment)) {
    throw new Error(`Invalid stock wheel fitment for catalog car ${carId}`);
  }

  const kind = String(rawFitment.kind || "").trim().toLowerCase();
  const size = Number(rawFitment.size);
  if (!Object.hasOwn(STOCK_WHEEL_KIND_META, kind)) {
    throw new Error(`Invalid stock wheel kind for catalog car ${carId}`);
  }
  if (!Number.isInteger(size) || size < 14 || size > 22) {
    throw new Error(`Invalid stock wheel size for catalog car ${carId}`);
  }

  return Object.freeze({ kind, size });
}

function getStockWheelFitmentsByCarId() {
  if (stockWheelFitmentsByCarId) {
    return stockWheelFitmentsByCarId;
  }

  stockWheelFitmentsByCarId = new Map();
  for (const [carId, rawFitment] of Object.entries(getStaticStockWheelFitments())) {
    stockWheelFitmentsByCarId.set(String(carId), normalizeStockWheelFitment(carId, rawFitment));
  }

  return stockWheelFitmentsByCarId;
}

function buildWheelXmlFromFitment(fitment) {
  const meta = STOCK_WHEEL_KIND_META[fitment.kind] || STOCK_WHEEL_KIND_META.stock;
  return `<ws><w wid='${meta.designId}' id='${meta.partId}' ws='${fitment.size}'/></ws>`;
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

function buildSyntheticVisiblePartXml(catalogCarId, entry, index) {
  const categoryId = Number(entry?.categoryId || 0);
  const designId = String(entry?.designId || 1);
  if (!categoryId) {
    return "";
  }

  const syntheticPartId = 900000 + Number(catalogCarId || 0) * 100 + Number(index || 0);
  const attrs = {
    ai: `stock${catalogCarId}_${categoryId}`,
    i: syntheticPartId,
    ci: categoryId,
    pt: "c",
    n: entry?.name || `Stock Part ${categoryId}`,
    p: "0",
    pp: "0",
    g: "C",
    di: designId,
    pdi: designId,
    b: "setup",
    bn: "Setup",
    mn: entry?.name || `Stock Part ${categoryId}`,
    l: "100",
    in: "1",
    mo: "0",
    hp: "0",
    tq: "0",
    wt: "0",
    cc: "",
    ps: entry?.partSize || "",
  };

  const orderedKeys = ["ai", "i", "ci", "pt", "n", "p", "pp", "g", "di", "pdi", "b", "bn", "mn", "l", "in", "mo", "hp", "tq", "wt", "cc", "ps"];
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

export function getDefaultShowroomPartsXmlForCar(catalogCarId) {
  const visibleParts = DEFAULT_SHOWROOM_VISIBLE_PARTS_BY_CAR_ID[String(catalogCarId || "")] || [];
  const visiblePartsXml = visibleParts
    .map((entry, index) => buildSyntheticVisiblePartXml(catalogCarId, entry, index + 1))
    .join("");
  const defaultPerformancePartsXml = getDefaultPartsXmlForCar(catalogCarId);

  return `${visiblePartsXml}${defaultPerformancePartsXml}`;
}

export function getDefaultWheelFitmentForCar(catalogCarId) {
  const explicitFitment = getStockWheelFitmentsByCarId().get(String(catalogCarId || ""));
  const fitment = explicitFitment || DEFAULT_STOCK_WHEEL_FITMENT;
  const meta = STOCK_WHEEL_KIND_META[fitment.kind] || STOCK_WHEEL_KIND_META.stock;

  return Object.freeze({
    kind: fitment.kind,
    size: String(fitment.size),
    designId: meta.designId,
    partId: meta.partId,
    label: meta.label,
  });
}

export function getDefaultWheelXmlForCar(catalogCarId) {
  return buildWheelXmlFromFitment(getDefaultWheelFitmentForCar(catalogCarId));
}

const LEGACY_BAD_OWNED_WHEEL_PATTERNS = [
  /<w\b[^>]*\bwid='1000'[^>]*\bid='1'[^>]*\bws='17'[^>]*\/?>/i,
  /<w\b[^>]*\bwid='1'[^>]*\bid='1000'[^>]*\bws='17'[^>]*\/?>/i,
  /<w\b[^>]*\bwid='1'[^>]*\bid='1001'[^>]*\bws='17'[^>]*\/?>/i,
];

export function normalizeOwnedWheelXmlValue(value, catalogCarId = 0) {
  const wheelXml = String(value || "").trim();
  const defaultWheelXml = getDefaultWheelXmlForCar(catalogCarId);
  if (!wheelXml) {
    return defaultWheelXml;
  }

  if (LEGACY_BAD_OWNED_WHEEL_PATTERNS.some((pattern) => pattern.test(wheelXml))) {
    return defaultWheelXml;
  }

  if (/^<ws[\s>]/i.test(wheelXml)) {
    return wheelXml;
  }

  if (/^<w\b/i.test(wheelXml)) {
    return `<ws>${wheelXml}</ws>`;
  }

  return wheelXml;
}
