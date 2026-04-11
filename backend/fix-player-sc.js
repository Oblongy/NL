import { createGameSupabase } from "./src/supabase-client.js";
import { config } from "./src/config.js";

const logger = {
  info: (...args) => console.log("[INFO]", ...args),
  warn: (...args) => console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args),
};

const supabase = await createGameSupabase(config, logger);

if (!supabase) {
  console.error("❌ Supabase not configured");
  process.exit(1);
}

const playerId = 14;

console.log("Updating player score to 5000...");

const { error } = await supabase
  .from("game_players")
  .update({ score: 5000 })
  .eq("id", playerId);

if (error) {
  console.error("❌ Error updating score:", error);
  process.exit(1);
}

const { data: player } = await supabase
  .from("game_players")
  .select("username, score, points, money")
  .eq("id", playerId)
  .single();

console.log("✅ Score updated successfully!");
console.log("\nPlayer:", player.username);
console.log("Street Credit (Score):", player.score);
console.log("Points:", player.points);
console.log("Money:", player.money);
