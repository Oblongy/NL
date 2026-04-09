import { failureBody } from "./game-xml.js";
import { getSessionPlayerId, validateOrCreateSession } from "./session.js";
import { getPlayerById, getPlayerByUsername, listPlayersByIds } from "./user-service.js";
import { getPublicIdForPlayer } from "./public-id.js";

/**
 * Small helper functions extracted from game-actions.js
 * These are pure utilities with no side effects beyond database queries
 */

/**
 * Resolve internal player ID from public ID
 */
export async function resolveInternalPlayerIdByPublicId(supabase, publicId) {
  if (!supabase || !publicId) return null;
  const { data } = await supabase
    .from("game_players")
    .select("id")
    .eq("public_id", publicId)
    .maybeSingle();
  return data?.id || null;
}

/**
 * Resolve caller session - preserves exact existing response format
 * Returns { ok: true, player, playerId, publicId, sessionKey } on success
 * Returns { ok: false, body, source } on failure
 */
export async function resolveCallerSession(context, sourceLabel) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const sessionKey = params.get("sk") || "";
  const requestedPublicId = Number(params.get("aid") || 0);
  if (!sessionKey) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:missing-session` };
  }

  let playerId = await getSessionPlayerId({ supabase, sessionKey });
  if (!playerId && requestedPublicId) {
    playerId = await resolveInternalPlayerIdByPublicId(supabase, requestedPublicId);
  }

  if (!playerId) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:missing-player` };
  }

  const sessionOkay = await validateOrCreateSession({ supabase, playerId, sessionKey });
  if (!sessionOkay) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:bad-session` };
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:no-player` };
  }

  return {
    ok: true,
    player,
    playerId,
    publicId: getPublicIdForPlayer(player),
    sessionKey,
  };
}

/**
 * Resolve target player by public ID
 */
export async function resolveTargetPlayerByPublicId(supabase, publicId) {
  const playerId = await resolveInternalPlayerIdByPublicId(supabase, publicId);
  if (!playerId) {
    return null;
  }
  return getPlayerById(supabase, playerId);
}

/**
 * Attach owner public IDs to car records
 */
export async function attachOwnerPublicIds(supabase, cars) {
  const playerIds = [...new Set(cars.map((car) => Number(car.player_id)).filter((value) => value > 0))];
  const players = await listPlayersByIds(supabase, playerIds);
  const publicIdsByPlayerId = new Map(
    players.map((player) => [Number(player.id), getPublicIdForPlayer(player)]),
  );

  return cars.map((car) => ({
    ...car,
    owner_public_id: publicIdsByPlayerId.get(Number(car.player_id)) || Number(car.player_id) || 0,
  }));
}
