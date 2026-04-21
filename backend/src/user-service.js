import {
  DEFAULT_COLOR_CODE,
  DEFAULT_OWNED_STOCK_WHEEL_XML,
  DEFAULT_PAINT_INDEX,
  DEFAULT_STARTER_CATALOG_CAR_ID,
  DEFAULT_STOCK_PARTS_XML,
  getDefaultWheelXmlForCar,
} from "./car-defaults.js";
import {
  buildClearedTestDrivePatch,
  buildTeamInsert,
  buildTeamPatch,
  buildOwnedCarInsert,
  buildOwnedCarPatch,
  buildPartsInventoryInsert,
  buildPartsInventoryPatch,
  buildPlayerInsert,
  buildPlayerPatch,
  buildTeamMemberInsert,
  parseMailRecord,
  parseOwnedCarRecord,
  parsePartsInventoryRecord,
  parsePlayerRecord,
  parseRaceHistoryRecord,
  parseRaceLogRecord,
  parseTeamMemberRecord,
  parseTeamRecord,
  parseTransactionRecord,
} from "./db-models.js";

async function maybeSingle(query, parser = (value) => value) {
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  return data ? parser(data) : null;
}

async function singleResult(query, parser = (value) => value) {
  const { data, error } = await query.single();
  if (error) {
    throw error;
  }
  return parser(data);
}

async function manyResult(query, parser = (value) => value) {
  const { data, error } = await query;
  if (error) {
    throw error;
  }
  return (data || []).map((record) => parser(record));
}

function isMissingGameCarIdError(error) {
  const message = String(error?.message || error || "");
  return /game_car_id/i.test(message) && /not-null|null value|required/i.test(message);
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
    return await singleResult(supabase.from("game_cars").insert(insert).select("*"), parseOwnedCarRecord);
  } catch (error) {
    if (!isMissingGameCarIdError(error)) {
      throw error;
    }

    const compatInsert = {
      ...insert,
      game_car_id: await getNextExplicitGameCarId(supabase),
    };
    return singleResult(supabase.from("game_cars").insert(compatInsert).select("*"), parseOwnedCarRecord);
  }
}

function isMissingTestDriveColumnError(error) {
  const message = String(error?.message || error || "");
  return /test_drive_/i.test(message) && /does not exist|unknown column|column/i.test(message);
}

function isMissingPartsInventoryTableError(error) {
  const message = String(error?.message || error || "");
  return /game_parts_inventory/i.test(message) && /does not exist|unknown table|relation|column/i.test(message);
}

function isMissingGameTeamMembersRelationError(error) {
  const message = String(error?.message || error || "");
  return (
    (/relation|table/i.test(message) && /does not exist/i.test(message) && /game_team_members/i.test(message))
    || (/game_team_members/i.test(message) && /does not exist/i.test(message))
  );
}

function isMissingTableError(error, tableName) {
  const message = String(error?.message || error || "");
  return new RegExp(`\\b${tableName}\\b`, "i").test(message)
    && /(does not exist|relation|schema cache|could not find the table|unknown table)/i.test(message);
}

function isMissingWinsLossesColumnError(error) {
  const message = String(error?.message || error || "");
  return /wins|losses/i.test(message) && /does not exist|unknown column|column/i.test(message);
}

function toNumericIds(values = []) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => value > 0))];
}

function sortByRequestedOrder(records, ids, getRecordId) {
  const ordering = new Map(ids.map((value, index) => [value, index]));
  return [...records].sort((left, right) => {
    const leftIndex = ordering.has(getRecordId(left)) ? ordering.get(getRecordId(left)) : Number.MAX_SAFE_INTEGER;
    const rightIndex = ordering.has(getRecordId(right)) ? ordering.get(getRecordId(right)) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

async function safeSelectRows(queryFactory, parser = (value) => value, missingTableNames = []) {
  try {
    return await manyResult(queryFactory(), parser);
  } catch (error) {
    if (missingTableNames.some((tableName) => isMissingTableError(error, tableName))) {
      return null;
    }
    throw error;
  }
}

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

export async function listPartsInventoryForPlayer(supabase, playerId) {
  if (!supabase || !playerId) {
    return [];
  }

  try {
    return await manyResult(
      supabase
      .from("game_parts_inventory")
      .select("*")
      .eq("player_id", Number(playerId))
      .order("id", { ascending: true }),
      parsePartsInventoryRecord,
    );
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
      parsePartsInventoryRecord,
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
      parsePartsInventoryRecord,
    );

    if (existing) {
      return singleResult(
        supabase
          .from("game_parts_inventory")
          .update(buildPartsInventoryPatch({ quantity: Number(existing.quantity || 0) + Number(quantityDelta || 0) }))
          .eq("id", Number(existing.id))
          .select("*"),
        parsePartsInventoryRecord,
      );
    }

    return singleResult(
      supabase
        .from("game_parts_inventory")
        .insert(buildPartsInventoryInsert({
          playerId,
          partCatalogId,
          quantity: Number(quantityDelta || 0),
        }))
        .select("*"),
      parsePartsInventoryRecord,
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
        .update(buildPartsInventoryPatch({ quantity: quantity - 1 }))
        .eq("id", Number(item.id))
        .select("*"),
      parsePartsInventoryRecord,
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
    parsePlayerRecord,
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
    parsePlayerRecord,
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

  const insert = buildPlayerInsert({
    username,
    passwordHash,
    gender,
    imageId,
    money,
    points,
    score,
    clientRole,
  });
  if (!insert) {
    return null;
  }

  try {
    return await singleResult(supabase.from("game_players").insert(insert).select("*"), parsePlayerRecord);
  } catch (error) {
    // Back-compat for databases that haven't added `client_role` yet.
    const message = String(error?.message || error || "");
    if (/client_role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
      const { client_role: _ignored, ...withoutRole } = insert;
      return singleResult(supabase.from("game_players").insert(withoutRole).select("*"), parsePlayerRecord);
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

  // Keep the player's default car in sync with the selected starter car.
  await supabase
    .from("game_players")
    .update(buildPlayerPatch({ defaultCarGameId: car.game_car_id }))
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

export async function listCarsForPlayer(supabase, playerId, requestedCarIds = []) {
  if (!supabase || !playerId) {
    return [];
  }

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
    parseOwnedCarRecord,
  );
  return car;
}

export async function listCarsByIds(supabase, gameCarIds = []) {
  if (!supabase || gameCarIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(gameCarIds);
  if (ids.length === 0) {
    return [];
  }

  const cars = await manyResult(
    supabase
    .from("game_cars")
    .select("*")
    .in("game_car_id", ids),
    parseOwnedCarRecord,
  );
  const sortedCars = sortByRequestedOrder(cars, ids, (car) => car.game_car_id);
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

export async function updatePlayerMoney(supabase, playerId, newBalance) {
  if (!supabase || !playerId) {
    return false;
  }

  const { error } = await supabase
    .from("game_players")
    .update(buildPlayerPatch({ money: newBalance }))
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
    .update(buildPlayerPatch({ locationId }))
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  return true;
}

export async function updatePlayerRecord(supabase, playerId, patchInput = {}) {
  if (!supabase || !playerId) {
    return null;
  }

  return singleResult(
    supabase
      .from("game_players")
      .update(buildPlayerPatch(patchInput))
      .eq("id", Number(playerId))
      .select("*"),
    parsePlayerRecord,
  );
}

export async function findTeamByName(supabase, teamName) {
  if (!supabase || !teamName) {
    return null;
  }

  return maybeSingle(
    supabase
      .from("game_teams")
      .select("*")
      .ilike("name", String(teamName))
      .limit(1),
    parseTeamRecord,
  );
}

export async function createTeam(supabase, input = {}) {
  if (!supabase) {
    return null;
  }

  const insert = buildTeamInsert(input);
  if (!insert) {
    return null;
  }

  let team;
  try {
    team = await singleResult(
      supabase.from("game_teams").insert(insert).select("*"),
      parseTeamRecord,
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!/team_fund|column/i.test(message) || !/does not exist|unknown column/i.test(message)) {
      throw error;
    }

    const { team_fund: _ignored, ...withoutTeamFund } = insert;
    team = await singleResult(
      supabase.from("game_teams").insert(withoutTeamFund).select("*"),
      parseTeamRecord,
    );
  }

  const ownerPlayerId = Number(input.ownerPlayerId ?? input.owner_player_id || 0);
  if (team && ownerPlayerId > 0) {
    try {
      team = await updateTeamRecord(supabase, team.id, { ownerPlayerId });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/owner_player_id/i.test(message) || !/does not exist|unknown column/i.test(message)) {
        throw error;
      }
    }
  }

  return team;
}

export async function updateTeamRecord(supabase, teamId, patchInput = {}) {
  if (!supabase || !teamId) {
    return null;
  }

  const patch = buildTeamPatch(patchInput);
  if (Object.keys(patch).length === 0) {
    return null;
  }

  try {
    return await singleResult(
      supabase
        .from("game_teams")
        .update(patch)
        .eq("id", Number(teamId))
        .select("*"),
      parseTeamRecord,
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/owner_player_id/i.test(message) && /does not exist|unknown column/i.test(message) && "owner_player_id" in patch) {
      const { owner_player_id: _ignored, ...withoutOwner } = patch;
      if (Object.keys(withoutOwner).length === 0) {
        return maybeSingle(
          supabase
            .from("game_teams")
            .select("*")
            .eq("id", Number(teamId)),
          parseTeamRecord,
        );
      }

      return singleResult(
        supabase
          .from("game_teams")
          .update(withoutOwner)
          .eq("id", Number(teamId))
          .select("*"),
        parseTeamRecord,
      );
    }

    throw error;
  }
}

export async function deleteTeam(supabase, teamId) {
  if (!supabase || !teamId) {
    return false;
  }

  const { error } = await supabase
    .from("game_teams")
    .delete()
    .eq("id", Number(teamId));

  if (error) {
    throw error;
  }

  return true;
}

export async function listTeamsByIds(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(teamIds);
  if (ids.length === 0) {
    return [];
  }

  const teams = await manyResult(
    supabase
    .from("game_teams")
    .select("*")
    .in("id", ids),
    parseTeamRecord,
  );
  return sortByRequestedOrder(teams, ids, (team) => team.id);
}

export async function listTeamMembersForTeams(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(teamIds);
  if (ids.length === 0) {
    return [];
  }

  return manyResult(
    supabase
    .from("game_team_members")
    .select("*")
    .in("team_id", ids)
    .order("team_id", { ascending: true })
    .order("contribution_score", { ascending: false })
    .order("joined_at", { ascending: true }),
    parseTeamMemberRecord,
  );
}

export async function listPlayersByIds(supabase, playerIds = []) {
  if (!supabase || playerIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(playerIds);
  if (ids.length === 0) {
    return [];
  }

  const players = await manyResult(
    supabase
    .from("game_players")
    .select("*")
    .in("id", ids),
    parsePlayerRecord,
  );
  return sortByRequestedOrder(players, ids, (player) => player.id);
}

export async function listPlayersForTeams(supabase, teamIds = []) {
  if (!supabase || teamIds.length === 0) {
    return [];
  }

  const ids = toNumericIds(teamIds);
  if (ids.length === 0) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_players")
      .select("*")
      .in("team_id", ids),
    parsePlayerRecord,
  );
}

export async function searchPlayersByUsername(supabase, username, limit = 20) {
  if (!supabase || !username) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_players")
      .select("id, username, client_role")
      .ilike("username", `%${String(username)}%`)
      .limit(Number(limit) || 20),
    parsePlayerRecord,
  );
}

export async function listLeaderboardPlayers(supabase) {
  if (!supabase) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_players")
      .select("id, username, score, money, location_id, title_id, team_name, vip, track_rank, badges_json, client_role, default_car_game_id"),
    parsePlayerRecord,
  );
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

export async function listLeaderboardTeams(supabase) {
  if (!supabase) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_teams")
      .select("*"),
    parseTeamRecord,
  );
}

export async function listTransactionsSince(supabase, sinceIso) {
  if (!supabase || !sinceIso) {
    return null;
  }

  return safeSelectRows(
    () => supabase
      .from("game_transactions")
      .select("player_id, money_change, points_change, created_at")
      .gte("created_at", sinceIso),
    parseTransactionRecord,
    ["game_transactions"],
  );
}

export async function listRaceHistorySince(supabase, sinceIso) {
  if (!supabase || !sinceIso) {
    return null;
  }

  return safeSelectRows(
    () => supabase
      .from("game_race_history")
      .select("player_id, race_type, won, time_ms, car_id, raced_at")
      .gte("raced_at", sinceIso),
    parseRaceHistoryRecord,
    ["game_race_history"],
  );
}

export async function listRaceLogsSince(supabase, sinceIso) {
  if (!supabase) {
    return null;
  }

  return safeSelectRows(
    () => {
      let query = supabase
        .from("game_race_logs")
        .select("player_1_id, player_2_id, winner_id, player_1_time, player_2_time, created_at");

      if (sinceIso) {
        query = query.gte("created_at", sinceIso);
      }

      return query;
    },
    parseRaceLogRecord,
    ["game_race_logs"],
  );
}

export async function listMailForRecipient(
  supabase,
  { recipientPlayerId, folder = "inbox", page = 0, pageSize = 20 } = {},
) {
  if (!supabase || !recipientPlayerId) {
    return [];
  }

  return manyResult(
    supabase
      .from("game_mail")
      .select(`
        id,
        sender_player_id,
        recipient_player_id,
        subject,
        body,
        folder,
        is_read,
        is_deleted,
        created_at,
        attachment_money,
        attachment_points
      `)
      .eq("recipient_player_id", Number(recipientPlayerId))
      .eq("folder", String(folder || "inbox"))
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .range(Number(page) * Number(pageSize), (Number(page) + 1) * Number(pageSize) - 1),
    parseMailRecord,
  );
}

export async function getTeamMembershipByPlayerId(supabase, playerId) {
  if (!supabase || !playerId) {
    return null;
  }

  try {
    return await maybeSingle(
      supabase
        .from("game_team_members")
        .select("*")
        .eq("player_id", Number(playerId)),
      parseTeamMemberRecord,
    );
  } catch (error) {
    if (isMissingGameTeamMembersRelationError(error)) {
      return null;
    }

    const message = String(error?.message || error || "");
    if (/role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
      try {
        return await maybeSingle(
          supabase
            .from("game_team_members")
            .select("id, team_id, player_id, contribution_score, joined_at, updated_at")
            .eq("player_id", Number(playerId)),
          parseTeamMemberRecord,
        );
      } catch (compatError) {
        if (isMissingGameTeamMembersRelationError(compatError)) {
          return null;
        }
        throw compatError;
      }
    }

    throw error;
  }
}

export async function syncGameTeamMemberRow(supabase, playerId, teamId, options = {}) {
  if (!supabase || !playerId) {
    return false;
  }

  try {
    const { error: deleteError } = await supabase
      .from("game_team_members")
      .delete()
      .eq("player_id", Number(playerId));

    if (deleteError) {
      throw deleteError;
    }
  } catch (error) {
    if (isMissingGameTeamMembersRelationError(error)) {
      return false;
    }
    throw error;
  }

  const numericTeamId = Number(teamId || 0);
  if (numericTeamId <= 0) {
    return true;
  }

  const insert = buildTeamMemberInsert({
    teamId: numericTeamId,
    playerId,
    role: options.dbMemberRole || options.role,
  });

  let insertError = null;
  try {
    ({ error: insertError } = await supabase
      .from("game_team_members")
      .insert(insert));
  } catch (error) {
    insertError = error;
  }

  if (insertError && /role/i.test(String(insertError.message || insertError || "")) && /does not exist|unknown column|column/i.test(String(insertError.message || insertError || ""))) {
    const { role: _ignored, ...withoutRole } = insert;
    ({ error: insertError } = await supabase
      .from("game_team_members")
      .insert(withoutRole));
  }

  if (insertError) {
    if (isMissingGameTeamMembersRelationError(insertError)) {
      return false;
    }
    throw insertError;
  }

  return true;
}

export async function setPlayerTeamMembership(supabase, playerId, team, membershipOptions = {}) {
  if (!supabase || !playerId) {
    return false;
  }

  const patch = buildPlayerPatch({
    teamId: team ? Number(team.id) : null,
    teamName: team ? String(team.name || "") : "",
  });

  const { error } = await supabase
    .from("game_players")
    .update(patch)
    .eq("id", Number(playerId));

  if (error) {
    throw error;
  }

  await syncGameTeamMemberRow(supabase, playerId, team ? Number(team.id) : 0, membershipOptions);
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
  );
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
  );
}

export async function applyPlayerRaceResult(supabase, playerId, { scoreDelta = 0, won = false, lost = false } = {}) {
  if (!supabase || !playerId) {
    return false;
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return false;
  }

  const patch = buildPlayerPatch({
    score: Number(player.score || 0) + Number(scoreDelta || 0),
    wins: Number(player.wins || 0) + (won ? 1 : 0),
    losses: Number(player.losses || 0) + (lost ? 1 : 0),
  });

  try {
    const { error } = await supabase
      .from("game_players")
      .update(patch)
      .eq("id", Number(playerId));

    if (error) {
      throw error;
    }
  } catch (error) {
    if (!isMissingWinsLossesColumnError(error)) {
      throw error;
    }

    const { wins: _wins, losses: _losses, ...scoreOnlyPatch } = patch;
    const { error: scoreError } = await supabase
      .from("game_players")
      .update(scoreOnlyPatch)
      .eq("id", Number(playerId));

    if (scoreError) {
      throw scoreError;
    }
  }

  return true;
}
