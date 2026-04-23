import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(currentDir, "..");
const projectRoot = resolve(backendRoot, "..");

function parseBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function loadDotEnvFile() {
  const envPath = resolve(backendRoot, ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  const values = {};
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }

  return values;
}

const fileEnv = loadDotEnvFile();
const env = { ...fileEnv, ...process.env };

export const config = {
  httpHost: env.HTTP_HOST || env.HOST || "127.0.0.1",
  port: Number(env.PORT || 8082),
  tcpHost: env.TCP_HOST || env.HOST || "127.0.0.1",
  tcpPort: Number(env.TCP_PORT || 3724), // Default to 3724 (standard Nitto TCP port)
  useFixtures: parseBooleanEnv(env.USE_FIXTURES, true),
  supabaseUrl: env.SUPABASE_URL || "",
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
  backendRoot,
  projectRoot,
};
