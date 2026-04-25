import { escapeXml, failureBody, renderTeams, wrapSuccessData } from "../game-xml.js";
import { resolveCallerSession, resolveTargetPlayerByPublicId } from "../game-actions-helpers.js";
import { FULL_CAR_CATALOG } from "../car-catalog.js";
import {
  countUnreadMailForRecipient,
  createMailRecord,
  createRemarkRecord,
  deleteMailForRecipient,
  deleteRemarkRecord,
  getMailByIdForRecipient,
  getRemarkById,
  listLeaderboardCars as listLeaderboardCarsFromService,
  listLeaderboardPlayers as listLeaderboardPlayersFromService,
  listLeaderboardTeams as listLeaderboardTeamsFromService,
  listMailForRecipient,
  listRemarksForTarget,
  markMailReadForRecipient,
  listPlayersByIds,
  listRaceHistorySince as listRaceHistorySinceFromService,
  listRaceLogsSince as listRaceLogsSinceFromService,
  listTeamMembersForTeams,
  listTeamsByIds,
  listTransactionsSince as listTransactionsSinceFromService,
} from "../user-service.js";
import { getMarqueeXml } from "../announcement-service.js";
import { getPublicIdForPlayer } from "../public-id.js";
import { renderVisibleBadgesXml } from "../profile-badges.js";

const LEADERBOARD_TOP_COUNT = 10;
const LEADERBOARD_TOP_FLAG_COUNT = 3;

const RACER_CATEGORY_MENU_ITEMS = [
  { n: "Street Credit" },
  { n: "Net Wealth" },
  { n: "King of the Hill" },
  { n: "Fastest Cars" },
];

const TEAM_CATEGORY_MENU_ITEMS = [
  { n: "Street Credit" },
  { n: "Wealth Gain" },
  { n: "Fastest Teams" },
  { n: "Members" },
  { n: "Badges" },
  { n: "Wins" },
];

const PERIOD_MENU_ITEMS = [
  { n: "Overall", t: "All", c: 0 },
  { n: "Today", t: "Day", c: 1 },
  { n: "This Week", t: "Week", c: 1 },
];

const PERIOD_MENU_RECENT_ITEMS = [
  { n: "Today", t: "Day", c: 1 },
  { n: "This Week", t: "Week", c: 1 },
];

const STOCK_ENGINE_TYPE_BY_CAR_ID = new Map([
  ["5", "s"],
  ["11", "t"],
  ["14", "t"],
  ["21", "t"],
  ["38", "t"],
  ["68", "s"],
  ["72", "t"],
  ["86", "t"],
  ["87", "t"],
  ["89", "t"],
  ["90", "t"],
  ["91", "t"],
  ["92", "t"],
  ["98", "t"],
  ["101", "t"],
]);

function xmlAttrs(attrs = {}) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}='${escapeXml(value)}'`)
    .join(" ");
}

function xmlLeaf(name, attrs = {}) {
  const attrsStr = xmlAttrs(attrs);
  return attrsStr ? `<${name} ${attrsStr}/>` : `<${name}/>`;
}

function xmlNode(name, attrs = {}, children = "") {
  const attrsStr = xmlAttrs(attrs);
  return attrsStr
    ? `<${name} ${attrsStr}>${children}</${name}>`
    : `<${name}>${children}</${name}>`;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeInteger(value, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function sortDescByMetric(entries) {
  return [...entries].sort((left, right) => {
    if (right.metric !== left.metric) {
      return right.metric - left.metric;
    }
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function sortAscByMetric(entries) {
  return [...entries].sort((left, right) => {
    if (left.metric !== right.metric) {
      return left.metric - right.metric;
    }
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
}

function applyTopFlags(entries, periodType) {
  if (entries.length === 0) {
    return entries;
  }

  if (periodType === "All") {
    const leaderMetric = entries[0].metric;
    return entries.map((entry) => ({
      ...entry,
      tf: entry.metric === leaderMetric ? 1 : 0,
    }));
  }

  return entries.map((entry, index) => ({
    ...entry,
    tf: index < LEADERBOARD_TOP_FLAG_COUNT ? 1 : 0,
  }));
}

function takeTopEntries(entries) {
  return entries.slice(0, LEADERBOARD_TOP_COUNT);
}

function buildSimpleLeaderboardXml(reportType, rows, rowTag = "r") {
  return xmlNode(
    "leaderboard",
    { id: reportType },
    xmlNode("rows", {}, rows.map((row) => xmlLeaf(rowTag, row)).join("")),
  );
}

function buildKingOfHillXml(bracketRows, headToHeadRows) {
  return xmlNode(
    "leaderboard",
    { id: "ks" },
    `${xmlNode("g", { t: "b" }, bracketRows.map((row) => xmlLeaf("r", row)).join(""))}` +
      `${xmlNode("g", { t: "h" }, headToHeadRows.map((row) => xmlLeaf("r", row)).join(""))}`,
  );
}

function buildFastestCarsXml(groupedRows) {
  return xmlNode(
    "leaderboard",
    { id: "fc" },
    ["n", "t", "s"]
      .map((engineType) => xmlNode("g", { e: engineType }, (groupedRows.get(engineType) || []).map((row) => xmlLeaf("r", row)).join("")))
      .join(""),
  );
}

function buildFastestTeamsXml(groupedRows) {
  return xmlNode(
    "leaderboard",
    { id: "tft" },
    xmlNode(
      "rows",
      {},
      ["f2v2", "f3v3", "f4v4"]
        .map((bucket) => xmlNode("g", { t: bucket }, (groupedRows.get(bucket) || []).map((row) => xmlLeaf("r", row)).join("")))
        .join(""),
    ),
  );
}

function buildLeaderboardMenuXml() {
  const carMenuItems = [
    { cid: 0, n: "Overall" },
    ...FULL_CAR_CATALOG.map(([catalogCarId, name]) => ({
      cid: normalizeInteger(catalogCarId),
      n: name,
    })),
  ];

  return xmlNode(
    "menu",
    { tc: LEADERBOARD_TOP_COUNT, ttc: LEADERBOARD_TOP_FLAG_COUNT },
    [
      xmlNode("racerCategoriesMenu", { id: "racerCategoriesMenu" }, RACER_CATEGORY_MENU_ITEMS.map((item) => xmlLeaf("i", item)).join("")),
      xmlNode("teamCategoriesMenu", { id: "teamCategoriesMenu" }, TEAM_CATEGORY_MENU_ITEMS.map((item) => xmlLeaf("i", item)).join("")),
      xmlNode("periodMenu", { id: "periodMenu" }, PERIOD_MENU_ITEMS.map((item) => xmlLeaf("i", item)).join("")),
      xmlNode("periodMenu2", { id: "periodMenu2" }, PERIOD_MENU_RECENT_ITEMS.map((item) => xmlLeaf("i", item)).join("")),
      xmlNode("carMenu", { id: "carMenu" }, carMenuItems.map((item) => xmlLeaf("i", item)).join("")),
    ].join(""),
  );
}

function normalizePeriodContext(params) {
  const rawType = String(params.get("t") || "All").trim();
  const rawCount = normalizeInteger(params.get("p"), 0);

  if (/^day$/i.test(rawType)) {
    return {
      periodType: "Day",
      periodCount: Math.max(1, rawCount || 1),
      sinceIso: new Date(Date.now() - Math.max(1, rawCount || 1) * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  if (/^week$/i.test(rawType)) {
    const weeks = Math.max(1, rawCount || 1);
    return {
      periodType: "Week",
      periodCount: weeks,
      sinceIso: new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  return {
    periodType: "All",
    periodCount: 0,
    sinceIso: null,
  };
}

async function listLeaderboardPlayers(supabase) {
  return listLeaderboardPlayersFromService(supabase);
}

async function listLeaderboardCars(supabase) {
  return listLeaderboardCarsFromService(supabase);
}

async function listLeaderboardTeams(supabase) {
  return listLeaderboardTeamsFromService(supabase);
}

async function listTransactionsSince(supabase, sinceIso) {
  return listTransactionsSinceFromService(supabase, sinceIso);
}

async function listRaceHistorySince(supabase, sinceIso) {
  return listRaceHistorySinceFromService(supabase, sinceIso);
}

async function listRaceLogsSince(supabase, sinceIso) {
  return listRaceLogsSinceFromService(supabase, sinceIso);
}

function accumulateMetricByPlayer(rows, valueKey) {
  if (!rows) {
    return null;
  }

  const totals = new Map();
  for (const row of rows) {
    const playerId = normalizeInteger(row?.player_id, 0);
    if (!playerId) {
      continue;
    }

    totals.set(playerId, toNumber(totals.get(playerId), 0) + toNumber(row?.[valueKey], 0));
  }
  return totals;
}

function normalizeElapsedTimeMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return numeric >= 1000 ? Math.round(numeric) : Math.round(numeric * 1000);
}

function formatElapsedTime(valueMs) {
  const elapsedMs = normalizeElapsedTimeMs(valueMs);
  return elapsedMs > 0 ? (elapsedMs / 1000).toFixed(3) : "0.000";
}

function buildRaceEntriesFromHistory(rows) {
  return (rows || []).map((row) => ({
    playerId: normalizeInteger(row?.player_id, 0),
    timeMs: normalizeElapsedTimeMs(row?.time_ms),
    won: Boolean(row?.won),
    raceType: String(row?.race_type || "").toLowerCase(),
    occurredAt: row?.raced_at || "",
    carId: normalizeInteger(row?.car_id, 0),
  })).filter((row) => row.playerId > 0);
}

function buildRaceEntriesFromLogs(rows) {
  const entries = [];

  for (const row of rows || []) {
    const playerOneId = normalizeInteger(row?.player_1_id, 0);
    const playerTwoId = normalizeInteger(row?.player_2_id, 0);
    const winnerId = normalizeInteger(row?.winner_id, 0);
    const occurredAt = row?.created_at || "";

    if (playerOneId > 0) {
      entries.push({
        playerId: playerOneId,
        timeMs: normalizeElapsedTimeMs(row?.player_1_time),
        won: winnerId === playerOneId,
        raceType: "quick",
        occurredAt,
        carId: 0,
      });
    }

    if (playerTwoId > 0) {
      entries.push({
        playerId: playerTwoId,
        timeMs: normalizeElapsedTimeMs(row?.player_2_time),
        won: winnerId === playerTwoId,
        raceType: "quick",
        occurredAt,
        carId: 0,
      });
    }
  }

  return entries;
}

function pickRaceEntries(historyRows, logRows) {
  if (historyRows && historyRows.length > 0) {
    return buildRaceEntriesFromHistory(historyRows);
  }

  if (logRows && logRows.length > 0) {
    return buildRaceEntriesFromLogs(logRows);
  }

  return [];
}

function buildBestTimeByPlayer(entries) {
  const bestTimeByPlayer = new Map();

  for (const entry of entries) {
    if (entry.playerId <= 0 || entry.timeMs <= 0) {
      continue;
    }

    const previous = bestTimeByPlayer.get(entry.playerId);
    if (!previous || entry.timeMs < previous.timeMs) {
      bestTimeByPlayer.set(entry.playerId, entry);
    }
  }

  return bestTimeByPlayer;
}

function buildMaxWinStreakByPlayer(entries) {
  const rowsByPlayer = new Map();

  for (const entry of entries) {
    if (entry.playerId <= 0) {
      continue;
    }

    const normalizedRaceType = String(entry.raceType || "").toLowerCase();
    if (normalizedRaceType === "practice" || normalizedRaceType === "team") {
      continue;
    }

    if (!rowsByPlayer.has(entry.playerId)) {
      rowsByPlayer.set(entry.playerId, []);
    }
    rowsByPlayer.get(entry.playerId).push(entry);
  }

  const streakByPlayer = new Map();

  for (const [playerId, rows] of rowsByPlayer.entries()) {
    rows.sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime());

    let current = 0;
    let best = 0;
    for (const row of rows) {
      if (row.won) {
        current += 1;
        if (current > best) {
          best = current;
        }
      } else {
        current = 0;
      }
    }

    if (best > 0) {
      streakByPlayer.set(playerId, best);
    }
  }

  return streakByPlayer;
}

function countVisibleBadges(player) {
  const badgesXml = renderVisibleBadgesXml(player);
  if (!badgesXml) {
    return 0;
  }

  const matches = [...badgesXml.matchAll(/<b\b[^>]*\bn='([^']+)'[^>]*\/?>/gi)];
  if (matches.length > 0) {
    return matches.reduce((sum, match) => sum + Math.max(1, normalizeInteger(match[1], 1)), 0);
  }

  return (badgesXml.match(/<b\b/gi) || []).length;
}

function inferEngineTypeForCar(car) {
  const catalogCarId = String(car?.catalog_car_id || "").trim();
  return STOCK_ENGINE_TYPE_BY_CAR_ID.get(catalogCarId) || "n";
}

function getPreferredCarByPlayer(cars) {
  const preferredByPlayer = new Map();

  for (const car of cars || []) {
    const playerId = normalizeInteger(car?.player_id, 0);
    if (!playerId) {
      continue;
    }

    const current = preferredByPlayer.get(playerId);
    if (!current || car.selected) {
      preferredByPlayer.set(playerId, car);
    }
  }

  return preferredByPlayer;
}

function buildStreetCreditRows(players, periodType, pointDeltasByPlayer) {
  const usesPointDeltas = periodType !== "All" && pointDeltasByPlayer instanceof Map;
  const ranked = applyTopFlags(
    sortDescByMetric(
      players.map((player) => ({
        id: getPublicIdForPlayer(player),
        name: player.username,
        metric: usesPointDeltas ? toNumber(pointDeltasByPlayer.get(Number(player.id)), 0) : toNumber(player.score, 0),
      })),
    ),
    periodType,
  );

  return takeTopEntries(ranked).map((entry) => ({
    i: entry.id,
    n: entry.name,
    tf: entry.tf,
    sc: normalizeInteger(entry.metric, 0),
  }));
}

function buildBallerRows(players, cars, periodType, moneyDeltasByPlayer) {
  const carCountByPlayer = new Map();
  const carValueByPlayer = new Map();

  for (const car of cars || []) {
    const playerId = normalizeInteger(car?.player_id, 0);
    if (!playerId) {
      continue;
    }

    carCountByPlayer.set(playerId, normalizeInteger(carCountByPlayer.get(playerId), 0) + 1);
    const priceEntry = FULL_CAR_CATALOG.find(([catalogCarId]) => Number(catalogCarId) === Number(car.catalog_car_id));
    const catalogPrice = priceEntry ? toNumber(priceEntry[2], 0) : 0;
    carValueByPlayer.set(playerId, toNumber(carValueByPlayer.get(playerId), 0) + catalogPrice);
  }

  const usesMoneyDeltas = periodType !== "All" && moneyDeltasByPlayer instanceof Map;
  const ranked = applyTopFlags(
    sortDescByMetric(
      players.map((player) => {
        const playerId = Number(player.id);
        const netWorth = toNumber(player.money, 0) + toNumber(carValueByPlayer.get(playerId), 0);
        return {
          id: getPublicIdForPlayer(player),
          name: player.username,
          locationId: normalizeInteger(player.location_id, 100),
          carCount: normalizeInteger(carCountByPlayer.get(playerId), 0),
          metric: usesMoneyDeltas ? toNumber(moneyDeltasByPlayer.get(playerId), 0) : netWorth,
        };
      }),
    ),
    periodType,
  );

  return takeTopEntries(ranked).map((entry) => ({
    i: entry.id,
    n: entry.name,
    tf: entry.tf,
    nw: normalizeInteger(entry.metric, 0),
    nc: entry.carCount,
    lid: entry.locationId,
  }));
}

function buildKingOfTheHillRows(players, raceEntries, periodType) {
  const playersById = new Map((players || []).map((player) => [Number(player.id), player]));
  const streakByPlayer = buildMaxWinStreakByPlayer(raceEntries);

  const ranked = applyTopFlags(
    sortDescByMetric(
      [...streakByPlayer.entries()].map(([playerId, streak]) => ({
        id: getPublicIdForPlayer(playersById.get(playerId)),
        name: playersById.get(playerId)?.username || "",
        metric: normalizeInteger(streak, 0),
      })).filter((entry) => entry.id > 0 && entry.metric > 0),
    ),
    periodType,
  );

  const headToHeadRows = takeTopEntries(ranked).map((entry) => ({
    i: entry.id,
    n: entry.name,
    tf: entry.tf,
    s: entry.metric,
  }));

  return {
    bracketRows: [],
    headToHeadRows,
  };
}

function buildFastestCarsRows(players, cars, raceEntries, periodType, catalogCarFilterId) {
  const playersById = new Map((players || []).map((player) => [Number(player.id), player]));
  const carsById = new Map((cars || []).map((car) => [Number(car.game_car_id), car]));
  const preferredCarByPlayer = getPreferredCarByPlayer(cars);
  const bestTimeByPlayer = buildBestTimeByPlayer(raceEntries);
  const entries = [];

  for (const bestEntry of bestTimeByPlayer.values()) {
    const player = playersById.get(bestEntry.playerId);
    if (!player) {
      continue;
    }

    let car = bestEntry.carId ? carsById.get(bestEntry.carId) : null;
    if (!car) {
      car = preferredCarByPlayer.get(bestEntry.playerId) || null;
    }
    if (!car) {
      continue;
    }

    if (catalogCarFilterId > 0 && Number(car.catalog_car_id) !== Number(catalogCarFilterId)) {
      continue;
    }

    entries.push({
      id: getPublicIdForPlayer(player),
      name: player.username,
      accountCarId: normalizeInteger(car.game_car_id, 0),
      catalogCarId: normalizeInteger(car.catalog_car_id, 0),
      engineType: inferEngineTypeForCar(car),
      metric: normalizeElapsedTimeMs(bestEntry.timeMs),
    });
  }

  const ranked = applyTopFlags(sortAscByMetric(entries), periodType);
  const groupedRows = new Map([
    ["n", []],
    ["t", []],
    ["s", []],
  ]);

  for (const entry of ranked) {
    const bucket = groupedRows.get(entry.engineType);
    if (!bucket || bucket.length >= LEADERBOARD_TOP_COUNT) {
      continue;
    }

    bucket.push({
      i: entry.id,
      n: entry.name,
      tf: entry.tf,
      et: entry.metric,
      c: entry.catalogCarId,
      ac: entry.accountCarId,
    });
  }

  return groupedRows;
}

function buildTeamRows(teams, teamMembers, playersById, valueSelector, periodType, valueAttr) {
  const memberCountByTeam = new Map();
  for (const member of teamMembers || []) {
    const teamId = normalizeInteger(member?.team_id, 0);
    if (!teamId) {
      continue;
    }
    memberCountByTeam.set(teamId, normalizeInteger(memberCountByTeam.get(teamId), 0) + 1);
  }

  const ranked = sortDescByMetric(
    (teams || []).map((team) => ({
      id: normalizeInteger(team.id, 0),
      name: team.name,
      team,
      metric: toNumber(valueSelector(team, memberCountByTeam.get(Number(team.id)) || 0, playersById), 0),
    })),
  );

  return takeTopEntries(ranked).map((entry) => ({
    i: entry.id,
    n: entry.name,
    [valueAttr]: normalizeInteger(entry.metric, 0),
  }));
}

function buildFastestTeamRows(teams, teamMembers, raceEntries) {
  const teamIdByPlayerId = new Map();
  for (const member of teamMembers || []) {
    const playerId = normalizeInteger(member?.player_id, 0);
    const teamId = normalizeInteger(member?.team_id, 0);
    if (playerId > 0 && teamId > 0) {
      teamIdByPlayerId.set(playerId, teamId);
    }
  }

  const bestTimeByTeam = new Map();
  for (const entry of buildBestTimeByPlayer(raceEntries).values()) {
    const teamId = teamIdByPlayerId.get(entry.playerId);
    if (!teamId || entry.timeMs <= 0) {
      continue;
    }

    const previous = bestTimeByTeam.get(teamId);
    if (!previous || entry.timeMs < previous) {
      bestTimeByTeam.set(teamId, entry.timeMs);
    }
  }

  const ranked = sortAscByMetric(
    (teams || [])
      .filter((team) => bestTimeByTeam.has(Number(team.id)))
      .map((team) => ({
        id: normalizeInteger(team.id, 0),
        name: team.name,
        metric: bestTimeByTeam.get(Number(team.id)),
      })),
  );

  const rows = takeTopEntries(ranked).map((entry) => ({
    i: entry.id,
    n: entry.name,
    t: formatElapsedTime(entry.metric),
  }));

  return new Map([
    ["f2v2", rows],
    ["f3v3", rows],
    ["f4v4", rows],
  ]);
}

function emptyLeaderboardXml(reportType) {
  switch (reportType) {
    case "ks":
      return buildKingOfHillXml([], []);
    case "fc":
      return buildFastestCarsXml(new Map([["n", []], ["t", []], ["s", []]]));
    case "tft":
      return buildFastestTeamsXml(new Map([["f2v2", []], ["f3v3", []], ["f4v4", []]]));
    default:
      return buildSimpleLeaderboardXml(reportType, []);
  }
}

export async function handleGetTotalNewMail(context) {
  const { supabase } = context;
  let caller = null;

  if (supabase) {
    caller = await resolveCallerSession(context, "supabase:gettotalnewmail");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:gettotalnewmail:bad-session",
      };
    }

    try {
      const unreadCount = await countUnreadMailForRecipient(supabase, {
        recipientPlayerId: caller.playerId,
        folder: "inbox",
      });

      return {
        body: `"s", 1, "im", "${unreadCount}"`,
        source: "supabase:gettotalnewmail",
      };
    } catch (error) {
      context.logger?.error("Get total new mail error", {
        playerId: caller.playerId,
        error: error?.message || String(error),
      });
      return { body: failureBody(), source: "supabase:gettotalnewmail:error" };
    }
  }

  return {
    body: `"s", 1, "im", "0"`,
    source: "gettotalnewmail:zero",
  };
}

export async function handleGetRemarks(context) {
  return handleGetRemarksForTarget(context, "supabase:getremarks");
}

function parseRemarkTargetPublicId(params, fallbackPublicId = 0) {
  const candidates = ["tid", "aid", "uid", "id", "i", "pid", "playerid"];
  for (const key of candidates) {
    const value = Number(params.get(key) || 0);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return Number(fallbackPublicId || 0);
}

function parseRemarkBody(params) {
  const candidates = ["r", "remark", "remarks", "t", "txt", "text", "b", "body"];
  for (const key of candidates) {
    const value = String(params.get(key) || "").replace(/\r\n/g, "\n").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function renderRemarksXml(remarks, authorsById = new Map(), targetPublicId = 0) {
  if (!Array.isArray(remarks) || remarks.length === 0) {
    return `<remarks uid='${targetPublicId}' c='0'/>`;
  }

  const nodes = remarks.map((remark) => {
    const author = authorsById.get(Number(remark.author_player_id)) || null;
    const authorPublicId = author ? getPublicIdForPlayer(author) : Number(remark.author_player_id || 0);
    const authorUsername = String(author?.username || "");
    const createdAt = remark?.created_at ? Math.floor(new Date(remark.created_at).getTime() / 1000) : 0;
    const body = escapeXml(remark?.body || "");

    return (
      `<r i='${Number(remark.id || 0)}' arid='${Number(remark.id || 0)}' ai='${authorPublicId}' ` +
      `uid='${authorPublicId}' u='${escapeXml(authorUsername)}' un='${escapeXml(authorUsername)}' ` +
      `d='${createdAt}' t='${body}'><b>${body}</b></r>`
    );
  }).join("");

  return `<remarks uid='${targetPublicId}' c='${remarks.length}'>${nodes}</remarks>`;
}

async function handleGetRemarksForTarget(context, sourceLabel) {
  const { supabase, params } = context;
  if (!supabase) {
    return {
      body: wrapSuccessData("<remarks/>"),
      source: `${sourceLabel}:no-supabase`,
    };
  }

  const caller = await resolveCallerSession(context, sourceLabel);
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || `${sourceLabel}:bad-session` };
  }

  const targetPublicId = parseRemarkTargetPublicId(params, caller.publicId);
  const targetPlayer = Number(targetPublicId) === Number(caller.publicId)
    ? caller.player
    : await resolveTargetPlayerByPublicId(supabase, targetPublicId);

  if (!targetPlayer) {
    return {
      body: wrapSuccessData("<remarks/>"),
      source: `${sourceLabel}:target-not-found`,
    };
  }

  const page = Number(params.get("p") || 0);
  const pageSize = 50;

  try {
    const remarks = await listRemarksForTarget(supabase, {
      targetPlayerId: targetPlayer.id,
      page,
      pageSize,
    });
    const authorIds = [...new Set(
      (remarks || []).map((remark) => Number(remark.author_player_id || 0)).filter((value) => value > 0),
    )];
    const authors = authorIds.length > 0 ? await listPlayersByIds(supabase, authorIds) : [];
    const authorsById = new Map(authors.map((player) => [Number(player.id), player]));

    return {
      body: wrapSuccessData(renderRemarksXml(remarks || [], authorsById, getPublicIdForPlayer(targetPlayer))),
      source: sourceLabel,
    };
  } catch (error) {
    context.logger?.error("Get remarks error", {
      sourceLabel,
      targetPublicId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: `${sourceLabel}:error` };
  }
}

export async function handleGetUserRemarks(context) {
  return handleGetRemarksForTarget(context, "supabase:getuserremarks");
}

export async function handleAddRemark(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 1`, source: "generated:addremark:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:addremark");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:addremark:bad-session" };
  }

  const targetPublicId = parseRemarkTargetPublicId(params, 0);
  const bodyText = parseRemarkBody(params);
  if (!targetPublicId || !bodyText) {
    return { body: `"s", 1`, source: `supabase:addremark:${!targetPublicId ? "missing-target" : "empty-body"}` };
  }

  const targetPlayer = await resolveTargetPlayerByPublicId(supabase, targetPublicId);
  if (!targetPlayer) {
    return { body: `"s", 1`, source: "supabase:addremark:target-not-found" };
  }

  try {
    await createRemarkRecord(supabase, {
      targetPlayerId: targetPlayer.id,
      authorPlayerId: caller.playerId,
      body: bodyText,
    });

    return { body: `"s", 1`, source: "supabase:addremark" };
  } catch (error) {
    context.logger?.error("Add remark error", {
      targetPublicId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:addremark:error" };
  }
}

export async function handleDeleteRemark(context) {
  const { supabase, params } = context;
  const remarkId = String(params.get("arid") || params.get("id") || "0");

  if (!supabase) {
    return { body: `"s", 1, "arid", "${remarkId}"`, source: "generated:deleteremark:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:deleteremark");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:deleteremark:bad-session" };
  }

  try {
    const remark = await getRemarkById(supabase, Number(remarkId));
    if (!remark) {
      return { body: `"s", 1, "arid", "${remarkId}"`, source: "supabase:deleteremark:not-found" };
    }

    const callerOwnsRemark = Number(remark.author_player_id || 0) === Number(caller.playerId);
    const callerOwnsProfile = Number(remark.target_player_id || 0) === Number(caller.playerId);
    if (!callerOwnsRemark && !callerOwnsProfile) {
      return { body: `"s", 1, "arid", "${remarkId}"`, source: "supabase:deleteremark:denied" };
    }

    await deleteRemarkRecord(supabase, Number(remarkId));
    return { body: `"s", 1, "arid", "${remarkId}"`, source: "supabase:deleteremark" };
  } catch (error) {
    context.logger?.error("Delete remark error", {
      remarkId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:deleteremark:error" };
  }
}

function renderEmailDetailXml(email, fallbackEmailId = 0) {
  const emailId = Number(email?.id || fallbackEmailId || 0);
  const senderPlayerId = Number(email?.sender_player_id || 0);
  const createdAtSeconds = email?.created_at
    ? Math.floor(new Date(email.created_at).getTime() / 1000)
    : 0;

  return (
    `<email i='${emailId}' s='${escapeXml(email?.subject || "")}' ` +
    `b='${escapeXml(email?.body || "")}' si='${senderPlayerId}' d='${createdAtSeconds}'/>`
  );
}

export async function handleGetEmail(context) {
  const { supabase, params } = context;
  const emailId = Number(params.get("eid") || 0);

  if (!supabase) {
    return {
      body: wrapSuccessData(renderEmailDetailXml(null, emailId)),
      source: "generated:getemail:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:getemail");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getemail:bad-session" };
  }

  if (!emailId) {
    return {
      body: wrapSuccessData(renderEmailDetailXml(null, 0)),
      source: "supabase:getemail:missing-id",
    };
  }

  try {
    const email = await getMailByIdForRecipient(supabase, {
      mailId: emailId,
      recipientPlayerId: caller.playerId,
    });

    return {
      body: wrapSuccessData(renderEmailDetailXml(email, emailId)),
      source: email ? "supabase:getemail" : "supabase:getemail:not-found",
    };
  } catch (error) {
    context.logger?.error("Get email error", {
      emailId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:getemail:error" };
  }
}

export async function handleMarkEmailRead(context) {
  const { supabase, params } = context;
  const emailId = Number(params.get("eid") || 0);

  if (!supabase) {
    return {
      body: `"s", 1`,
      source: "generated:markemailread:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:markemailread");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:markemailread:bad-session",
    };
  }

  if (!emailId) {
    return {
      body: `"s", 1`,
      source: "supabase:markemailread:missing-id",
    };
  }

  try {
    const updated = await markMailReadForRecipient(supabase, {
      mailId: emailId,
      recipientPlayerId: caller.playerId,
    });

    return {
      body: `"s", 1`,
      source: updated ? "supabase:markemailread" : "supabase:markemailread:not-found",
    };
  } catch (error) {
    context.logger?.error("Mark email read error", {
      emailId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:markemailread:error" };
  }
}

export async function handleDeleteEmail(context) {
  const { supabase, params } = context;
  const emailId = String(params.get("eid") || "0");

  if (!supabase) {
    return {
      body: `"s", 1, "eid", "${emailId}"`,
      source: "generated:deleteemail:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:deleteemail");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:deleteemail:bad-session",
    };
  }

  try {
    const deleted = await deleteMailForRecipient(supabase, {
      mailId: Number(emailId),
      recipientPlayerId: caller.playerId,
    });

    return {
      body: `"s", 1, "eid", "${emailId}"`,
      source: deleted ? "supabase:deleteemail" : "supabase:deleteemail:not-found",
    };
  } catch (error) {
    context.logger?.error("Delete email error", {
      emailId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:deleteemail:error" };
  }
}

export async function handleSendEmail(context) {
  const { supabase, params } = context;
  const targetPublicId = Number(params.get("i") || params.get("aid") || params.get("to") || 0);
  const subject = String(params.get("s") || params.get("subject") || "");
  const bodyText = String(params.get("b") || params.get("body") || params.get("m") || "");

  if (!supabase) {
    return {
      body: wrapSuccessData(`<r s='1' id='${targetPublicId || 0}'/>`),
      source: "generated:sendemail:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:sendemail");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:sendemail:bad-session",
    };
  }

  if (!targetPublicId) {
    return {
      body: wrapSuccessData(`<r s='0' id='0'/>`),
      source: "supabase:sendemail:missing-target",
    };
  }

  const targetPlayer = await resolveTargetPlayerByPublicId(supabase, targetPublicId);
  if (!targetPlayer) {
    return {
      body: wrapSuccessData(`<r s='0' id='${targetPublicId}'/>`),
      source: "supabase:sendemail:target-not-found",
    };
  }

  try {
    await createMailRecord(supabase, {
      recipientPlayerId: targetPlayer.id,
      senderPlayerId: caller.playerId,
      folder: "inbox",
      messageType: "player",
      subject,
      body: bodyText,
      isRead: false,
    });

    // Store a sender-side copy so the existing folder model can surface sent mail.
    await createMailRecord(supabase, {
      recipientPlayerId: caller.playerId,
      senderPlayerId: targetPlayer.id,
      folder: "sent",
      messageType: "player",
      subject,
      body: bodyText,
      isRead: true,
    });

    return {
      body: wrapSuccessData(`<r s='1' id='${targetPublicId}'/>`),
      source: "supabase:sendemail",
    };
  } catch (error) {
    context.logger?.error("Send email error", {
      targetPublicId,
      playerId: caller.playerId,
      error: error?.message || String(error),
    });
    return { body: failureBody(), source: "supabase:sendemail:error" };
  }
}

export async function handleGetEmailList(context) {
  const { supabase, params } = context;

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getemaillist");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getemaillist:bad-session" };
  }

  const folder = params.get("f") || "inbox";
  const page = Number(params.get("p") || 0);
  const pageSize = 20;

  try {
    const emails = await listMailForRecipient(supabase, {
      recipientPlayerId: caller.playerId,
      folder,
      page,
      pageSize,
    });

    const emailsXml = (emails || []).map((email) => {
      const readStatus = email.is_read ? "1" : "0";
      const hasAttachment = (email.attachment_money > 0 || email.attachment_points > 0) ? "1" : "0";
      return (
        `<m i='${email.id}' si='${email.sender_player_id || 0}' ` +
        `s='${escapeXml(email.subject)}' r='${readStatus}' a='${hasAttachment}' ` +
        `d='${Math.floor(new Date(email.created_at).getTime() / 1000)}'/>`
      );
    }).join("");

    return {
      body: `"s", 1, "d", "${escapeXml(`<emails>${emailsXml}</emails>`)}", "t", ${emails?.length || 0}, "p", ${page}`,
      source: "supabase:getemaillist",
    };
  } catch (error) {
    context.logger?.error("Get email list error", { error: error.message });
    return { body: failureBody(), source: "supabase:getemaillist:error" };
  }
}

export async function handleGetBlackCardProgress(context) {
  const { supabase } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getblackcardprogress");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getblackcardprogress:bad-session",
      };
    }
  }

  return {
    body: wrapSuccessData("<x s='0'/>"),
    source: "getblackcardprogress:zero",
  };
}

export async function handleGetAvatarAge(context) {
  const tidsParam = context.params.get("tids") || "";
  const tids = tidsParam.split(",").filter(Boolean).map(Number);
  const result = tids.map((tid) => [tid, 0]);

  return {
    body: `"s", 1, "tids", [${result.map((pair) => `[${pair.join(", ")}]`).join(", ")}]`,
    source: "stub:getavatarage",
  };
}

export async function handleGetTeamAvatarAge(context) {
  const tidsParam = context.params.get("tids") || "";
  const tids = tidsParam.split(",").filter(Boolean).map(Number);
  const result = tids.map((tid) => [tid, 0]);

  return {
    body: `"s", 1, "tids", [${result.map((pair) => `[${pair.join(", ")}]`).join(", ")}]`,
    source: "stub:getteamavatarage",
  };
}

export async function handleGetLeaderboardMenu() {
  return {
    body: wrapSuccessData(buildLeaderboardMenuXml()),
    source: "generated:getleaderboardmenu",
  };
}

export async function handleGetNews() {
  return {
    body: wrapSuccessData(
      `<news><n i='1' d='4/5/2026 12:00:00 PM'><t>Welcome to Nitto Legends</t><c>We are here for fun, to test, and to race! So let's race!</c></n></news>`,
    ),
    source: "generated:getnews",
  };
}

export async function handleGetSpotlightRacers() {
  return {
    body: wrapSuccessData(
      `<spotlight><r u='Community' c='Acura Integra GS-R' et='11.234' w='50' t='Apr 5th 2026' uid='1' ad='4/5/2026' aauid='0' aa='Server Admin' at='Community Spotlight'><b>Welcome to Nitto!!</b></r></spotlight>`,
    ),
    source: "generated:getspotlightracers",
  };
}

export async function handleGetLeaderboard(context) {
  const reportType = String(context.params.get("n") || "sc").replace(/[^a-z]/gi, "") || "sc";
  const { supabase, params, logger } = context;
  const periodContext = normalizePeriodContext(params);
  const catalogCarFilterId = normalizeInteger(params.get("cid"), 0);

  if (!supabase) {
    return {
      body: wrapSuccessData(emptyLeaderboardXml(reportType)),
      source: `stub:getleaderboard:${reportType}`,
    };
  }

  const caller = await resolveCallerSession(context, "supabase:getleaderboard");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:getleaderboard:bad-session",
    };
  }

  try {
    switch (reportType) {
      case "sc": {
        const players = await listLeaderboardPlayers(supabase);
        const pointDeltasByPlayer = accumulateMetricByPlayer(
          await listTransactionsSince(supabase, periodContext.sinceIso),
          "points_change",
        );

        return {
          body: wrapSuccessData(
            buildSimpleLeaderboardXml(
              reportType,
              buildStreetCreditRows(players, periodContext.periodType, pointDeltasByPlayer),
            ),
          ),
          source: "supabase:getleaderboard:sc",
        };
      }

      case "ba": {
        const [players, cars, transactionRows] = await Promise.all([
          listLeaderboardPlayers(supabase),
          listLeaderboardCars(supabase),
          listTransactionsSince(supabase, periodContext.sinceIso),
        ]);
        const moneyDeltasByPlayer = accumulateMetricByPlayer(transactionRows, "money_change");

        return {
          body: wrapSuccessData(
            buildSimpleLeaderboardXml(
              reportType,
              buildBallerRows(players, cars, periodContext.periodType, moneyDeltasByPlayer),
            ),
          ),
          source: "supabase:getleaderboard:ba",
        };
      }

      case "ks": {
        const [players, raceHistoryRows, raceLogRows] = await Promise.all([
          listLeaderboardPlayers(supabase),
          listRaceHistorySince(supabase, periodContext.sinceIso),
          listRaceLogsSince(supabase, periodContext.sinceIso),
        ]);
        const { bracketRows, headToHeadRows } = buildKingOfTheHillRows(
          players,
          pickRaceEntries(raceHistoryRows, raceLogRows),
          periodContext.periodType,
        );

        return {
          body: wrapSuccessData(buildKingOfHillXml(bracketRows, headToHeadRows)),
          source: "supabase:getleaderboard:ks",
        };
      }

      case "fc": {
        const [players, cars, raceHistoryRows, raceLogRows] = await Promise.all([
          listLeaderboardPlayers(supabase),
          listLeaderboardCars(supabase),
          listRaceHistorySince(supabase, periodContext.sinceIso),
          listRaceLogsSince(supabase, periodContext.sinceIso),
        ]);

        return {
          body: wrapSuccessData(
            buildFastestCarsXml(
              buildFastestCarsRows(
                players,
                cars,
                pickRaceEntries(raceHistoryRows, raceLogRows),
                periodContext.periodType,
                catalogCarFilterId,
              ),
            ),
          ),
          source: "supabase:getleaderboard:fc",
        };
      }

      case "tsc":
      case "tba":
      case "ta":
      case "tmb":
      case "ttw":
      case "tft": {
        const teams = await listLeaderboardTeams(supabase);
        const teamIds = teams.map((team) => Number(team.id)).filter((teamId) => teamId > 0);
        const teamMembers = await listTeamMembersForTeams(supabase, teamIds);
        const players = await listPlayersByIds(
          supabase,
          teamMembers.map((member) => Number(member.player_id)).filter((playerId) => playerId > 0),
        );
        const playersById = new Map(players.map((player) => [Number(player.id), player]));

        if (reportType === "tsc") {
          const pointDeltasByPlayer = accumulateMetricByPlayer(
            await listTransactionsSince(supabase, periodContext.sinceIso),
            "points_change",
          );
          const teamRows = buildTeamRows(
            teams,
            teamMembers,
            playersById,
            (team) => {
              if (periodContext.periodType === "All" || !(pointDeltasByPlayer instanceof Map)) {
                return team.score;
              }

              return teamMembers
                .filter((member) => Number(member.team_id) === Number(team.id))
                .reduce((sum, member) => sum + toNumber(pointDeltasByPlayer.get(Number(member.player_id)), 0), 0);
            },
            periodContext.periodType,
            "sc",
          );

          return {
            body: wrapSuccessData(buildSimpleLeaderboardXml(reportType, teamRows)),
            source: "supabase:getleaderboard:tsc",
          };
        }

        if (reportType === "tba") {
          return {
            body: wrapSuccessData(
              buildSimpleLeaderboardXml(
                reportType,
                buildTeamRows(
                  teams,
                  teamMembers,
                  playersById,
                  (team) => team.team_fund,
                  periodContext.periodType,
                  "f",
                ),
              ),
            ),
            source: "supabase:getleaderboard:tba",
          };
        }

        if (reportType === "ta") {
          return {
            body: wrapSuccessData(
              buildSimpleLeaderboardXml(
                reportType,
                buildTeamRows(
                  teams,
                  teamMembers,
                  playersById,
                  (_team, memberCount) => memberCount,
                  periodContext.periodType,
                  "m",
                ),
              ),
            ),
            source: "supabase:getleaderboard:ta",
          };
        }

        if (reportType === "tmb") {
          return {
            body: wrapSuccessData(
              buildSimpleLeaderboardXml(
                reportType,
                buildTeamRows(
                  teams,
                  teamMembers,
                  playersById,
                  (team) => teamMembers
                    .filter((member) => Number(member.team_id) === Number(team.id))
                    .reduce((sum, member) => sum + countVisibleBadges(playersById.get(Number(member.player_id)) || null), 0),
                  periodContext.periodType,
                  "b",
                ),
              ),
            ),
            source: "supabase:getleaderboard:tmb",
          };
        }

        if (reportType === "ttw") {
          return {
            body: wrapSuccessData(
              buildSimpleLeaderboardXml(
                reportType,
                buildTeamRows(
                  teams,
                  teamMembers,
                  playersById,
                  (team) => team.wins,
                  periodContext.periodType,
                  "b",
                ),
              ),
            ),
            source: "supabase:getleaderboard:ttw",
          };
        }

        const [raceHistoryRows, raceLogRows] = await Promise.all([
          listRaceHistorySince(supabase, periodContext.sinceIso),
          listRaceLogsSince(supabase, periodContext.sinceIso),
        ]);

        return {
          body: wrapSuccessData(
            buildFastestTeamsXml(
              buildFastestTeamRows(teams, teamMembers, pickRaceEntries(raceHistoryRows, raceLogRows)),
            ),
          ),
          source: "supabase:getleaderboard:tft",
        };
      }

      default:
        return {
          body: wrapSuccessData(emptyLeaderboardXml(reportType)),
          source: `stub:getleaderboard:${reportType}`,
        };
    }
  } catch (error) {
    logger?.error("Leaderboard generation failed", {
      reportType,
      periodType: periodContext.periodType,
      catalogCarFilterId,
      error: error?.message || String(error),
    });

    return {
      body: wrapSuccessData(emptyLeaderboardXml(reportType)),
      source: `supabase:getleaderboard:${reportType}:fallback`,
    };
  }
}

export async function handleGetRacerSearch() {
  return {
    body: wrapSuccessData(`<u></u>`),
    source: "stub:racersearch",
  };
}

export async function handleGetDescription() {
  return {
    body: wrapSuccessData(`<d></d>`),
    source: "stub:getdescription",
  };
}

export async function handleGetBuddies() {
  return {
    body: wrapSuccessData(`<buddies></buddies>`),
    source: "stub:getbuddies",
  };
}

export async function handleTeamInfo(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return {
      body: wrapSuccessData(renderTeams([{ id: 0, name: "", members: [] }])),
      source: "stub:teaminfo:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:teaminfo");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teaminfo:bad-session" };
  }

  const teamIds = (params.get("tids") || params.get("tid") || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (teamIds.length === 0) {
    return {
      body: wrapSuccessData(renderTeams([{ id: 0, name: "", members: [] }])),
      source: "supabase:teaminfo:none",
    };
  }

  const [teams, members] = await Promise.all([
    listTeamsByIds(supabase, teamIds),
    listTeamMembersForTeams(supabase, teamIds),
  ]);

  if (teams.length === 0) {
    return {
      body: wrapSuccessData(renderTeams([{ id: 0, name: "", members: [] }])),
      source: "supabase:teaminfo:not-found",
    };
  }

  const players = await listPlayersByIds(
    supabase,
    members.map((member) => member.player_id),
  );
  const playersById = new Map(players.map((player) => [Number(player.id), player]));
  const membersByTeamId = new Map();

  for (const member of members) {
    const key = Number(member.team_id);
    if (!membersByTeamId.has(key)) {
      membersByTeamId.set(key, []);
    }
    membersByTeamId.get(key).push({
      ...member,
      player: playersById.get(Number(member.player_id)) || null,
    });
  }

  return {
    body: wrapSuccessData(
      renderTeams(
        teams.map((team) => ({
          ...team,
          members: membersByTeamId.get(Number(team.id)) || [],
        })),
      ),
    ),
    source: "supabase:teaminfo",
  };
}

export async function handleGetMarquee() {
  return {
    body: wrapSuccessData(getMarqueeXml()),
    source: "generated:getmarquee",
  };
}

export const SOCIAL_ACTION_HANDLERS = Object.freeze({
  gettotalnewmail: handleGetTotalNewMail,
  getemaillist: handleGetEmailList,
  getremarks: handleGetRemarks,
  getuserremarks: handleGetUserRemarks,
  addremark: handleAddRemark,
  deleteremark: handleDeleteRemark,
  getblackcardprogress: handleGetBlackCardProgress,
  teaminfo: handleTeamInfo,
  getteaminfo: handleTeamInfo,
  getleaderboardmenu: handleGetLeaderboardMenu,
  getleaderboard: handleGetLeaderboard,
  getnews: handleGetNews,
  getmarquee: handleGetMarquee,
  getspotlightracers: handleGetSpotlightRacers,
  racersearch: handleGetRacerSearch,
  getdescription: handleGetDescription,
  getavatarage: handleGetAvatarAge,
  getteamavatarage: handleGetTeamAvatarAge,
  getbuddies: handleGetBuddies,
  getbuddylist: handleGetBuddies,
  buddylist: handleGetBuddies,
});
