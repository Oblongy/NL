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

  // Legacy plaintext: compare directly but flag for migration
  return String(password || "") === String(storedHash);
}

/**
 * Returns true when the stored value is NOT a SHA-256 hex hash,
 * meaning the account still has a plaintext password that should be migrated.
 */
export function isPlaintextPassword(storedHash) {
  if (!storedHash) return false;
  return !/^[a-f0-9]{64}$/.test(String(storedHash).trim().toLowerCase());
}

export function createSessionKey() {
  return randomUUID();
}
