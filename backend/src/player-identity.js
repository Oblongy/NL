import { createHash, randomUUID } from "node:crypto";

export function normalizeUsername(username) {
  // Convert to lowercase for case-insensitive matching
  return String(username || "").trim().toLowerCase();
}

export function hashGamePassword(password) {
  return createHash("sha256").update(String(password || ""), "utf8").digest("hex");
}

export function verifyGamePassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  const normalized = String(storedHash).trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalized)) {
    return hashGamePassword(password) === normalized;
  }

  return String(password || "") === String(storedHash);
}

export function createSessionKey() {
  return randomUUID();
}
