import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CATALOG_DIR = path.join(__dirname, "catalog-data");
const PARTS_CATALOG_PATH = path.join(CATALOG_DIR, "parts-catalog.xml");
const CARS_CATALOG_PATH = path.join(CATALOG_DIR, "cars-catalog.json");

let cachedPartsCatalogXml = null;
let cachedCarsCatalogEntries = null;

export function getFixturePartsCatalogXml() {
  if (cachedPartsCatalogXml) {
    return cachedPartsCatalogXml;
  }

  cachedPartsCatalogXml = fs.readFileSync(PARTS_CATALOG_PATH, "utf8").trim();
  return cachedPartsCatalogXml;
}

export function getFixtureCarsCatalogEntries() {
  if (cachedCarsCatalogEntries) {
    return cachedCarsCatalogEntries;
  }

  cachedCarsCatalogEntries = JSON.parse(fs.readFileSync(CARS_CATALOG_PATH, "utf8"));
  return cachedCarsCatalogEntries;
}
