import {
  DEFAULT_COLOR_CODE,
  DEFAULT_OWNED_STOCK_WHEEL_XML,
  DEFAULT_PAINT_INDEX,
  DEFAULT_STARTER_CATALOG_CAR_ID,
  DEFAULT_STOCK_PARTS_XML,
  getDefaultWheelXmlForCar,
} from "../car-defaults.js";
import {
  buildClearedTestDrivePatch,
  buildOwnedCarInsert,
  buildOwnedCarPatch,
  parseOwnedCarRecord,
} from "../db-models.js";
import {
  isMissingGameCarIdError,
  isMissingTestDriveColumnError,
  manyResult,
  maybeSingle,
  singleResult,
  sortByRequestedOrder,
  toNumericIds,
} from "./shared.js";
import { updatePlayerDefaultCar, updatePlayerRecord } from "./players.js";
import { attachOwnedEnginesToCars } from "./engines.js";

export const normalizeOwnedCarRecord = parseOwnedCarRecord;

function getLegacyCarPatch(car) {
  const normalizedCar = parseOwnedCarRecord(car);
  const patch = {};

  if (normalizedCar.catalog_car_id && normalizedCar.catalog_car_id !== Number(car.catalog_car_id || 0)) {
    patch.catalog_car_id = normalizedCar.catalog_car_id;
  }

  if (normalizedCar.wheel_xml !== String(car.wheel_xml || "")) {
    patch.wheel_xml = normalizedCar.wheel_xml;
  }

  if (normalizedCar.parts_xml !== String(car.parts_xml || "")) {
    patch.parts_xml = normalizedCar.parts_xml;
  }

  return buildOwnedCarPatch(patch);
}

async function getNextExplicitGameCarId(supabase) {
  const cars = await manyResult(
    supabase
      .from("game_cars")
      .select("game_car_id"),
  );

  return cars.reduce((maxId, row) => Math.max(maxId, Number(row?.game_car_id || 0)), 0) + 1;
}

async function insertGameCarCompat(supabase, insert) {
  try {
    return await singleResult(
      supabase.from("game_cars").insert(insert).select("*"),
      parseOwnedCarRecord,
    );
  } catch (error) {
    if (!isMissingGameCarIdError(error)) {
      throw error;
    }

    const compatInsert = {
      ...insert,
      game_car_id: await getNextExplicitGameCarId(supabase),
    };
    return singleResult(
      supabase.from("game_cars").insert(compatInsert).select("*"),
      parseOwnedCarRecord,
    );
  }
}

async function repairLegacyCars(supabase, cars) {
  if (!supabase || !cars.length) {
    return cars.map((car) => parseOwnedCarRecord(car));
  }

  const repairedCars = [];
  for (const car of cars) {
    const patch = getLegacyCarPatch(car);
    if (Object.keys(patch).length > 0) {
      repairedCars.push(await singleResult(
        supabase
          .from("game_cars")
          .update(patch)
          .eq("game_car_id", Number(car.game_car_id))
          .select("*"),
        parseOwnedCarRecord,
      ));
      continue;
    }

    repairedCars.push(parseOwnedCarRecord(car));
  }

  return repairedCars;
}

async function maybeAttachOwnedEngines(supabase, cars, includeOwnedEngines = true) {
  if (!includeOwnedEngines) {
    return cars;
  }
  return attachOwnedEnginesToCars(supabase, cars);
}

export async function createStarterCar(
  supabase,
  {
    playerId,
    catalogCarId = DEFAULT_STARTER_CATALOG_CAR_ID,
    plateName = "",
    colorCode = DEFAULT_COLOR_CODE,
    paintIndex = DEFAULT_PAINT_INDEX,
    wheelXml = DEFAULT_OWNED_STOCK_WHEEL_XML,
    partsXml = DEFAULT_STOCK_PARTS_XML,
  } = {},
) {
  if (!supabase || !playerId) {
    return null;
  }

  const insert = buildOwnedCarInsert({
    playerId,
    catalogCarId,
    selected: true,
    paintIndex,
    plateName,
    colorCode,
    partsXml,
    wheelXml,
  });

  const car = await insertGameCarCompat(supabase, insert);
  await updatePlayerRecord(supabase, playerId, { defaultCarGameId: car.game_car_id });
  return car;
}

export async function createOwnedCar(
  supabase,
  {
    playerId,
    catalogCarId,
    selected = false,
    plateName = "",
    colorCode = DEFAULT_COLOR_CODE,
    paintIndex = DEFAULT_PAINT_INDEX,
    wheelXml = DEFAULT_OWNED_STOCK_WHEEL_XML,
    partsXml = DEFAULT_STOCK_PARTS_XML,
    testDriveInvitationId = null,
    testDriveName = "",
    testDriveMoneyPrice = null,
    testDrivePointPrice = null,
    testDriveExpiresAt = null,
  } = {},
) {
  if (!supabase || !playerId || !catalogCarId) {
    return null;
  }

  const insert = buildOwnedCarInsert({
    playerId,
    catalogCarId,
    selected,
    paintIndex,
    plateName,
    colorCode,
    partsXml,
    wheelXml,
    testDriveInvitationId,
    testDriveName,
    testDriveMoneyPrice,
    testDrivePointPrice,
    testDriveExpiresAt,
  });

  if (selected) {
    await supabase
      .from("game_cars")
      .update(buildOwnedCarPatch({ selected: false }))
      .eq("player_id", Number(playerId));
  }

  let car;
  try {
    car = await insertGameCarCompat(supabase, insert);
  } catch (error) {
    if (!isMissingTestDriveColumnError(error)) {
      throw error;
    }

    delete insert.test_drive_invitation_id;
    delete insert.test_drive_name;
    delete insert.test_drive_money_price;
    delete insert.test_drive_point_price;
    delete insert.test_drive_expires_at;
    car = await insertGameCarCompat(supabase, insert);
  }

  return normalizeOwnedCarRecord(car);
}

export async function listCarsForPlayer(supabase, playerId, requestedCarIds = [], options = {}) {
  if (!supabase || !playerId) {
    return [];
  }

  const includeOwnedEngines = options?.includeOwnedEngines !== false;
  const ids = toNumericIds(requestedCarIds);
  let query = supabase
    .from("game_cars")
    .select("*")
    .eq("player_id", Number(playerId));

  if (ids.length > 0) {
    query = query.in("game_car_id", ids);
  }

  const cars = await manyResult(query, parseOwnedCarRecord);
  const sortedCars = ids.length > 0 ? sortByRequestedOrder(cars, ids, (car) => car.game_car_id) : cars;
  const repairedCars = await repairLegacyCars(supabase, sortedCars);
  return maybeAttachOwnedEngines(supabase, repairedCars, includeOwnedEngines);
}

export async function ensurePlayerHasGarageCar(supabase, playerId, options = {}) {
  if (!supabase || !playerId) {
    return [];
  }

  const includeOwnedEngines = options?.includeOwnedEngines !== false;
  const existingCars = await listCarsForPlayer(supabase, playerId, [], { includeOwnedEngines });
  if (existingCars.length > 0) {
    const hasSelected = existingCars.some((car) => car.selected);
    if (!hasSelected) {
      await updatePlayerDefaultCar(supabase, playerId, existingCars[0].game_car_id);
      return listCarsForPlayer(supabase, playerId, [], { includeOwnedEngines });
    }
    return existingCars;
  }

  const catalogCarId = Number(options.catalogCarId) || DEFAULT_STARTER_CATALOG_CAR_ID;
  await createStarterCar(supabase, {
    playerId,
    catalogCarId,
    paintIndex: Number(options.paintIndex) || DEFAULT_PAINT_INDEX,
    plateName: String(options.plateName || ""),
    colorCode: String(options.colorCode || DEFAULT_COLOR_CODE),
    partsXml: String(options.partsXml || DEFAULT_STOCK_PARTS_XML),
    wheelXml: String(options.wheelXml || getDefaultWheelXmlForCar(catalogCarId) || DEFAULT_OWNED_STOCK_WHEEL_XML),
  });

  return listCarsForPlayer(supabase, playerId, [], { includeOwnedEngines });
}

export async function getCarById(supabase, gameCarId) {
  if (!supabase || !gameCarId) {
    return null;
  }

  const car = await maybeSingle(
    supabase
      .from("game_cars")
      .select("*")
      .eq("game_car_id", Number(gameCarId)),
    parseOwnedCarRecord,
  );
  if (!car) {
    return null;
  }
  return (await attachOwnedEnginesToCars(supabase, [car]))[0] || null;
}

export async function listCarsByIds(supabase, gameCarIds = []) {
  if (!supabase || gameCarIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(gameCarIds);
  if (ids.length === 0) {
    return [];
  }

  let cars = await manyResult(
    supabase
      .from("game_cars")
      .select("*")
      .in("game_car_id", ids),
    parseOwnedCarRecord,
  );

  if (cars.length < ids.length) {
    const foundIds = new Set(cars.map((car) => Number(car?.game_car_id || 0)));
    const missingIds = ids.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
      const legacyCars = await manyResult(
        supabase
          .from("game_cars")
          .select("*")
          .in("account_car_id", missingIds),
        parseOwnedCarRecord,
      );
      if (legacyCars.length > 0) {
        const byAccountId = new Map(legacyCars.map((car) => [Number(car?.account_car_id || 0), car]));
        for (const missingId of missingIds) {
          const legacyCar = byAccountId.get(missingId);
          if (legacyCar) {
            cars.push(legacyCar);
          }
        }
      }
    }
  }

  const sortedCars = sortByRequestedOrder(cars, ids, (car) => {
    const gameCarId = Number(car?.game_car_id || 0);
    const accountCarId = Number(car?.account_car_id || 0);
    return ids.includes(gameCarId) ? gameCarId : accountCarId;
  });
  const repairedCars = await repairLegacyCars(supabase, sortedCars);
  return maybeAttachOwnedEngines(supabase, repairedCars, true);
}

export async function deleteCar(supabase, gameCarId) {
  if (!supabase || !gameCarId) {
    return false;
  }

  const { error } = await supabase
    .from("game_cars")
    .delete()
    .eq("game_car_id", Number(gameCarId));

  if (error) {
    throw error;
  }

  return true;
}

export async function clearCarTestDriveState(supabase, gameCarId) {
  if (!supabase || !gameCarId) {
    return false;
  }

  try {
    const { error } = await supabase
      .from("game_cars")
      .update(buildClearedTestDrivePatch())
      .eq("game_car_id", Number(gameCarId));

    if (error) {
      throw error;
    }
  } catch (error) {
    if (!isMissingTestDriveColumnError(error)) {
      throw error;
    }
  }

  return true;
}

export async function saveCarPartsXml(supabase, gameCarId, partsXml) {
  if (!supabase || !gameCarId) {
    return null;
  }

  return singleResult(
    supabase
      .from("game_cars")
      .update(buildOwnedCarPatch({ partsXml }))
      .eq("game_car_id", Number(gameCarId))
      .select("*"),
    parseOwnedCarRecord,
  ).then((car) => attachOwnedEnginesToCars(supabase, [car]).then((cars) => cars[0] || car));
}

export async function saveCarWheelXml(supabase, gameCarId, wheelXml) {
  if (!supabase || !gameCarId) {
    return null;
  }

  return singleResult(
    supabase
      .from("game_cars")
      .update(buildOwnedCarPatch({ wheelXml }))
      .eq("game_car_id", Number(gameCarId))
      .select("*"),
    parseOwnedCarRecord,
  ).then((car) => attachOwnedEnginesToCars(supabase, [car]).then((cars) => cars[0] || car));
}

export async function listLeaderboardCars(supabase) {
  if (!supabase) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_cars")
      .select("game_car_id, player_id, catalog_car_id, selected, parts_xml"),
    parseOwnedCarRecord,
  );
}
