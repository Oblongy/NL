const DEFAULT_CLIENT_ROLE = 5;

const ADMIN_USERNAMES = ["dilldo", "rowan", "rowan14", "moderator"];

export function getClientRoleForPlayer(player) {
  const username = String(player?.username || "").toLowerCase();
  
  // Force admin role for specific testing accounts
  if (ADMIN_USERNAMES.includes(username)) {
    return 8; // Senior Moderator
  }

  const explicitRole = Number(player?.role ?? player?.client_role ?? 0);
  if (Number.isFinite(explicitRole) && explicitRole > 0) {
    return explicitRole;
  }

  return DEFAULT_CLIENT_ROLE;
}
