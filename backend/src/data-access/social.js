import {
  parseMailRecord,
  parseRaceHistoryRecord,
  parseRaceLogRecord,
  parseTransactionRecord,
} from "../db-models.js";
import {
  manyResult,
  safeSelectRows,
} from "./shared.js";

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
