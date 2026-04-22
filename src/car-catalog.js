import { escapeXml } from "./game-xml.js";
import { getStaticCarsCatalogEntries } from "./catalog-data-source.js";

const BASE_CAR_PRICES = [
  ["1", 24000], ["2", 35000], ["3", 30000], ["4", 32000], ["5", 150000],
  ["6", 24000], ["7", 45000], ["8", 27000], ["9", 33000], ["10", 80000],
  ["11", 54000], ["12", 28000], ["13", 17000], ["14", 42000], ["15", 20000],
  ["16", 30000], ["17", 24000], ["18", 25000], ["19", 25000], ["20", 30000],
  ["21", 85000], ["22", 15000], ["23", 20000], ["24", 28000], ["25", 30000],
  ["26", 35000], ["27", 40000], ["28", 140000], ["29", 16000], ["30", 25000],
  ["31", 18000], ["32", 26000], ["33", 25000], ["34", 75000], ["35", 35000],
  ["36", 20000], ["37", 19000], ["38", 80000], ["39", 12000], ["40", 35000],
  ["41", 18000], ["42", 25000], ["43", 33000], ["44", 22000], ["45", 55000],
  ["46", 32000], ["47", 16000], ["48", 42000], ["49", 28000], ["50", 40000],
  ["51", 38000], ["52", 20000], ["53", 60000], ["54", 33000], ["55", 35000],
  ["56", 6000], ["57", 500000], ["58", 32000], ["59", 38000], ["60", 35000],
  ["61", 15000], ["62", 18000], ["63", 32000], ["64", 24000], ["65", 19000],
  ["66", 38000], ["67", 22000], ["68", 55000], ["69", 20000], ["70", 18000],
  ["71", 42000], ["72", 30000], ["73", 3000], ["74", 12000], ["75", 30000],
  ["76", 20000], ["77", 20000], ["78", 35000], ["79", 5000], ["80", 4000],
  ["81", 45000], ["82", 5000], ["83", 12000], ["84", 22000], ["85", 26000],
  ["86", 75000], ["87", 38000], ["88", 25000], ["89", 38000], ["90", 230000],
  ["91", 37000], ["92", 36000], ["93", 11000], ["94", 15000], ["95", 18000],
  ["96", 90000], ["97", 40000], ["98", 60000], ["99", 12000], ["100", 28000],
  ["101", 110000], ["102", 30000], ["103", 18000], ["104", 28000], ["105", 35000],
  ["106", 14000], ["107", 24000], ["108", 35000], ["109", 120000], ["110", 18000],
  ["111", 14000], ["112", 22000], ["113", 26000], ["114", 22000], ["115", 20000],
  ["116", 23000], ["117", 4000], ["118", 4500], ["119", 6000], ["120", 18000],
  ["121", 28000], ["122", 8000], ["123", 42000], ["124", 90000], ["125", 100000],
  ["126", 5000], ["127", 30000], ["128", 28000], ["129", 40000], ["130", 27000],
  ["131", 55000], ["132", 50000], ["133", 375000], ["134", 6000], ["135", 180000],
  ["136", 175000], ["137", 20000], ["138", 20000], ["139", 14000], ["140", 150000],
  ["141", 200000], ["142", 22000], ["143", 35000], ["144", 4000], ["145", 4000],
  ["146", 22000], ["147", 25000], ["148", 5000], ["149", 30000], ["150", 2000],
  ["153", 0], ["155", 0], ["156", 0], ["158", 0], ["159", 0], ["160", 0],
];

// The canonical 10.0.03 login payload reuses many legacy car IDs for special
// edition dealership stock. Those IDs cannot keep the original base-car prices
// (for example id 29 is "Acura NSX Race Edition" in the captured 10.0.03 cars
// list, not the old Del Sol). Normalize the affected showroom prices here so
// Diamond Point / Vista Heights no longer expose obviously invalid pricing.
const SPECIAL_SHOWROOM_PRICE_OVERRIDES = new Map([
  ["26", 1500000],  // Royal Purple Nissan Z
  ["29", 1600000],  // Acura NSX Race Edition
  ["42", 16500000],  // Royal Purple ZR1
  ["66", 180000],  // Supercharged ZR1
  ["86", 145000],  // Drag Spec Camaro
  ["102", 325000], // SLR McLaren LE II
  ["104", 1200000], // SEMA Series Challenger
  ["111", 1800000], // STI Year of the Dragon
  ["112", 2000000], // STI Year of the Dragon II
  ["121", 5000],  // Box
  ["123", 500000], // McLaren F1 GTR
  ["129", 55000],  // Ram SRT-10
  ["133", 950000],  // Scion FR-S Widebody
  ["146", 650000],  // Ford Deuce Coupe Gold
  ["147", 850000],  // Ford Deuce Coupe Champion
  ["158", 2400000], // RWB Stella
]);

const priceByCarId = new Map(BASE_CAR_PRICES);
for (const [carId, price] of SPECIAL_SHOWROOM_PRICE_OVERRIDES.entries()) {
  priceByCarId.set(carId, price);
}

export const FULL_CAR_CATALOG = getStaticCarsCatalogEntries().map(({ id, name, locationId }) => [
  id,
  name,
  priceByCarId.get(id) ?? 0,
  locationId,
  id === '18' ? 100 : undefined,
]);

export function getCatalogCarPrice(catalogCarId) {
  const needle = String(catalogCarId || "").trim();
  if (!needle) return 0;

  const car = FULL_CAR_CATALOG.find(([id]) => String(id) === needle);
  return car ? Number(car[2] || 0) : 0;
}

export function buildStaticCarsXml() {
  const nodes = FULL_CAR_CATALOG
    .map(([id, name, , locationId]) => `<c id='${id}' c='${escapeXml(name)}' l='${locationId}'/>`)
    .join("");

  return `<n id='cars'>${nodes}</n>`;
}
