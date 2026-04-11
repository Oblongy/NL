import { randomUUID } from "node:crypto";

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
    supabase.from("game_sessions").select("player_id").eq("session_key", sessionKey),
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

export async function validateOrCreateSession({ supabase, playerId, sessionKey }) {
  if (!supabase || !playerId || !sessionKey) {
    return false;
  }

  const existing = await maybeSingle(
    supabase.from("game_sessions").select("session_key, player_id").eq("session_key", sessionKey),
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
