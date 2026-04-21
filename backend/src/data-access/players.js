import {
  buildPlayerInsert,
  buildPlayerPatch,
  parsePlayerRecord,
} from "../db-models.js";
import {
  isMissingWinsLossesColumnError,
  manyResult,
  maybeSingle,
  singleResult,
  sortByRequestedOrder,
  toNumericIds,
} from "./shared.js";

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
    return await singleResult(
      supabase.from("game_players").insert(insert).select("*"),
      parsePlayerRecord,
    );
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/client_role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
      const { client_role: _ignored, ...withoutRole } = insert;
      return singleResult(
        supabase.from("game_players").insert(withoutRole).select("*"),
        parsePlayerRecord,
      );
    }
    throw error;
  }
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

export async function applyPlayerRaceResult(
  supabase,
  playerId,
  { scoreDelta = 0, won = false, lost = false } = {},
) {
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
