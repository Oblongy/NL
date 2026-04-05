export function getLegacyPublicIdForUsername() {
  return 0;
}

export function getLegacyUsernameForPublicId() {
  return "";
}

export function getPublicIdForPlayer(player) {
  return Number(player?.id || 0);
}
