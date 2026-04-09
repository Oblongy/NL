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
 * Require valid caller session - returns session info or error response
 */
export async function requireCaller(context, source) {
  const { supabase, params } = context;
  if (!supabase) {
    return fail(source, failureBody());
  }

  const sessionKey = params.get("sk") || "";
  const requestedPublicId = Number(params.get("aid") || 0);
  
  if (!sessionKey) {
    return fail(`${source}:missing-session`);
  }

  let playerId = await getSessionPlayerId({ supabase, sessionKey });
  if (!playerId && requestedPublicId) {
    playerId = await resolveInternalPlayerIdByPublicId(supabase, requestedPublicId);
  }

  if (!playerId) {
    return fail(`${source}:missing-player`);
  }

  const sessionOkay = await validateOrCreateSession({ supabase, playerId, sessionKey });
  if (!sessionOkay) {
    return fail(`${source}:bad-session`);
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return fail(`${source}:no-player`);
  }

  return ok({
    player,
    playerId,
    publicId: getPublicIdForPlayer(player),
    sessionKey,
  }, source);
}

/**
 * Require that the caller owns the specified car
 */
export async function requireOwnedCar(context, accountCarId, source) {
  const { supabase, getCarById } = context;
  const caller = await requireCaller(context, source);
  
  if (!caller.ok) {
    return caller;
  }

  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.data.playerId)) {
    return fail(`${source}:no-car`);
  }

  return ok({ ...caller.data, car }, source);
}

/**
 * Require valid player by public ID
 */
export async function requirePlayer(context, source) {
  const { supabase, params } = context;
  const targetPublicId = Number(params.get("tid") || params.get("aid") || 0);
  
  if (!targetPublicId) {
    return fail(`${source}:missing-target`);
  }

  const playerId = await resolveInternalPlayerIdByPublicId(supabase, targetPublicId);
  if (!playerId) {
    return fail(`${source}:not-found`);
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return fail(`${source}:not-found`);
  }

  return ok({ player, playerId, publicId: targetPublicId }, source);
}

/**
 * Success response helper
 */
export function ok(data, source) {
  return { ok: true, data, source };
}

/**
 * Failure response helper
 */
export function fail(source, body = failureBody()) {
  return { ok: false, body, source };
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
