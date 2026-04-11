// Hood parts are exterior appearance parts
// Based on the catalog, category 2 is "Exterior Appearance"
// Slot 71 is for hoods

// Let's check if there are any parts in the catalog with both pi='71' and ci attribute
import { PARTS_CATALOG_XML } from "./src/parts-catalog.js";

const hoodParts = [...PARTS_CATALOG_XML.matchAll(/<p[^>]*\bpi='71'[^>]*\/>/g)];
console.log("Hood parts:");
hoodParts.forEach((m, i) => {
  const ciMatch = m[0].match(/ci='([^']*)'/);
  const idMatch = m[0].match(/i='([^']*)'/);
  const nameMatch = m[0].match(/n='([^']*)'/);
  console.log(`${i + 1}. ID: ${idMatch ? idMatch[1] : '?'}, Name: ${nameMatch ? nameMatch[1] : '?'}, ci: ${ciMatch ? ciMatch[1] : 'MISSING'}`);
});

// Check if ANY parts have ci attribute
const partsWithCi = [...PARTS_CATALOG_XML.matchAll(/<p[^>]*\bci='([^']*)'[^>]*\/>/g)];
console.log(`\nTotal parts with ci attribute: ${partsWithCi.length}`);

// Check what t='c' means
const typeCParts = [...PARTS_CATALOG_XML.matchAll(/<p[^>]*\bt='c'[^>]*\/>/g)];
console.log(`\nParts with t='c': ${typeCParts.length}`);
console.log("First 5:");
typeCParts.slice(0, 5).forEach((m, i) => {
  const idMatch = m[0].match(/i='([^']*)'/);
  const nameMatch = m[0].match(/n='([^']*)'/);
  const piMatch = m[0].match(/pi='([^']*)'/);
  console.log(`${i + 1}. ID: ${idMatch ? idMatch[1] : '?'}, Name: ${nameMatch ? nameMatch[1] : '?'}, pi: ${piMatch ? piMatch[1] : '?'}`);
});
