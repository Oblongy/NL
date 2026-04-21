import { failureBody, wrapSuccessData, renderOwnedGarageCarsWrapper, escapeXml } from "../game-xml.js";
import { resolveCallerSession } from "../game-actions-helpers.js";
import {
  getPlayerById,
  updatePlayerRecord,
  updatePlayerMoney,
  updatePlayerDefaultCar,
  getCarById,
  deleteCar,
  ensurePlayerHasGarageCar,
  listCarsForPlayer,
  createOwnedCar,
} from "../user-service.js";

/**
 * Car management module
 * Handles car buying, selling, engine info, and car catalog
 */

const DEFAULT_STARTER_CATALOG_CAR_ID = 1;
const DEFAULT_STOCK_WHEEL_XML = "<ws><w wid='1' id='1001' ws='17'/></ws>";
const DEFAULT_STOCK_PARTS_XML = "";

// Full car catalog - only cars with logo SWFs in the 10.0.03 game cache (104 cars)
const FULL_CAR_CATALOG = [
  ["1", "Acura Integra GSR", 24000], ["6", "Acura RSX Type-S", 24000], ["28", "Acura NSX", 140000],
  ["20", "Acura Integra Type R", 30000], ["32", "Acura RSX-S", 26000],
  ["11", "BMW M3", 54000],
  ["7", "Chevy Corvette C6", 45000], ["18", "Chevy Camaro", 25000], ["52", "Chevy Cobalt SS", 20000],
  ["82", "Chevy C-10", 5000], ["100", "Chevy Impala SS", 28000], ["46", "Chevy Camaro SS", 32000],
  ["48", "Chevy Camaro SS", 42000], ["83", "Chevy S-10", 12000], ["34", "Chevy Corvette Z06", 75000],
  ["108", "Chevy Camaro Z28", 35000],
  ["10", "Dodge Viper SRT-10", 80000], ["15", "Dodge Neon SRT-4", 20000],
  ["59", "Dodge Challenger SRT-8", 38000], ["60", "Dodge Charger SRT-8", 35000],
  ["63", "Dodge Challenger R/T", 32000], ["75", "Dodge Charger R/T", 30000],
  ["81", "Dodge Ram SRT-10", 45000], ["97", "Dodge Charger SRT-8", 40000],
  ["109", "Dodge Viper ACR-X", 120000],
  ["103", "Dodge Dart GTS", 18000],
  ["3", "Ford Mustang GT", 30000], ["5", "Ford GT", 150000],
  ["45", "Ford SVT Cobra R", 55000], ["68", "Ford Shelby GT500", 55000],
  ["26", "Ford Mustang Mach 1", 35000], ["71", "Ford Mustang Boss 302", 42000],
  ["8", "Honda Integra Type R", 27000], ["9", "Honda S2000", 33000], ["31", "Honda Civic Si", 18000],
  ["37", "Honda Civic Si", 19000], ["44", "Honda Prelude DOHC VTEC", 22000], ["74", "Honda CR-X Si", 12000],
  ["76", "Honda Civic Si", 20000], ["105", "Honda Civic Type R", 35000], ["29", "Honda Del Sol VTEC", 16000],
  ["30", "Honda Accord Euro R", 25000],
  ["4", "Infiniti G35 Coupe", 32000], ["51", "Infiniti G37S", 38000],
  ["54", "Lexus IS 300", 33000], ["66", "Lexus SC 300", 38000],
  ["57", "Mazda Furai", 500000], ["19", "Mazdaspeed 6 Bergenholtz", 25000], ["23", "Mazdaspeed 3", 20000],
  ["24", "Mazda RX-8", 28000], ["16", "Mazda RX-7", 30000], ["73", "Mazda RX-3", 3000],
  ["107", "Mazda MX-5 Miata", 24000], ["36", "Mazda Speed3", 20000], ["86", "Mazda RX-7 Spirit R", 75000],
  ["2", "Mitsubishi Lancer Evo VIII", 35000], ["87", "Mitsubishi Lancer Evo X", 38000],
  ["88", "Mitsubishi Eclipse GSX", 25000], ["17", "Mitsubishi Eclipse GT", 24000],
  ["27", "Mitsubishi 3000GT VR-4", 40000], ["40", "Mitsubishi Lancer Evo IX", 35000],
  ["104", "Mitsubishi Galant VR-4", 28000],
  ["55", "Nissan 370Z", 35000], ["38", "Nissan Skyline GT-R", 80000], ["35", "Nissan 300ZX", 35000],
  ["47", "Nissan Sentra SE-R", 16000], ["41", "Nissan 240SX", 18000], ["25", "Nissan 350Z", 30000],
  ["21", "Nissan GT-R", 85000], ["39", "Nissan Pulsar NX", 12000], ["42", "Nissan Silvia S15", 25000],
  ["69", "Nissan 180SX", 20000], ["70", "Nissan 240SX Fastback", 18000], ["98", "Nissan Skyline R32 GT-R", 60000],
  ["101", "Nissan GT-R Black Edition", 110000], ["102", "Nissan Leaf", 30000],
  ["110", "Nissan Silvia S13", 18000], ["111", "Nissan Sentra B15", 14000], ["112", "Nissan Altima SE-R", 22000],
  ["79", "Plymouth 'Cuda", 5000], ["80", "Plymouth Road Runner", 4000],
  ["33", "Pontiac Solstice GXP", 25000], ["43", "Pontiac GTO", 33000], ["49", "Pontiac Trans Am", 28000],
  ["50", "Pontiac GTO", 40000], ["56", "Pontiac GTO Judge", 6000], ["85", "Pontiac Firebird Trans Am", 26000],
  ["13", "Scion tC", 17000], ["22", "Scion xB", 15000], ["95", "Scion tC", 18000],
  ["89", "Subaru Impreza WRX STI", 38000], ["92", "Subaru Impreza WRX STI", 36000],
  ["91", "Subaru Impreza WRX STI", 37000], ["12", "Subaru Impreza WRX", 28000],
  ["14", "Toyota Supra", 42000], ["61", "Toyota MR2", 15000],
  ["65", "Toyota Celica GT-S", 19000], ["99", "Toyota Corolla GT-S", 12000],
  ["58", "VW Golf R32", 32000], ["62", "VW Beetle", 18000], ["67", "VW Golf GTI", 22000],
  ["64", "VW Golf GTI", 24000], ["77", "VW Corrado", 20000], ["84", "VW Jetta GLI", 22000],
  ["72", "Buick Grand National", 30000],
  ["53", "Cadillac CTS-V", 60000],
  ["90", "McLaren MP4-12C", 230000],
  ["94", "Honda Fit Sport", 15000],
];

// Location-based tier for showroom filtering
const LOCATION_MAX_PRICE = {
  100: 30000,   // Toreno
  200: 55000,   // Newburge
  300: 90000,   // Creek Side
  400: 175000,  // Vista Heights
  500: 999999,  // Diamond Point – all cars
};

// Dealer categories
const DEALER_CATEGORIES = [
  { i: "1001", pi: "0", n: "Toreno Showroom", cl: "55AACC", l: "100" },
  { i: "1002", pi: "0", n: "Newburge Showroom", cl: "55CC55", l: "200" },
  { i: "1003", pi: "0", n: "Creek Side Showroom", cl: "CCAA55", l: "300" },
  { i: "1004", pi: "0", n: "Vista Heights Showroom", cl: "CC5555", l: "400" },
  { i: "1005", pi: "0", n: "Diamond Point Showroom", cl: "CC55CC", l: "500" },
];

const DEFAULT_DYNO_PURCHASE_STATE = Object.freeze({
  boostSetting: 5,
  maxPsi: 10,
  chipSetting: 0,
  shiftLightRpm: 7200,
  redLine: 7800,
});

function applyTimingDeltas(values, deltas) {
  let currentValue = values[values.length - 1];
  for (const delta of deltas) {
    currentValue += delta;
    values.push(currentValue);
  }
}

// Exact legacy timing curve captured from the original client/server flow.
// Keep it isolated so we can revert the extracted cars module in one place
// without touching the active monolithic timing generation path.
function generateLegacyTimingArray() {
  const values = Array(9).fill(273);

  values.push(375);

  applyTimingDeltas(values, [
    12, 11, 12, 11, 11,
    12, 11, 12, 11, 12,
    11, 12, 11, 12, 11,
    12, 11, 12, 11, 12,
  ]);

  applyTimingDeltas(values, [
    9,
    3, 2, 3, 2, 2,
    3, 2, 3, 2, 3,
    2, 3, 2, 2, 3,
    2, 3, 2, 3, 2,
    2, 3, 2, 3, 2,
    3, 2, 0,
  ]);

  applyTimingDeltas(values, [
    -8, -7,
    -8, -8, -8, -8, -8,
    -8, -8, -8, -8, -8,
    -8, -8, -8, -7,
    -8, -9, -8, -9, -8,
    -9, -9, -8, -9, -8,
    -9, -8, -9, -8, -9,
    -8, -9, -8, -9, -8,
    -9, -8, -9, -8, -9,
  ]);

  if (values.length !== 100) {
    throw new Error(`Expected 100 timing values, got ${values.length}`);
  }

  return values;
}

export function getCatalogCarRecord(catalogCarId) {
  return FULL_CAR_CATALOG.find(([cid]) => Number(cid) === Number(catalogCarId)) || null;
}

export function getCatalogCarName(catalogCarId) {
  return getCatalogCarRecord(catalogCarId)?.[1] || "Unknown";
}

export function getCatalogCarPrice(catalogCarId) {
  const car = FULL_CAR_CATALOG.find(([cid]) => String(cid) === String(catalogCarId));
  return car ? Number(car[2] || 0) : 0;
}

export function getCatalogCarPointPrice(catalogCarId) {
  const moneyPrice = getCatalogCarPrice(catalogCarId);
  if (moneyPrice <= 0) {
    return -1;
  }
  return Math.max(1, Math.round(moneyPrice / 1000));
}

export function parseShowroomPurchaseCatalogCarId(params) {
  return Number(
    params.get("acid")
    || params.get("ci")
    || params.get("cid")
    || params.get("carid")
    || params.get("id")
    || 0,
  );
}

export function parseShowroomPurchasePrice(params) {
  return Number(
    params.get("pr")
    || params.get("price")
    || params.get("cp")
    || 0,
  );
}

// Note: decorateCarsWithTestDriveState is in showroom module
// This is a temporary stub until showroom module is extracted
function decorateCarsWithTestDriveState(playerId, cars) {
  return cars;
}

export async function handleGetAllCars(context) {
  const { supabase, logger } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getallcars");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getallcars:bad-session" };
  }

  const cars = await ensurePlayerHasGarageCar(supabase, caller.playerId, {
    catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
    partsXml: DEFAULT_STOCK_PARTS_XML,
  });
  const garageCars = decorateCarsWithTestDriveState(caller.playerId, cars);

  logger?.info("GetAllCars returning cars", {
    count: garageCars.length,
    carIds: garageCars.map(c => c.game_car_id),
    partsXmlLengths: garageCars.map(c => c.parts_xml?.length || 0)
  });

  return {
    body: wrapSuccessData(renderOwnedGarageCarsWrapper(garageCars, { ownerPublicId: caller.publicId })),
    source: "supabase:getallcars",
  };
}

export async function handleGetOneCarEngine(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getonecarengine");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getonecarengine:bad-session",
      };
    }

    const car = await getCarById(supabase, accountCarId);
    if (car) {
      const partsXml = car.parts_xml || "";
      const pistonMatch = partsXml.match(/<p[^>]*\bci='190'[^>]*\bdi='(\d+)'[^>]*\/>/i);
      const compressionLevel = pistonMatch ? Number(pistonMatch[1]) : 0;

      const timing = generateLegacyTimingArray();

      const engineXml =
        `<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.2398523985239853' ` +
        `a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='${compressionLevel}' e='0' d='T' ` +
        `f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' ` +
        `m='100' t='100' u='28' w='0.4607' x='63.98' y='506.71' z='92.13' ` +
        `aa='4' ab='${accountCarId}' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
        `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
        `at='100' au='100' av='0' aw='100' ax='0'/>`;

      return {
        body: `"s", 1, "d", "${engineXml}", "t", [${timing.join(', ')}]`,
        source: "generated:getonecarengine",
      };
    }
  }

  const timing = generateLegacyTimingArray();

  const engineXml =
    `<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.2398523985239853' ` +
    `a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='0' e='0' d='T' ` +
    `f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' ` +
    `m='100' t='100' u='28' w='0.4607' x='63.98' y='506.71' z='92.13' ` +
    `aa='4' ab='${accountCarId}' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
    `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
    `at='100' au='100' av='0' aw='100' ax='0'/>`;

  return {
    body: `"s", 1, "d", "${engineXml}", "t", [${timing.join(', ')}]`,
    source: "generated:getonecarengine",
  };
}

export async function handleBuyDyno(context) {
  const { supabase } = context;

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buydyno");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buydyno:bad-session" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buydyno:no-player" };
  }

  if (player.has_dyno === 1 || player.has_dyno === true) {
    return {
      body:
        `"s", 1, "b", ${player.money}, ` +
        `"bs", ${DEFAULT_DYNO_PURCHASE_STATE.boostSetting}, ` +
        `"mp", ${DEFAULT_DYNO_PURCHASE_STATE.maxPsi}, ` +
        `"cs", ${DEFAULT_DYNO_PURCHASE_STATE.chipSetting}, ` +
        `"sl", ${DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm}, ` +
        `"rl", ${DEFAULT_DYNO_PURCHASE_STATE.redLine}`,
      source: "supabase:buydyno:already-owned",
    };
  }

  const dynoPrice = 500;
  const newBalance = Number(player.money) - dynoPrice;

  if (newBalance < 0) {
    return { body: `"s", -2`, source: "supabase:buydyno:insufficient-funds" };
  }

  try {
    await updatePlayerRecord(supabase, caller.playerId, { money: newBalance, hasDyno: 1 });
  } catch (error) {
    console.error("Failed to update dyno ownership:", error);
    return { body: failureBody(), source: "supabase:buydyno:update-failed" };
  }

  return {
    body:
      `"s", 1, "b", ${newBalance}, ` +
      `"bs", ${DEFAULT_DYNO_PURCHASE_STATE.boostSetting}, ` +
      `"mp", ${DEFAULT_DYNO_PURCHASE_STATE.maxPsi}, ` +
      `"cs", ${DEFAULT_DYNO_PURCHASE_STATE.chipSetting}, ` +
      `"sl", ${DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm}, ` +
      `"rl", ${DEFAULT_DYNO_PURCHASE_STATE.redLine}`,
    source: "supabase:buydyno",
  };
}

export async function handleBuyCar(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buycar");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buycar:bad-session" };
  }

  const catalogCarId = parseShowroomPurchaseCatalogCarId(params);
  if (!catalogCarId) {
    return { body: failureBody(), source: "supabase:buycar:missing-car" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buycar:no-player" };
  }

  const purchasePrice = parseShowroomPurchasePrice(params) || getCatalogCarPrice(catalogCarId);
  const newBalance = Number(player.money) - purchasePrice;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buycar:insufficient-funds" };
  }

  const selectedColor = String(params.get("cc") || params.get("c") || "C0C0C0")
    .replace(/[^0-9A-F]/gi, "")
    .toUpperCase()
    .slice(0, 6) || "C0C0C0";

  const createdCar = await createOwnedCar(supabase, {
    playerId: caller.playerId,
    catalogCarId,
    selected: true,
    paintIndex: 4,
    plateName: "",
    colorCode: selectedColor,
    partsXml: DEFAULT_STOCK_PARTS_XML,
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
  });

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${createdCar.game_car_id}'/>", "d", "<r s='1' b='0'></r>"`,
    source: "supabase:buycar",
  };
}

export async function handleUpdateDefaultCar(context) {
  const { supabase, params } = context;
  const gameCarId = Number(params.get("acid") || params.get("cid") || 0);

  if (!gameCarId) {
    return { body: failureBody(), source: "updatedefaultcar:missing-params" };
  }

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:updatedefaultcar");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:updatedefaultcar:bad-session",
    };
  }

  const car = await getCarById(supabase, gameCarId);
  if (!car || Number(car.player_id) !== caller.playerId) {
    return { body: failureBody(), source: "supabase:updatedefaultcar:invalid-car" };
  }

  await updatePlayerDefaultCar(supabase, caller.playerId, gameCarId);

  return {
    body: `"s", 1`,
    source: "supabase:updatedefaultcar",
  };
}

export async function handleSellCar(context) {
  const { supabase, params } = context;

  if (!supabase) {
    return { body: `"s", 1`, source: "stub:sellcar:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:sellcar");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:sellcar:bad-session" };
  }

  const gameCarId = Number(params.get("acid") || params.get("cid") || 0);
  const salePrice = Number(params.get("pr") || params.get("price") || 0);

  if (gameCarId) {
    const car = await getCarById(supabase, gameCarId);
    if (car && Number(car.player_id) === caller.playerId) {
      const player = await getPlayerById(supabase, caller.playerId);
      const newBalance = Number(player?.money ?? 0) + salePrice;
      await updatePlayerMoney(supabase, caller.playerId, newBalance);
      await deleteCar(supabase, gameCarId);
      return {
        body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='0'/>", "d", "<r s='1' b='0'/>"`,
        source: "supabase:sellcar",
      };
    }
  }

  return { body: `"s", 1`, source: "stub:sellcar" };
}

export async function handleGetCarCategories(context) {
  const catNodes = DEALER_CATEGORIES
    .map((c) => `<c i='${c.i}' pi='${c.pi}' c='0' p='0' n='${escapeXml(c.n)}' cl='${c.cl}' l='${c.l}'/>`)
    .join("");
  return {
    body: wrapSuccessData(`<cats>${catNodes}</cats>`),
    source: "stub:getcarcategories",
  };
}
