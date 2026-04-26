import {
  buildOwnedEngineInsert,
  buildOwnedEnginePatch,
  buildOwnedCarPatch,
  parseOwnedEngineRecord,
} from "../db-models.js";
import { getEngineTypeIdForCar } from "../car-engine-state.js";
import {
  isMissingTableError,
  manyResult,
  maybeSingle,
  singleResult,
} from "./shared.js";

function collectXmlEntries(partsXml) {
  return [...String(partsXml || "").matchAll(/<p\b[^>]*\/>/g)].map((match) => match[0]);
}

function parseAttrs(rawEntry) {
  const attrs = {};
  for (const match of String(rawEntry || "").matchAll(/(\w+)=['"]([^'"]*)['"]/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function isEngineEntry(rawEntry) {
  const attrs = parseAttrs(rawEntry);
  const type = String(attrs.t || attrs.pt || "");
  return type === "e" || type === "m";
}

function extractEngineStateFromCar(car) {
  const allEntries = collectXmlEntries(car?.parts_xml || "");
  const engineEntries = allEntries.filter(isEngineEntry);
  const nonEngineEntries = allEntries.filter((entry) => !isEngineEntry(entry));
  const engineMarker = engineEntries.find((entry) => {
    const attrs = parseAttrs(entry);
    return String(attrs.t || attrs.pt || "") === "m";
  });
  const engineMarkerAttrs = parseAttrs(engineMarker || "");

  return {
    enginePartsXml: engineEntries.join(""),
    strippedCarPartsXml: nonEngineEntries.join(""),
    catalogEnginePartId: Number(engineMarkerAttrs.i || 0),
    engineTypeId: getEngineTypeIdForCar(car),
  };
}

async function listOwnedEnginesInternal(supabase, playerId) {
  try {
    let query = supabase
      .from("game_owned_engines")
      .select("*")
      .eq("player_id", Number(playerId));

    if (typeof query.order === "function") {
      query = query.order("id", { ascending: true });
    }

    return await manyResult(query, parseOwnedEngineRecord);
  } catch (error) {
    if (isMissingTableError(error, "game_owned_engines")) {
      return null;
    }
    throw error;
  }
}

export async function listOwnedEnginesForPlayer(supabase, playerId) {
  if (!supabase || !playerId) {
    return [];
  }
  return (await listOwnedEnginesInternal(supabase, playerId)) || [];
}

export async function getOwnedEngineById(supabase, engineId, playerId = null) {
  if (!supabase || !engineId) {
    return null;
  }
  try {
    let query = supabase
      .from("game_owned_engines")
      .select("*")
      .eq("id", Number(engineId));
    if (playerId) {
      query = query.eq("player_id", Number(playerId));
    }
    return await maybeSingle(query, parseOwnedEngineRecord);
  } catch (error) {
    if (isMissingTableError(error, "game_owned_engines")) {
      return null;
    }
    throw error;
  }
}

export async function createOwnedEngine(supabase, input = {}) {
  if (!supabase) {
    return null;
  }
  const insert = buildOwnedEngineInsert(input);
  if (!insert) {
    return null;
  }
  return singleResult(
    supabase
      .from("game_owned_engines")
      .insert(insert)
      .select("*"),
    parseOwnedEngineRecord,
  );
}

export async function updateOwnedEngineRecord(supabase, engineId, patchInput = {}) {
  if (!supabase || !engineId) {
    return null;
  }
  const patch = buildOwnedEnginePatch(patchInput);
  if (Object.keys(patch).length === 0) {
    return getOwnedEngineById(supabase, engineId);
  }
  return singleResult(
    supabase
      .from("game_owned_engines")
      .update(patch)
      .eq("id", Number(engineId))
      .select("*"),
    parseOwnedEngineRecord,
  );
}

export async function deleteOwnedEngine(supabase, engineId, playerId = null) {
  if (!supabase || !engineId) {
    return false;
  }
  let query = supabase
    .from("game_owned_engines")
    .delete()
    .eq("id", Number(engineId));
  if (playerId) {
    query = query.eq("player_id", Number(playerId));
  }
  const { error } = await query;
  if (error) {
    if (isMissingTableError(error, "game_owned_engines")) {
      return false;
    }
    throw error;
  }
  return true;
}

export async function ensureOwnedEnginesForCars(supabase, cars = []) {
  if (!supabase || cars.length === 0) {
    return [];
  }

  const carsByPlayerId = new Map();
  for (const car of cars) {
    const playerId = Number(car?.player_id || 0);
    if (!playerId) {
      continue;
    }
    const playerCars = carsByPlayerId.get(playerId) || [];
    playerCars.push(car);
    carsByPlayerId.set(playerId, playerCars);
  }

  const ensuredRows = [];
  for (const [playerId, playerCars] of carsByPlayerId.entries()) {
    const existingRows = await listOwnedEnginesInternal(supabase, playerId);
    if (existingRows === null) {
      continue;
    }

    const byInstalledCarId = new Map(
      existingRows
        .filter((row) => Number(row.installed_on_car_id || 0) > 0)
        .map((row) => [Number(row.installed_on_car_id), row]),
    );
    ensuredRows.push(...existingRows);

    for (const car of playerCars) {
      const carId = Number(car.game_car_id || 0);
      if (!carId) {
        continue;
      }

      const migrated = extractEngineStateFromCar(car);
      const existingRow = byInstalledCarId.get(carId);
      if (existingRow) {
        const expectedEnginePartsXml = String(existingRow.parts_xml || "") || migrated.enginePartsXml;
        const expectedEngineTypeId = getEngineTypeIdForCar({
          catalog_car_id: car.catalog_car_id,
          parts_xml: `${String(car.parts_xml || "")}${expectedEnginePartsXml}`,
        });
        const patch = {};
        if (expectedEnginePartsXml && expectedEnginePartsXml !== String(existingRow.parts_xml || "")) {
          patch.partsXml = expectedEnginePartsXml;
        }
        if (Number(existingRow.engine_type_id || 1) !== expectedEngineTypeId) {
          patch.engineTypeId = expectedEngineTypeId;
        }

        if (Object.keys(patch).length > 0) {
          const updated = await updateOwnedEngineRecord(supabase, existingRow.id, patch);
          if (updated) {
            byInstalledCarId.set(carId, updated);
            ensuredRows.splice(ensuredRows.indexOf(existingRow), 1, updated);
          }
        }
        continue;
      }

      const created = await createOwnedEngine(supabase, {
        playerId,
        installedOnCarId: carId,
        catalogEnginePartId: migrated.catalogEnginePartId,
        engineTypeId: migrated.engineTypeId,
        partsXml: migrated.enginePartsXml,
      });

      if (created) {
        byInstalledCarId.set(carId, created);
        ensuredRows.push(created);
        if (migrated.enginePartsXml && migrated.strippedCarPartsXml !== String(car.parts_xml || "")) {
          await singleResult(
            supabase
              .from("game_cars")
              .update(buildOwnedCarPatch({ partsXml: migrated.strippedCarPartsXml }))
              .eq("game_car_id", Number(carId))
              .select("*"),
            (value) => value,
          );
        }
      }
    }
  }

  return ensuredRows;
}

export async function attachOwnedEnginesToCars(supabase, cars = []) {
  if (!supabase || cars.length === 0) {
    return cars;
  }

  const ownedEngines = await ensureOwnedEnginesForCars(supabase, cars);
  const byInstalledCarId = new Map(
    ownedEngines
      .filter((row) => Number(row.installed_on_car_id || 0) > 0)
      .map((row) => [Number(row.installed_on_car_id), row]),
  );

  return cars.map((car) => {
    const ownedEngine = byInstalledCarId.get(Number(car.game_car_id || 0)) || null;
    if (!ownedEngine) {
      return car;
    }
    return {
      ...car,
      owned_engine_id: ownedEngine.id,
      engine_type_id: Number(ownedEngine.engine_type_id || 1),
      engine_parts_xml: String(ownedEngine.parts_xml || ""),
      installed_engine_id: ownedEngine.id,
    };
  });
}
