export async function createGameSupabase(config, logger) {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    logger.warn(
      "Supabase credentials are missing. The backend will run in limited local mode until .env is configured.",
    );
    return null;
  }

  let createClient;
  try {
    ({ createClient } = await import("@supabase/supabase-js"));
  } catch (error) {
    logger.warn(
      "The @supabase/supabase-js package is not installed yet. Run npm install inside backend before enabling live Supabase access.",
      String(error),
    );
    return null;
  }

  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
