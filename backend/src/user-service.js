import {
  DEFAULT_COLOR_CODE,
  DEFAULT_OWNED_STOCK_WHEEL_XML,
  DEFAULT_PAINT_INDEX,
  DEFAULT_STARTER_CATALOG_CAR_ID,
  DEFAULT_STOCK_PARTS_XML,
  normalizeOwnedWheelXmlValue,
} from "./car-defaults.js";

async function maybeSingle(query) {
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

async function singleResult(query) {
  const { data, error } = await query.single();
  if (error) {
    throw error;
  }
  return data;
}

function isMissingGameCarIdError(error) {
  const message = String(error?.message || error || "");
  return /game_car_id/i.test(message) && /not-null|null value|required/i.test(message);
}

async function getNextExplicitGameCarId(supabase) {
  const { data, error } = await supabase
    .from("game_cars")
    .select("game_car_id");

  if (error) {
    throw error;
  }

  return (data || []).reduce((maxId, row) => Math.max(maxId, Number(row?.game_car_id || 0)), 0) + 1;
}

async function insertGameCarCompat(supabase, insert) {
  try {
    return await singleResult(supabase.from("game_cars").insert(insert).select("*"));
  } catch (error) {
    if (!isMissingGameCarIdError(error)) {
      throw error;
    }

    const compatInsert = {
      ...insert,
      game_car_id: await getNextExplicitGameCarId(supabase),
    };
    return singleResult(supabase.from("game_cars").insert(compatInsert).select("*"));
  }
}

const NORMALIZED_STOCK_CATALOG_CAR_ID = DEFAULT_STARTER_CATALOG_CAR_ID;
const NORMALIZED_STOCK_WHEEL_XML = DEFAULT_OWNED_STOCK_WHEEL_XML;
const NORMALIZED_STOCK_PARTS_XML = DEFAULT_STOCK_PARTS_XML;
const TEST_DRIVE_HOUR_MS = 60 * 60 * 1000;

function isMissingTestDriveColumnError(error) {
  const message = String(error?.message || error || "");
  return /test_drive_/i.test(message) && /does not exist|unknown column|column/i.test(message);
}

function normalizeCatalogCarIdValue(value) {
  const numericValue = Number(value) || 0;
  if (numericValue === 101 || numericValue === 12) {
    return NORMALIZED_STOCK_CATALOG_CAR_ID;
  }
  return numericValue;
}

function normalizeWheelXmlValue(value) {
  return normalizeOwnedWheelXmlValue(value);
}

function normalizePartsXmlValue(value) {
  const partsXml = String(value || "").trim();
  if (!partsXml) {
    return "";
  }

  // Stored part fragments sometimes come from shop payloads (`pi` / `t`) rather
  // than owned-car payloads (`ci` / `pt`). The 10.0.03 garage/client code reads
  // owned-car nodes, so normalize the legacy shop shape into the canonical form.
  return partsXml.replace(/<p\b([^>]*)\/>/gi, (fullMatch, rawAttrs) => {
    let attrs = String(rawAttrs || "");

    if (!/\bci=/.test(attrs) && /\bpi=/.test(attrs)) {
      attrs = attrs.replace(/\bpi=/, "ci=");
    }

    if (!/\bpt=/.test(attrs) && /\bt=/.test(attrs)) {
      attrs = attrs.replace(/\bt=/, "pt=");
    }

    return `<p${attrs}/>`;
  });
}

function isMissingPartsInventoryTableError(error) {
  const message = String(error?.message || error || "");
  return /game_parts_inventory/i.test(message) && /does not exist|unknown table|relation|column/i.test(message);
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deriveTestDriveState(car) {
  const invitationId = Number(car?.test_drive_invitation_id || 0);
  if (invitationId <= 0) {
    return null;
  }

  const expiresAt = parseTimestamp(car.test_drive_expires_at);
  const msRemaining = expiresAt ? expiresAt.getTime() - Date.now() : 0;
  const expired = !expiresAt || msRemaining <= 0;
  const hoursRemaining = expiresAt ? Math.max(0, Math.ceil(msRemaining / TEST_DRIVE_HOUR_MS)) : 0;

  return {
    active: 1,
    expired: expired ? 1 : 0,
    hoursRemaining,
  };
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deriveTestDriveState(car) {
  const invitationId = Number(car?.test_drive_invitation_id || 0);
  if (invitationId <= 0) {
    return null;
  }

  const expiresAt = parseTimestamp(car.test_drive_expires_at);
  const msRemaining = expiresAt ? expiresAt.getTime() - Date.now() : 0;
  const expired = !expiresAt || msRemaining <= 0;
  const hoursRemaining = expiresAt ? Math.max(0, Math.ceil(msRemaining / TEST_DRIVE_HOUR_MS)) : 0;

  return {
    active: 1,
    expired: expired ? 1 : 0,
    hoursRemaining,
  };
}

export function normalizeOwnedCarRecord(car) {
  if (!car) {
    return car;
  }

  const testDriveState = deriveTestDriveState(car);

  return {
    ...car,
    catalog_car_id: normalizeCatalogCarIdValue(car.catalog_car_id),
    wheel_xml: normalizeWheelXmlValue(car.wheel_xml),
    parts_xml: normalizePartsXmlValue(car.parts_xml),
    test_drive_active: testDriveState?.active,
    test_drive_expired: testDriveState?.expired,
    test_drive_hours_remaining: testDriveState?.hoursRemaining,
  };
}

function getLegacyCarPatch(car) {
  const patch = {};

  const normalizedCatalogCarId = normalizeCatalogCarIdValue(car.catalog_car_id);
  if (normalizedCatalogCarId && normalizedCatalogCarId !== Number(car.catalog_car_id || 0)) {
    patch.catalog_car_id = normalizedCatalogCarId;
  }

  const normalizedWheelXml = normalizeWheelXmlValue(car.wheel_xml);
  if (normalizedWheelXml !== String(car.wheel_xml || "")) {
    patch.wheel_xml = normalizedWheelXml;
  }

  const normalizedPartsXml = normalizePartsXmlValue(car.parts_xml);
  if (normalizedPartsXml !== String(car.parts_xml || "")) {
    patch.parts_xml = normalizedPartsXml;
  }

  return patch;
}

async function repairLegacyCars(supabase, cars) {
  if (!supabase || !cars.length) {
    return cars;
  }

  const repairedCars = [];
  for (const car of cars) {
    const patch = getLegacyCarPatch(car);
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabase
        .from("game_cars")
        .update(patch)
        .eq("game_car_id", Number(car.game_car_id))
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      repairedCars.push(normalizeOwnedCarRecord(data || car));
      continue;
    }

    repairedCars.push(normalizeOwnedCarRecord(car));
  }

  return repairedCars;
}

export async function listPartsInventoryForPlayer(supabase, playerId) {
  if (!supabase || !playerId) {
    return [];
  }

  try {
    const { data, error } = await supabase
      .from("game_parts_inventory")
      .select("*")
      .eq("player_id", Number(playerId))
      .order("id", { ascending: true });

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function getPartInventoryItemById(supabase, inventoryId, playerId) {
  if (!supabase || !inventoryId || !playerId) {
    return null;
  }

  try {
    return await maybeSingle(
      supabase
        .from("game_parts_inventory")
        .select("*")
        .eq("id", Number(inventoryId))
        .eq("player_id", Number(playerId)),
    );
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function addPartInventoryItem(supabase, playerId, partCatalogId, quantityDelta = 1) {
  if (!supabase || !playerId || !partCatalogId || quantityDelta <= 0) {
    return null;
  }

  try {
    const existing = await maybeSingle(
      supabase
        .from("game_parts_inventory")
        .select("*")
        .eq("player_id", Number(playerId))
        .eq("part_catalog_id", Number(partCatalogId)),
    );

    if (existing) {
      return singleResult(
        supabase
          .from("game_parts_inventory")
          .update({ quantity: Number(existing.quantity || 0) + Number(quantityDelta || 0) })
          .eq("id", Number(existing.id))
          .select("*"),
      );
    }

    return singleResult(
      supabase
        .from("game_parts_inventory")
        .insert({
          player_id: Number(playerId),
          part_catalog_id: Number(partCatalogId),
          quantity: Number(quantityDelta || 0),
        })
        .select("*"),
    );
  } catch (error) {
    if (isMissingPartsInventoryTableError(error)) {
      return null;
    }
    throw error;
  }
}

export async function consumePartInventoryItem(supabase, inventoryId, playerId) {
  if (!supabase || !inventoryId || !playerId) {
    return null;
  }

  const item = await getPartInventoryItemById(supabase, inventoryId, playerId);
  if (!item) {
    return null;
  }

  const quantity = Number(item.quantity || 0);
  if (quantity > 1) {
    await singleResult(
      supabase
        .from("game_parts_inventory")
        .update({ quantity: quantity - 1 })
        .eq("id", Number(item.id))
        .select("*"),
    );
  } else {
    const { error } = await supabase
      .from("game_parts_inventory")
      .delete()
      .eq("id", Number(item.id))
      .eq("player_id", Number(playerId));

    if (error) {
      throw error;
    }
  }

  return item;
}

export async function getPlayerById(supabase, playerId) {
  if (!supabase || !playerId) {
    return null;
  }

  return maybeSingle(
    supabase
      .from("game_players")
      .select("*")
      .eq("id", Number(playerId)),
  );
}

export async function getPlayerByUsername(supabase, username) {
  if (!supabase || !username) {
    return null;
  }

  // Use ilike for case-insensitive username lookup
  return maybeSingle(
    supabase
      .from("game_players")
      .select("*")
      .ilike("username", String(username)),
  );
}

export async function createPlayer(
  supabase,
  {
    username,
    passwordHash,
    gender = "m",
    imageId = 0,
    money = 50000,
    points = 0,
    score = 0,
    clientRole = 5,
  } = {},
) {
  if (!supabase) {
    return null;
  }

  const normalizedUsername = String(username || "").trim();
  if (!normalizedUsername || !passwordHash) {
    return null;
  }

  const insert = {
    username: normalizedUsername,
    password_hash: String(passwordHash),
    gender: String(gender || "m"),
    image_id: Number(imageId) || 0,
    money: Number(money) || 0,
    points: Number(points) || 0,
    score: Number(score) || 0,
    client_role: Number(clientRole) || 5,
  };

  try {
    return await singleResult(supabase.from("game_players").insert(insert).select("*"));
  } catch (error) {
    // Back-compat for databases that haven't added `client_role` yet.
    const message = String(error?.message || error || "");
    if (/client_role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
      const { client_role: _ignored, ...withoutRole } = insert;
      return singleResult(supabase.from("game_players").insert(withoutRole).select("*"));
    }
    throw error;
  }
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

  const insert = {
    player_id: Number(playerId),
    catalog_car_id: Number(catalogCarId),
    selected: true,
    paint_index: Number(paintIndex) || DEFAULT_PAINT_INDEX,
    plate_name: String(plateName || ""),
    color_code: String(colorCode || DEFAULT_COLOR_CODE),
    parts_xml: String(partsXml || ""),
    wheel_xml: normalizeWheelXmlValue(wheelXml),
  };

  const car = await insertGameCarCompat(supabase, insert);

  // Keep the player's default car in sync with the selected starter car.
  await supabase
    .from("game_players")
    .update({ default_car_game_id: Number(car.game_car_id) })
    .eq("id", Number(playerId));

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

  const insert = {
    player_id: Number(playerId),
    catalog_car_id: Number(catalogCarId),
    selected: Boolean(selected),
    paint_index: Number(paintIndex) || DEFAULT_PAINT_INDEX,
    plate_name: String(plateName || ""),
    color_code: String(colorCode || DEFAULT_COLOR_CODE),
    parts_xml: String(partsXml || ""),
    wheel_xml: normalizeWheelXmlValue(wheelXml),
  };

  if (testDriveInvitationId != null) {
    insert.test_drive_invitation_id = Number(testDriveInvitationId) || null;
    insert.test_drive_name = String(testDriveName || "");
    insert.test_drive_money_price = Number(testDriveMoneyPrice) || 0;
    insert.test_drive_point_price = Number(testDrivePointPrice) || 0;
    insert.test_drive_expires_at = testDriveExpiresAt;
  }

  if (selected) {
    await supabase
      .from("game_cars")
      .update({ selected: false })
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

export async function listCarsForPlayer(supabase, playerId, requestedCarIds = []) {
  if (!supabase || !playerId) {
    return [];
  }

  let query = supabase
    .from("game_cars")
    .select("*")
    .eq("player_id", Number(playerId));

  if (requestedCarIds.length > 0) {
    query = query.in("game_car_id", requestedCarIds);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const ordering = new Map(requestedCarIds.map((value, index) => [value, index]));
  const sortedCars = [...(data || [])].sort((left, right) => {
    const leftIndex = ordering.has(left.game_car_id) ? ordering.get(left.game_car_id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = ordering.has(right.game_car_id)
      ? ordering.get(right.game_car_id)
      : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
  return repairLegacyCars(supabase, sortedCars);
}

export async function ensurePlayerHasGarageCar(
  supabase,
  playerId,
  options = {},
) {
  if (!supabase || !playerId) {
    return [];
  }

  const existingCars = await listCarsForPlayer(supabase, playerId);
  if (existingCars.length > 0) {
    const hasSelected = existingCars.some((car) => car.selected);
    if (!hasSelected) {
      await updatePlayerDefaultCar(supabase, playerId, existingCars[0].game_car_id);
      return listCarsForPlayer(supabase, playerId);
    }
    return existingCars;
  }

  await createStarterCar(supabase, {
    playerId,
    catalogCarId: Number(options.catalogCarId) || DEFAULT_STARTER_CATALOG_CAR_ID,
    paintIndex: Number(options.paintIndex) || DEFAULT_PAINT_INDEX,
    plateName: String(options.plateName || ""),
    colorCode: String(options.colorCode || DEFAULT_COLOR_CODE),
    partsXml: String(options.partsXml || DEFAULT_STOCK_PARTS_XML),
    wheelXml: String(options.wheelXml || NORMALIZED_STOCK_WHEEL_XML),
  });

  return listCarsForPlayer(supabase, playerId);
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
  );
  return normalizeOwnedCarRecord(car);
}

export async function listCarsByIds(supabase, gameCarIds = []) {
  if (!supabase || gameCarIds.length === 0) {
    return [];
  }

  const ids = [...new Set(gameCarIds.map((value) => Number(value)).filter((value) => value > 0))];
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("game_cars")
    .select("*")
    .in("game_car_id", ids);

  if (error) {
    throw error;
  }

  const ordering = new Map(ids.map((value, index) => [value, index]));
  const sortedCars = [...(data || [])].sort((left, right) => {
    const leftIndex = ordering.has(left.game_car_id) ? ordering.get(left.game_car_id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = ordering.has(right.game_car_id)
      ? ordering.get(right.game_car_id)
      : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
  return repairLegacyCars(supabase, sortedCars);
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

  const patch = {
    test_drive_invitation_id: null,
    test_drive_name: null,
    test_drive_money_price: null,
    test_drive_point_price: null,
    test_drive_expires_at: null,
  };

  try {
    const { error } = await supabase
      .from("game_cars")
      .update(patch)
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

export async function updatePlayerMoney(supabase, playerId, newBalance) {
  if (!supabase || !playerId) {
    return false;
  }

  const { error } = await supabase
    .from("game_players")
    .update({ money: Number(newBalance) })
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  return true;
}

export async function updatePlayerDefaultCar(supabase, playerId, gameCarId) {
  if (!supabase || !playerId || !gameCarId) {
    return false;
  }

  // Atomic: unselect all → select one → update player default in a single DB transaction
  const { error } = await supabase.rpc("select_player_car", {
    p_player_id: Number(playerId),
    p_game_car_id: Number(gameCarId),
  });

  if (error) {
    throw error;
  }

  return true;
}

export async function updatePlayerLocation(supabase, playerId, locationId) {
  if (!supabase || !playerId || !locationId) {
    return false;
  }

  const { error } = await supabase
    .from("game_players")
    .update({ location_id: Number(locationId) })
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  return true;
}

export async function updatePlayerLocation(supabase, playerId, locationId) {
  if (!supabase || !playerId || !locationId) {
    return false;
  }

  const { error } = await supabase
    .from("game_players")
    .update({ location_id: Number(locationId) })
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  return true;
}

export async function listTeamsByIds(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = [...new Set(teamIds.map((value) => Number(value)).filter((value) => value > 0))];
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("game_teams")
    .select("*")
    .in("id", ids);

  if (error) {
    throw error;
  }

  const ordering = new Map(ids.map((value, index) => [value, index]));
  return [...(data || [])].sort((left, right) => {
    const leftIndex = ordering.has(left.id) ? ordering.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightIndex = ordering.has(right.id) ? ordering.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export async function listTeamMembersForTeams(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = [...new Set(teamIds.map((value) => Number(value)).filter((value) => value > 0))];
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("game_team_members")
    .select("*")
    .in("team_id", ids)
    .order("team_id", { ascending: true })
    .order("contribution_score", { ascending: false })
    .order("joined_at", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

export async function listPlayersByIds(supabase, playerIds = []) {
  if (!supabase || playerIds.length === 0) {
    return [];
  }

  const ids = [...new Set(playerIds.map((value) => Number(value)).filter((value) => value > 0))];
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .in("id", ids);

  if (error) {
    throw error;
  }

  return data || [];
}
