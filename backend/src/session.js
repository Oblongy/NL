import { randomUUID } from "node:crypto";

/** Sessions older than this are considered expired, even if not yet purged. */
const SESSION_TTL_DAYS = 7;

function sessionTtlCutoff() {
  return new Date(Date.now() - SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

async function maybeSingle(query) {
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

export async function getSessionPlayerId({ supabase, sessionKey }) {
  if (!supabase || !sessionKey) {
    return 0;
  }

  const existing = await maybeSingle(
    supabase
      .from("game_sessions")
      .select("player_id")
      .eq("session_key", sessionKey)
      .gte("last_seen_at", sessionTtlCutoff()),
  );

  return Number(existing?.player_id || 0);
}

export async function createLoginSession({ supabase, playerId }) {
  if (!supabase || !playerId) {
    return "";
  }

  const sessionKey = randomUUID();
  const { error } = await supabase.from("game_sessions").insert({
    session_key: sessionKey,
    player_id: Number(playerId),
  });

  if (error) {
    throw error;
  }

  return sessionKey;
}

/**
 * Delete sessions whose last_seen_at is older than `ttlDays` days.
 * Returns the number of rows deleted (or null if the count is unavailable).
 */
export async function purgeExpiredSessions({ supabase, ttlDays = SESSION_TTL_DAYS } = {}) {
  if (!supabase) return 0;
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from("game_sessions")
    .delete({ count: "exact" })
    .lt("last_seen_at", cutoff);
  if (error) throw error;
  return count ?? 0;
}

export async function validateOrCreateSession({ supabase, playerId, sessionKey }) {
  if (!supabase || !playerId || !sessionKey) {
    return false;
  }

  const existing = await maybeSingle(
    supabase
      .from("game_sessions")
      .select("session_key, player_id")
      .eq("session_key", sessionKey)
      .gte("last_seen_at", sessionTtlCutoff()),
  );

  // If session exists but belongs to different player, reject
  if (existing && Number(existing.player_id) !== Number(playerId)) {
    return false;
  }

  // If session doesn't exist, reject - sessions should only be created during login
  if (!existing) {
    return false;
  }

  // Update last seen timestamp for existing valid session
  const { error } = await supabase
    .from("game_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("session_key", sessionKey);

  if (error) {
    throw error;
  }

  return true;
}
