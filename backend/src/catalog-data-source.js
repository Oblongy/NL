import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CATALOG_DIR = path.join(__dirname, "catalog-data");
const PARTS_CATALOG_PATH = path.join(CATALOG_DIR, "parts-catalog.xml");
const PARTS_CATEGORIES_PATH = path.join(CATALOG_DIR, "parts-categories.xml");
const CARS_CATALOG_PATH = path.join(CATALOG_DIR, "cars-catalog.json");
const SHOWROOM_CAR_SPECS_PATH = path.join(CATALOG_DIR, "showroom-car-specs.json");
const SHOWROOM_SPEC_ALIASES_PATH = path.join(CATALOG_DIR, "showroom-spec-aliases.json");
const STOCK_WHEEL_FITMENTS_PATH = path.join(CATALOG_DIR, "stock-wheel-fitments.json");

let cachedPartsCatalogXml = null;
let cachedPartsCategoriesBody = null;
let cachedCarsCatalogEntries = null;
let cachedShowroomCarSpecs = null;
let cachedShowroomSpecAliases = null;
let cachedStockWheelFitments = null;

export function getStaticPartsCatalogXml() {
  if (cachedPartsCatalogXml) {
    return cachedPartsCatalogXml;
  }

  cachedPartsCatalogXml = fs.readFileSync(PARTS_CATALOG_PATH, "utf8").trim();
  return cachedPartsCatalogXml;
}

export function getStaticPartsCategoriesBody() {
  if (cachedPartsCategoriesBody) {
    return cachedPartsCategoriesBody;
  }

  cachedPartsCategoriesBody = fs.readFileSync(PARTS_CATEGORIES_PATH, "utf8").trim();
  return cachedPartsCategoriesBody;
}

export function getStaticCarsCatalogEntries() {
  if (cachedCarsCatalogEntries) {
    return cachedCarsCatalogEntries;
  }

  cachedCarsCatalogEntries = JSON.parse(fs.readFileSync(CARS_CATALOG_PATH, "utf8"));
  return cachedCarsCatalogEntries;
}

export function getStaticShowroomCarSpecs() {
  if (cachedShowroomCarSpecs) {
    return cachedShowroomCarSpecs;
  }

  cachedShowroomCarSpecs = JSON.parse(fs.readFileSync(SHOWROOM_CAR_SPECS_PATH, "utf8"));
  return cachedShowroomCarSpecs;
}

export function getStaticShowroomSpecAliases() {
  if (cachedShowroomSpecAliases) {
    return cachedShowroomSpecAliases;
  }

  cachedShowroomSpecAliases = JSON.parse(fs.readFileSync(SHOWROOM_SPEC_ALIASES_PATH, "utf8"));
  return cachedShowroomSpecAliases;
}

export function getStaticStockWheelFitments() {
  if (cachedStockWheelFitments) {
    return cachedStockWheelFitments;
  }

  cachedStockWheelFitments = JSON.parse(fs.readFileSync(STOCK_WHEEL_FITMENTS_PATH, "utf8"));
  return cachedStockWheelFitments;
}
