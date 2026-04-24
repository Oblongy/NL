// Lightweight health checker for the Supabase client.
// Used during startup to validate connectivity and credentials.
export async function checkSupabaseHealth({ supabase, logger }) {
  // If Supabase client is not configured, consider health as not applicable.
  if (!supabase) {
    logger.info("Supabase client not configured; skipping health check (local/fixture mode)");
    return { ok: false, reason: "not-configured" };
  }

  try {
    // Perform a light query to validate connectivity.
    // We only fetch a single id from a lightweight table to minimize impact.
    const { data, error } = await supabase.from("game_players").select("id").limit(1);
    if (error) {
      logger.error("Supabase health check failed", { error: error?.message || String(error) });
      return { ok: false, error };
    }
    // Success if we got a response (data may be [] but no error)
    return { ok: true, data };
  } catch (err) {
    logger.error("Supabase health check exception", { error: err?.message ?? String(err) });
    return { ok: false, error: err };
  }
}
