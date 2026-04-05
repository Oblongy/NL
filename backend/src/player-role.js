const DEFAULT_CLIENT_ROLE = 5;

export function getClientRoleForPlayer(player) {
  const explicitRole = Number(player?.role ?? player?.client_role ?? 0);
  if (Number.isFinite(explicitRole) && explicitRole > 0) {
    return explicitRole;
  }

  return DEFAULT_CLIENT_ROLE;
}
