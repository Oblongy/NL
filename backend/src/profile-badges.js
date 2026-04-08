import { getClientRoleForPlayer } from "./player-role.js";
import { escapeXml } from "./game-xml.js";

const BADGE_DEFINITIONS = [
  { id: 1, name: "Administrator", description: "Server staff account." },
  { id: 2, name: "VIP", description: "VIP account status is active." },
  { id: 3, name: "Veteran", description: "High street credit racer." },
  { id: 4, name: "Champion", description: "Has cleared at least one track rank." },
];

function normalizeBadgeId(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const id = Math.trunc(numeric);
  if (id <= 0) {
    return 0;
  }
  return id;
}

function normalizeBadgeCount(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  const count = Math.trunc(numeric);
  return count > 1 ? count : 1;
}

function parseBadgesJson(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  let parsed = rawValue;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      return null;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  // Supported shapes:
  // - [1,2,3]
  // - [{"i":1,"v":1,"n":2}, {"id":2,"count":1}]
  // - {"1":2,"2":1}
  // - {"badges":[...]}
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.badges)
      ? parsed.badges
      : null;

  const itemsById = new Map();

  if (list) {
    for (const entry of list) {
      if (typeof entry === "number" || typeof entry === "string") {
        const id = normalizeBadgeId(entry);
        if (!id) continue;
        itemsById.set(id, { id, visible: true, count: 1 });
        continue;
      }

      if (!entry || typeof entry !== "object") {
        continue;
      }

      const id = normalizeBadgeId(entry.i ?? entry.id ?? entry.badge_id);
      if (!id) {
        continue;
      }
      const visibleRaw = entry.v ?? entry.visible;
      const visible = visibleRaw === 0 || visibleRaw === "0" || visibleRaw === false ? false : true;
      const count = normalizeBadgeCount(entry.n ?? entry.count);

      const existing = itemsById.get(id);
      if (!existing) {
        itemsById.set(id, { id, visible, count });
      } else {
        // Merge duplicates by summing counts; visibility is sticky true.
        itemsById.set(id, {
          id,
          visible: existing.visible || visible,
          count: normalizeBadgeCount(existing.count + count),
        });
      }
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      const id = normalizeBadgeId(key);
      if (!id) continue;
      const count = normalizeBadgeCount(value);
      itemsById.set(id, { id, visible: true, count });
    }
  }

  const badges = [...itemsById.values()]
    .filter((badge) => badge.visible)
    .sort((left, right) => left.id - right.id);
  return badges.length ? badges : null;
}

function shouldShowBadge(player, badgeId) {
  switch (badgeId) {
    case 1:
      return getClientRoleForPlayer(player) === 1;
    case 2:
      return Number(player?.vip || 0) > 0;
    case 3:
      return Number(player?.score || 0) >= 100000;
    case 4:
      return Number(player?.track_rank || 0) > 0;
    default:
      return false;
  }
}

export function renderVisibleBadgesXml(player) {
  const manual = parseBadgesJson(player?.badges_json);
  if (manual) {
    return manual
      .map((badge) => `<b i='${badge.id}' v='1' n='${badge.count}'/>`)
      .join("");
  }

  return BADGE_DEFINITIONS
    .filter((badge) => shouldShowBadge(player, badge.id))
    .map((badge) => `<b i='${badge.id}' v='1' n='1'/>`)
    .join("");
}
