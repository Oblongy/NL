import { RaceManager } from "./race-manager.js";
import { buildLoginBody } from "./login-payload.js";
import { PARTS_CATALOG_XML, PARTS_CATEGORIES_BODY } from "./parts-catalog.js";
import { ALL_COLORS, PAINT_CATS_FOR_LOC, getPaintIdForColorCode } from "./paint-catalog-source.js";
import { buildWheelsTiresCatalogXml } from "./wheels-catalog.js";
import { buildStaticCarsXml, FULL_CAR_CATALOG, getCatalogCarPrice } from "./car-catalog.js";
import { randomUUID } from "node:crypto";
import {
  handleAddRemark as handleAddRemarkImpl,
  handleDeleteRemark as handleDeleteRemarkImpl,
  handleDeleteEmail as handleDeleteEmailImpl,
  handleGetEmail as handleGetEmailImpl,
  handleGetLeaderboard as handleGetLeaderboardImpl,
  handleGetLeaderboardMenu as handleGetLeaderboardMenuImpl,
  handleMarkEmailRead as handleMarkEmailReadImpl,
  handleGetNews as handleGetNewsImpl,
  handleGetUserRemarks as handleGetUserRemarksImpl,
  handleSendEmail as handleSendEmailImpl,
  handleGetSpotlightRacers as handleGetSpotlightRacersImpl,
  handleGetTotalNewMail as handleGetTotalNewMailImpl,
  handleGetRemarks as handleGetRemarksImpl,
  handleGetEmailList as handleGetEmailListImpl,
  handleGetBlackCardProgress as handleGetBlackCardProgressImpl,
} from "./game-actions/social.js";
import {
  handleGetCarPartsBin as handleGetCarPartsBinImpl,
  handleGetPartsBin as handleGetPartsBinImpl,
  handleInstallPart as handleInstallPartImpl,
} from "./game-actions/parts.js";
import {
  escapeXml,
  failureBody,
  renderOwnedGarageCar,
  renderOwnedGarageCarsWrapper,
  renderRacerCars,
  renderShowroomCarBody,
  renderTeams,
  renderTwoRacerCars,
  renderUserSummaries,
  renderUserSummary,
  wrapSuccessData,
} from "./game-xml.js";
import { buildCarRaceSpec, getRedLine } from "./engine-physics.js";
import { hashGamePassword, normalizeUsername, verifyGamePassword } from "./player-identity.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { createLoginSession, getSessionPlayerId, validateOrCreateSession } from "./session.js";
import {
  getPlayerById,
  getTeamMembershipByPlayerId,
  getPlayerByUsername,
  createPlayer,
  createStarterCar,
  createOwnedCar,
  createTeam as createTeamRecord,
  ensurePlayerHasGarageCar,
  findTeamByName,
  listCarsForPlayer,
  listPlayersForTeams as listPlayersForTeamsFromService,
  listCarsByIds,
  listPlayersByIds,
  listTeamMembersForTeams,
  listTeamsByIds,
  deleteTeam as deleteTeamRecord,
  saveCarPartsXml,
  saveCarWheelXml,
  searchPlayersByUsername,
  setPlayerTeamMembership as setPlayerTeamMembershipRecord,
  syncGameTeamMemberRow as syncGameTeamMemberRowRecord,
  updateTeamRecord as updateTeamRecordInService,
  updatePlayerRecord,
  updatePlayerDefaultCar,
  updatePlayerMoney,
  updatePlayerLocation,
  getCarById,
  deleteCar,
  clearCarTestDriveState,
} from "./user-service.js";
import { getDefaultPartsXmlForCar, getDefaultWheelFitmentForCar, getDefaultWheelXmlForCar } from "./car-defaults.js";
import { getShowroomCarSpec, hasShowroomCarSpec } from "./showroom-car-specs.js";

const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
const DEFAULT_STOCK_PARTS_XML = "";
const TEST_DRIVE_DURATION_HOURS = 72;
const DEFAULT_DYNO_PURCHASE_STATE = Object.freeze({
  boostSetting: 5,
  maxPsi: 10,
  chipSetting: 0,
  shiftLightRpm: 7200,
  redLine: 7800,
});
const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)=['"]([^'"]*)['"]/g;
const TEAM_RIVALS_ROOM_ID = 1;
const TEAM_ROLE = Object.freeze({
  LEADER: 1,
  CO_LEADER: 2,
  DEALER: 3,
  MEMBER: 4,
});
const TEAM_APP_STATUS = Object.freeze({
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
});

let partsCatalogById = null;
let wheelsTiresCatalogById = null;
const pendingTestDriveInvitationsById = new Map();
const pendingTestDriveInvitationsByPlayerId = new Map();
const activeTestDriveCarsByPlayerId = new Map();
const teamRivalsChallengesById = new Map();

function parsePartXmlAttributes(rawEntry) {
  const attrs = {};
  let match;
  while ((match = PART_XML_ATTR_REGEX.exec(rawEntry)) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_XML_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

function getPartsCatalogById() {
  if (partsCatalogById) {
    return partsCatalogById;
  }

  partsCatalogById = new Map();
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(PARTS_CATALOG_XML)) !== null) {
    const attrs = parsePartXmlAttributes(match[0]);
    const id = Number(attrs.i || 0);
    if (id > 0) {
      partsCatalogById.set(id, attrs);
    }
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return partsCatalogById;
}

function getWheelsTiresCatalogById() {
  if (wheelsTiresCatalogById) {
    return wheelsTiresCatalogById;
  }

  wheelsTiresCatalogById = new Map();
  const xml = buildWheelsTiresCatalogXml();
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(xml)) !== null) {
    const attrs = parsePartXmlAttributes(match[0]);
    const id = Number(attrs.i || 0);
    if (id > 0) {
      wheelsTiresCatalogById.set(id, attrs);
    }
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return wheelsTiresCatalogById;
}

function createInstalledPartId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
}

function upsertInstalledPartXml(partsXml, slotId, partXml, slotAttr = "pi") {
  const source = String(partsXml || "");
  const escapedSlotId = String(slotId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<p[^>]*\\b(?:${slotAttr}|ci)='${escapedSlotId}'[^>]*/>`, "g");
  const cleaned = source.replace(pattern, "");
  return `${cleaned}${partXml}`;
}

function buildInstalledCatalogPartXml(catalogPart, installId, overrides = {}) {
  const attrs = {
    ai: installId,
    i: overrides.i ?? catalogPart.i ?? "",
    pi: overrides.pi ?? catalogPart.pi ?? "",
    t: overrides.t ?? catalogPart.t ?? "",
    n: overrides.n ?? catalogPart.n ?? "",
    p: overrides.p ?? catalogPart.p ?? "0",
    pp: overrides.pp ?? catalogPart.pp ?? "0",
    g: overrides.g ?? catalogPart.g ?? "",
    di: overrides.di ?? catalogPart.di ?? "",
    pdi: overrides.pdi ?? catalogPart.pdi ?? catalogPart.di ?? "",
    b: overrides.b ?? catalogPart.b ?? "",
    bn: overrides.bn ?? catalogPart.bn ?? "",
    mn: overrides.mn ?? catalogPart.mn ?? "",
    l: overrides.l ?? catalogPart.l ?? "100",
    in: overrides.in ?? "1",
    mo: overrides.mo ?? catalogPart.mo ?? "0",
    hp: overrides.hp ?? catalogPart.hp ?? "0",
    tq: overrides.tq ?? catalogPart.tq ?? "0",
    wt: overrides.wt ?? catalogPart.wt ?? "0",
    cc: overrides.cc ?? catalogPart.cc ?? "",
    ps: overrides.ps ?? catalogPart.ps ?? "",
  };

  const orderedKeys = ["ai", "i", "pi", "t", "n", "p", "pp", "g", "di", "pdi", "b", "bn", "mn", "l", "in", "mo", "hp", "tq", "wt", "cc", "ps"];
  const serialized = orderedKeys
    .filter((key) => attrs[key] !== "" && attrs[key] !== undefined)
    .map((key) => `${key}='${escapeXml(String(attrs[key]))}'`)
    .join(" ");
  return `<p ${serialized}/>`;
}

function parseShowroomPurchaseCatalogCarId(params) {
  return Number(
    params.get("acid")
      || params.get("ci")
      || params.get("cid")
      || params.get("carid")
      || params.get("catalogid")
      || params.get("i")
      || params.get("id")
      || 0,
  );
}

function parseShowroomPurchasePrice(params) {
  return Number(
    params.get("pr")
      || params.get("price")
      || params.get("cp")
      || params.get("p")
      || 0,
  );
}

async function resolveInternalPlayerIdByPublicId(supabase, publicId) {
  const numericId = Number(publicId || 0);
  if (!supabase || !numericId) {
    return 0;
  }

  const directPlayer = await getPlayerById(supabase, numericId);
  return Number(directPlayer?.id || 0);
}

async function resolveCallerSession(context, sourceLabel) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const sessionKey = params.get("sk") || "";
  const requestedPublicId = Number(params.get("aid") || 0);
  if (!sessionKey) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:missing-session` };
  }

  let playerId = await getSessionPlayerId({ supabase, sessionKey });
  if (!playerId && requestedPublicId) {
    playerId = await resolveInternalPlayerIdByPublicId(supabase, requestedPublicId);
  }

  if (!playerId) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:missing-player` };
  }

  const sessionOkay = await validateOrCreateSession({ supabase, playerId, sessionKey });
  if (!sessionOkay) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:bad-session` };
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:no-player` };
  }

  return {
    ok: true,
    player,
    playerId,
    publicId: getPublicIdForPlayer(player),
    sessionKey,
  };
}

async function resolveTargetPlayerByPublicId(supabase, publicId) {
  const playerId = await resolveInternalPlayerIdByPublicId(supabase, publicId);
  if (!playerId) {
    return null;
  }
  return getPlayerById(supabase, playerId);
}

function normalizeLocationId(rawLocationId) {
  const locationId = Number(rawLocationId || 100);
  return [100, 200, 300, 400, 500].includes(locationId) ? locationId : 100;
}

async function resolvePaintCatalogLocationId(context, sourceLabel) {
  const { supabase, params } = context;
  if (!supabase) {
    return {
      ok: true,
      locationId: normalizeLocationId(params.get("lid") || params.get("l") || params.get("loc")),
    };
  }

  const caller = await resolveCallerSession(context, sourceLabel);
  if (!caller?.ok) {
    return {
      ok: false,
      body: caller?.body || failureBody(),
      source: caller?.source || `${sourceLabel}:bad-session`,
    };
  }

  return {
    ok: true,
    locationId: normalizeLocationId(
      params.get("lid") || params.get("l") || params.get("loc") || caller.player?.location_id,
    ),
  };
}

async function handleGetPaintCategories(context) {
  const resolved = await resolvePaintCatalogLocationId(context, "supabase:getpaintcats");
  if (!resolved?.ok) {
    return resolved;
  }

  return {
    body: wrapSuccessData(`<n id='getpaintcats'><s>${PAINT_CATS_FOR_LOC(resolved.locationId)}</s></n>`),
    source: `generated:getpaintcats:location=${resolved.locationId}`,
  };
}

async function handleGetPaints(context) {
  const resolved = await resolvePaintCatalogLocationId(context, "supabase:getpaints");
  if (!resolved?.ok) {
    return resolved;
  }

  return {
    body: wrapSuccessData(
      `<n id='getpaints'><s>${ALL_COLORS.replace(/LOC/g, String(resolved.locationId))}</s></n>`,
    ),
    source: `generated:getpaints:location=${resolved.locationId}`,
  };
}

async function attachOwnerPublicIds(supabase, cars) {
  const playerIds = [...new Set(cars.map((car) => Number(car.player_id)).filter((value) => value > 0))];
  const players = await listPlayersByIds(supabase, playerIds);
  const publicIdsByPlayerId = new Map(
    players.map((player) => [Number(player.id), getPublicIdForPlayer(player)]),
  );

  return cars.map((car) => ({
    ...car,
    owner_public_id: publicIdsByPlayerId.get(Number(car.player_id)) || Number(car.player_id) || 0,
  }));
}

function parseCsvIntegerList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => Number(String(entry).trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

function escapeTcpXml(xml) {
  return String(xml || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function getActionValueCandidates(params) {
  return [...params.entries()]
    .filter(([key]) => !["action", "aid", "sk"].includes(String(key || "").toLowerCase()))
    .map(([, value]) => value);
}

async function getPlayerTeamMembership(supabase, playerId) {
  const membership = await getTeamMembershipByPlayerId(supabase, playerId);
  if (membership?.team_id) {
    return membership;
  }

  const player = await getPlayerById(supabase, playerId);
  return player?.team_id ? { team_id: player.team_id, role: null } : null;
}

function getDefaultTeamMeta() {
  return {
    leaderComments: "",
    rolesByPlayerId: {},
    dealerMaxBetByPlayerId: {},
    contributionByPlayerId: {},
    applications: [],
  };
}

function sanitizeTeamMeta(teamMeta) {
  const merged = { ...getDefaultTeamMeta(), ...(teamMeta || {}) };
  return {
    ...merged,
    rolesByPlayerId: { ...(merged.rolesByPlayerId || {}) },
    dealerMaxBetByPlayerId: { ...(merged.dealerMaxBetByPlayerId || {}) },
    contributionByPlayerId: { ...(merged.contributionByPlayerId || {}) },
    applications: [...(merged.applications || [])],
  };
}

function getTeamMeta(services, teamId) {
  if (!teamId) {
    return getDefaultTeamMeta();
  }

  const teamState = services?.teamState;
  const existing = sanitizeTeamMeta(teamState?.get(teamId));
  if (teamState) {
    teamState.set(teamId, existing);
  }
  return existing;
}

function saveTeamMeta(services, teamId, teamMeta) {
  if (!teamId) {
    return sanitizeTeamMeta(teamMeta);
  }

  const normalized = sanitizeTeamMeta(teamMeta);
  if (services?.teamState) {
    services.teamState.set(teamId, normalized);
  }
  return normalized;
}

function updateTeamMeta(services, teamId, updater) {
  const current = getTeamMeta(services, teamId);
  const next = typeof updater === "function" ? updater(current) : current;
  return saveTeamMeta(services, teamId, next);
}

function normalizeTeamRole(value) {
  const numericValue = Number(value || 0);
  return Object.values(TEAM_ROLE).includes(numericValue) ? numericValue : TEAM_ROLE.MEMBER;
}

function isTeamLeader(roleCode) {
  return Number(roleCode) === TEAM_ROLE.LEADER;
}

function isTeamManager(roleCode) {
  const numericRole = Number(roleCode || 0);
  return numericRole === TEAM_ROLE.LEADER || numericRole === TEAM_ROLE.CO_LEADER;
}

function getTeamRoleWeight(roleCode) {
  switch (Number(roleCode || 0)) {
    case TEAM_ROLE.LEADER:
      return 0;
    case TEAM_ROLE.CO_LEADER:
      return 1;
    case TEAM_ROLE.DEALER:
      return 2;
    default:
      return 3;
  }
}

function sortTeamPlayers(players, teamMeta) {
  return [...players].sort((left, right) => {
    const leftRole = normalizeTeamRole(teamMeta.rolesByPlayerId?.[Number(left.id)]);
    const rightRole = normalizeTeamRole(teamMeta.rolesByPlayerId?.[Number(right.id)]);
    const roleDelta = getTeamRoleWeight(leftRole) - getTeamRoleWeight(rightRole);
    if (roleDelta !== 0) {
      return roleDelta;
    }

    const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    return String(left.username || "").localeCompare(String(right.username || ""), undefined, {
      sensitivity: "base",
    });
  });
}

async function listPlayersForTeams(supabase, teamIds = []) {
  return listPlayersForTeamsFromService(supabase, teamIds);
}

function groupPlayersByTeamId(players) {
  const playersByTeamId = new Map();
  for (const player of players) {
    const teamId = Number(player.team_id || 0);
    if (teamId <= 0) {
      continue;
    }
    if (!playersByTeamId.has(teamId)) {
      playersByTeamId.set(teamId, []);
    }
    playersByTeamId.get(teamId).push(player);
  }
  return playersByTeamId;
}

function ensureTeamMetadata(services, team, players) {
  const playerIds = new Set(players.map((player) => Number(player.id)));
  const teamMeta = sanitizeTeamMeta(getTeamMeta(services, team.id));
  let changed = false;

  for (const key of Object.keys(teamMeta.rolesByPlayerId)) {
    if (!playerIds.has(Number(key))) {
      delete teamMeta.rolesByPlayerId[key];
      changed = true;
    }
  }

  for (const key of Object.keys(teamMeta.dealerMaxBetByPlayerId)) {
    if (!playerIds.has(Number(key))) {
      delete teamMeta.dealerMaxBetByPlayerId[key];
      changed = true;
    }
  }

  for (const key of Object.keys(teamMeta.contributionByPlayerId)) {
    if (!playerIds.has(Number(key))) {
      delete teamMeta.contributionByPlayerId[key];
      changed = true;
    }
  }

  let leaderId = players.find((player) =>
    normalizeTeamRole(teamMeta.rolesByPlayerId?.[Number(player.id)]) === TEAM_ROLE.LEADER,
  )?.id;

  if (!leaderId && players.length > 0) {
    const fallbackLeader = [...players].sort((left, right) =>
      String(left.username || "").localeCompare(String(right.username || ""), undefined, {
        sensitivity: "base",
      }),
    )[0];
    leaderId = Number(fallbackLeader.id);
    teamMeta.rolesByPlayerId[String(leaderId)] = TEAM_ROLE.LEADER;
    changed = true;
  }

  for (const player of players) {
    const key = String(Number(player.id));
    if (!teamMeta.rolesByPlayerId[key]) {
      teamMeta.rolesByPlayerId[key] = Number(player.id) === Number(leaderId)
        ? TEAM_ROLE.LEADER
        : TEAM_ROLE.MEMBER;
      changed = true;
    }
    if (teamMeta.contributionByPlayerId[key] === undefined) {
      teamMeta.contributionByPlayerId[key] = 0;
      changed = true;
    }
  }

  const sortedPlayers = sortTeamPlayers(players, teamMeta);
  const totalContribution = sortedPlayers.reduce(
    (sum, player) => sum + Number(teamMeta.contributionByPlayerId?.[String(player.id)] || 0),
    0,
  );

  return {
    teamMeta: changed ? saveTeamMeta(services, team.id, teamMeta) : teamMeta,
    sortedPlayers,
    totalContribution,
  };
}

function renderTeamDetailXml(team, players, teamMeta, totalContribution = 0) {
  const membersXml = players.map((player) => {
    const playerId = Number(player.id || 0);
    const publicId = getPublicIdForPlayer(player);
    const roleCode = normalizeTeamRole(teamMeta.rolesByPlayerId?.[String(playerId)]);
    const contribution = Number(teamMeta.contributionByPlayerId?.[String(playerId)] || 0);
    const ownerPct = totalContribution > 0
      ? Math.round((contribution / totalContribution) * 10000) / 100
      : 0;
    const maxBetPct = roleCode === TEAM_ROLE.DEALER
      ? Number(teamMeta.dealerMaxBetByPlayerId?.[String(playerId)] ?? 0)
      : -1;

    return (
      `<tm i='${publicId}' un='${escapeXml(player.username || "")}' sc='${Number(player.score || 0)}' ` +
      `et='0' tr='${roleCode}' po='${ownerPct}' fu='${contribution}' mbp='${maxBetPct}'/>`
    );
  }).join("");

  return (
    `<t i='${Number(team.id || 0)}' n='${escapeXml(team.name || "")}' sc='${Number(team.score || 0)}' ` +
    `bg='${escapeXml(team.background_color || "7D7D7D")}' de='${escapeXml(String(team.created_at || ""))}' ` +
    `tf='${Number(team.team_fund || 0)}' lc='${escapeXml(teamMeta.leaderComments || "")}' ` +
    `tw='${Number(team.wins || 0)}' tl='${Number(team.losses || 0)}' ` +
    `rt='${escapeXml(team.recruitment_type || "open")}' v='${Number(team.vip || 0)}'>${membersXml}</t>`
  );
}

function renderTeamsWithMetadata(teams, playersByTeamId, services) {
  const body = teams.map((team) => {
    const players = playersByTeamId.get(Number(team.id)) || [];
    const { teamMeta, sortedPlayers, totalContribution } = ensureTeamMetadata(services, team, players);
    return renderTeamDetailXml(team, sortedPlayers, teamMeta, totalContribution);
  }).join("");

  return `<teams>${body}</teams>`;
}

async function getTeamById(supabase, teamId) {
  const teams = await listTeamsByIds(supabase, [teamId]);
  return teams[0] || null;
}

async function loadTeamContextById({ supabase, services, teamId }) {
  const team = await getTeamById(supabase, teamId);
  if (!team) {
    return null;
  }

  const players = await listPlayersForTeams(supabase, [teamId]);
  const { teamMeta, sortedPlayers, totalContribution } = ensureTeamMetadata(services, team, players);
  const playersByPublicId = new Map(sortedPlayers.map((player) => [Number(getPublicIdForPlayer(player)), player]));

  return {
    team,
    players: sortedPlayers,
    playersByPublicId,
    teamMeta,
    totalContribution,
  };
}

async function loadCallerTeamContext(context, sourceLabel, options = {}) {
  const caller = await resolveCallerSession(context, sourceLabel);
  if (!caller?.ok) {
    return { caller };
  }

  const callerTeamId = Number(caller.player?.team_id || 0);
  if (!callerTeamId) {
    return { caller, teamId: 0, teamContext: null, callerRole: 0 };
  }

  const teamContext = await loadTeamContextById({
    supabase: context.supabase,
    services: context.services,
    teamId: callerTeamId,
  });

  if (!teamContext) {
    if (options.requireMembership) {
      return { caller, teamId: 0, teamContext: null, callerRole: 0 };
    }
    return { caller, teamId: callerTeamId, teamContext: null, callerRole: 0 };
  }

  const callerRole = normalizeTeamRole(teamContext.teamMeta.rolesByPlayerId?.[String(caller.playerId)]);
  return {
    caller,
    teamId: callerTeamId,
    teamContext,
    callerRole,
  };
}

function cleanTeamName(value) {
  return String(value || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .replace(/\s+/g, " ");
}

function isValidTeamName(value) {
  if (!value || value.length < 2 || value.length > 32) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9 '&.-]*$/.test(value);
}

function parseActionNumber(params, ...keys) {
  for (const key of keys) {
    const value = params.get(key);
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue !== 0) {
      return numericValue;
    }
  }

  for (const candidate of getActionValueCandidates(params)) {
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue !== 0) {
      return numericValue;
    }
  }

  return 0;
}

function parseActionNumbers(params) {
  return getActionValueCandidates(params)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function parseActionString(params, ...keys) {
  for (const key of keys) {
    const value = params.get(key);
    if (value != null && String(value).length > 0) {
      return String(value);
    }
  }

  const candidate = getActionValueCandidates(params).find((value) => String(value).length > 0);
  return candidate != null ? String(candidate) : "";
}

/**
 * Keeps `game_team_members` aligned with `game_players.team_id`.
 * Team Rivals and `member_count` triggers depend on this table; updating only `game_players` breaks those paths.
 */
async function syncGameTeamMemberRow(supabase, playerId, teamId, options = {}) {
  await syncGameTeamMemberRowRecord(supabase, playerId, teamId, options);
}

async function updatePlayerTeamMembership(supabase, playerId, team, membershipOptions = {}) {
  return setPlayerTeamMembershipRecord(supabase, playerId, team, membershipOptions);
}

function refreshTcpTeamMembership(services, { playerId, teamId = 0, teamRole = "" } = {}) {
  const tcpServer = services?.tcpServer;
  const numericPlayerId = Number(playerId || 0);
  if (!tcpServer || !numericPlayerId) {
    return;
  }

  for (const conn of tcpServer.connections.values()) {
    if (Number(conn.playerId || 0) === numericPlayerId) {
      conn.teamId = Number(teamId || 0);
      conn.teamRole = String(teamRole || "");
    }
  }

  const affectedRoomIds = new Set();
  for (const [roomId, roomPlayers] of tcpServer.rooms.entries()) {
    let touched = false;
    for (const roomPlayer of roomPlayers) {
      if (Number(roomPlayer.playerId || 0) === numericPlayerId) {
        roomPlayer.teamId = Number(teamId || 0);
        roomPlayer.teamRole = String(teamRole || "");
        touched = true;
      }
    }
    if (touched) {
      affectedRoomIds.add(roomId);
    }
  }

  for (const roomId of affectedRoomIds) {
    const roomPlayers = tcpServer.rooms.get(roomId) || [];
    for (const roomPlayer of roomPlayers) {
      const conn = tcpServer.connections.get(roomPlayer.connId);
      if (conn) {
        tcpServer.sendRoomUsers(conn, roomPlayers);
      }
    }
  }
}

async function updateTeamRecord(supabase, teamId, patch) {
  return updateTeamRecordInService(supabase, teamId, patch);
}

function buildTeamApplicationsXml(applications = []) {
  const body = applications.map((application) => (
    `<a i='${Number(application.applicantPublicId || 0)}' u='${escapeXml(application.applicantName || "")}' ` +
    `sc='${Number(application.applicantScore || 0)}' et='0' s='${escapeXml(application.status || TEAM_APP_STATUS.PENDING)}' ` +
    `n='${escapeXml(application.comment || "")}'/>`
  )).join("");

  return `<apps>${body}</apps>`;
}

function buildMyApplicationsXml(applications = []) {
  const body = applications.map((application) => (
    `<a ti='${Number(application.teamId || 0)}' tn='${escapeXml(application.teamName || "")}' ` +
    `sc='${Number(application.teamScore || 0)}' s='${escapeXml(application.status || TEAM_APP_STATUS.PENDING)}' ` +
    `n='${escapeXml(application.comment || "")}'/>`
  )).join("");

  return `<apps>${body}</apps>`;
}

function removeApplicationsForPlayer(teamMeta, playerId) {
  return {
    ...teamMeta,
    applications: (teamMeta.applications || []).filter(
      (application) => Number(application.applicantPlayerId || 0) !== Number(playerId || 0),
    ),
  };
}

async function handleTeamCreate(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:teamcreate");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamcreate:bad-session" };
  }

  if (Number(caller.player?.team_id || 0) > 0) {
    return { body: `"s", -1`, source: "supabase:teamcreate:already-on-team" };
  }

  const teamName = cleanTeamName(parseActionString(params, "n", "name", "tn"));
  if (!isValidTeamName(teamName)) {
    return { body: `"s", 0`, source: "supabase:teamcreate:invalid-name" };
  }

  const existingTeam = await findTeamByName(supabase, teamName);
  if (existingTeam?.id) {
    return { body: `"s", -2`, source: "supabase:teamcreate:name-taken" };
  }

  const createdTeam = await createTeamRecord(supabase, {
    name: teamName,
    score: 0,
    teamFund: 0,
    ownerPlayerId: caller.playerId,
  });

  await updatePlayerTeamMembership(supabase, caller.playerId, createdTeam, {
    dbMemberRole: "owner",
  });
  saveTeamMeta(services, createdTeam.id, {
    leaderComments: "",
    rolesByPlayerId: { [String(caller.playerId)]: TEAM_ROLE.LEADER },
    dealerMaxBetByPlayerId: {},
    contributionByPlayerId: { [String(caller.playerId)]: 0 },
    applications: [],
  });
  refreshTcpTeamMembership(services, {
    playerId: caller.playerId,
    teamId: createdTeam.id,
    teamRole: TEAM_ROLE.LEADER,
  });

  return {
    body: `"s", 1, "tid", ${Number(createdTeam.id)}`,
    source: "supabase:teamcreate",
  };
}

async function handleTeamKick(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamkick", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamkick:bad-session" };
  }
  if (!teamContext) {
    return { body: `"s", -2`, source: "supabase:teamkick:no-team" };
  }

  const targetPublicId = parseActionNumber(params, "aidtk", "aid", "uid", "id");
  if (!targetPublicId) {
    return { body: `"s", -2`, source: "supabase:teamkick:no-target" };
  }
  if (Number(targetPublicId) === Number(caller.publicId)) {
    return { body: `"s", 0`, source: "supabase:teamkick:self" };
  }
  if (!isTeamManager(callerRole)) {
    return { body: `"s", -3`, source: "supabase:teamkick:not-manager" };
  }

  const targetPlayer = teamContext.playersByPublicId.get(Number(targetPublicId));
  if (!targetPlayer) {
    return { body: `"s", -2`, source: "supabase:teamkick:missing-member" };
  }

  const targetRole = normalizeTeamRole(teamContext.teamMeta.rolesByPlayerId?.[String(targetPlayer.id)]);
  if (targetRole === TEAM_ROLE.LEADER || (callerRole === TEAM_ROLE.CO_LEADER && targetRole === TEAM_ROLE.CO_LEADER)) {
    return { body: `"s", ${callerRole === TEAM_ROLE.LEADER ? -1 : -3}`, source: "supabase:teamkick:denied" };
  }

  await updatePlayerTeamMembership(supabase, targetPlayer.id, null);
  saveTeamMeta(services, teamContext.team.id, removeApplicationsForPlayer({
    ...teamContext.teamMeta,
    rolesByPlayerId: Object.fromEntries(
      Object.entries(teamContext.teamMeta.rolesByPlayerId || {}).filter(([key]) => Number(key) !== Number(targetPlayer.id)),
    ),
    dealerMaxBetByPlayerId: Object.fromEntries(
      Object.entries(teamContext.teamMeta.dealerMaxBetByPlayerId || {}).filter(([key]) => Number(key) !== Number(targetPlayer.id)),
    ),
    contributionByPlayerId: Object.fromEntries(
      Object.entries(teamContext.teamMeta.contributionByPlayerId || {}).filter(([key]) => Number(key) !== Number(targetPlayer.id)),
    ),
  }, targetPlayer.id));

  return { body: `"s", 1`, source: "supabase:teamkick" };
}

async function handleTeamChangeRole(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamchangerole", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamchangerole:bad-session" };
  }
  if (!teamContext) {
    return { body: `"s", -1`, source: "supabase:teamchangerole:no-team" };
  }
  if (!isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:teamchangerole:not-manager" };
  }

  const values = parseActionNumbers(params);
  const targetPublicId = Number(params.get("aidta") || params.get("aid") || values[0] || 0);
  const desiredRole = normalizeTeamRole(Number(params.get("roleid") || params.get("role") || values[1] || 0));
  const maxBetPct = Number(params.get("maxbet") || params.get("mbp") || values[2] || 0);

  const targetPlayer = teamContext.playersByPublicId.get(targetPublicId);
  if (!targetPlayer) {
    return { body: `"s", -1`, source: "supabase:teamchangerole:missing-member" };
  }

  const targetCurrentRole = normalizeTeamRole(teamContext.teamMeta.rolesByPlayerId?.[String(targetPlayer.id)]);
  if (targetCurrentRole === TEAM_ROLE.LEADER || desiredRole === TEAM_ROLE.LEADER) {
    return { body: `"s", -2`, source: "supabase:teamchangerole:leader-denied" };
  }
  if (desiredRole === TEAM_ROLE.CO_LEADER && callerRole !== TEAM_ROLE.LEADER) {
    return { body: `"s", -3`, source: "supabase:teamchangerole:coleader-denied" };
  }
  if (desiredRole === TEAM_ROLE.DEALER && (!Number.isFinite(maxBetPct) || maxBetPct < 0 || maxBetPct > 100)) {
    return { body: `"s", -4`, source: "supabase:teamchangerole:bad-max-bet" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    rolesByPlayerId: {
      ...teamContext.teamMeta.rolesByPlayerId,
      [String(targetPlayer.id)]: desiredRole,
    },
    dealerMaxBetByPlayerId: {
      ...teamContext.teamMeta.dealerMaxBetByPlayerId,
      [String(targetPlayer.id)]: desiredRole === TEAM_ROLE.DEALER ? Number(maxBetPct || 0) : -1,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamchangerole" };
}

async function handleTeamUpdateMaxBet(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamupdatemaxbet", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamupdatemaxbet:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:teamupdatemaxbet:not-manager" };
  }

  const values = parseActionNumbers(params);
  const targetPublicId = Number(params.get("aidta") || params.get("aid") || values[0] || 0);
  const maxBetPct = Number(params.get("maxbet") || params.get("mbp") || values[1] || 0);
  const targetPlayer = teamContext.playersByPublicId.get(targetPublicId);
  if (!targetPlayer) {
    return { body: `"s", -1`, source: "supabase:teamupdatemaxbet:missing-member" };
  }
  if (!Number.isFinite(maxBetPct) || maxBetPct < 0 || maxBetPct > 100) {
    return { body: `"s", -4`, source: "supabase:teamupdatemaxbet:bad-max-bet" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    dealerMaxBetByPlayerId: {
      ...teamContext.teamMeta.dealerMaxBetByPlayerId,
      [String(targetPlayer.id)]: Number(maxBetPct),
    },
  });

  return { body: `"s", 1`, source: "supabase:teamupdatemaxbet" };
}

async function handleTeamNewLeader(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamnewleader", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamnewleader:bad-session" };
  }
  if (!teamContext || callerRole !== TEAM_ROLE.LEADER) {
    return { body: `"s", 0`, source: "supabase:teamnewleader:not-leader" };
  }

  const targetPublicId = parseActionNumber(params, "aid", "uid", "id");
  const targetPlayer = teamContext.playersByPublicId.get(targetPublicId);
  if (!targetPlayer || Number(targetPlayer.id) === Number(caller.playerId)) {
    return { body: `"s", 0`, source: "supabase:teamnewleader:bad-target" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    rolesByPlayerId: {
      ...teamContext.teamMeta.rolesByPlayerId,
      [String(caller.playerId)]: TEAM_ROLE.CO_LEADER,
      [String(targetPlayer.id)]: TEAM_ROLE.LEADER,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamnewleader" };
}

async function handleTeamStepDown(context) {
  const { supabase, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamstepdown", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamstepdown:bad-session" };
  }
  if (!teamContext || callerRole !== TEAM_ROLE.LEADER) {
    return { body: `"s", 0`, source: "supabase:teamstepdown:not-leader" };
  }

  const replacement = teamContext.players.find((player) => Number(player.id) !== Number(caller.playerId));
  if (!replacement) {
    return { body: `"s", -1`, source: "supabase:teamstepdown:no-replacement" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    rolesByPlayerId: {
      ...teamContext.teamMeta.rolesByPlayerId,
      [String(caller.playerId)]: TEAM_ROLE.CO_LEADER,
      [String(replacement.id)]: TEAM_ROLE.LEADER,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamstepdown" };
}

async function handleTeamQuit(context) {
  const { supabase, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamquit", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamquit:bad-session" };
  }
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:teamquit:no-team" };
  }
  if (callerRole === TEAM_ROLE.LEADER && teamContext.players.length > 1) {
    return { body: `"s", 0`, source: "supabase:teamquit:leader-must-step-down" };
  }

  await updatePlayerTeamMembership(supabase, caller.playerId, null);
  const remainingPlayers = teamContext.players.filter((player) => Number(player.id) !== Number(caller.playerId));

  if (remainingPlayers.length === 0) {
    await deleteTeamRecord(supabase, teamContext.team.id);
    if (services?.teamState) {
      services.teamState.teams.delete(String(teamContext.team.id));
    }
  } else {
    saveTeamMeta(services, teamContext.team.id, removeApplicationsForPlayer({
      ...teamContext.teamMeta,
      rolesByPlayerId: Object.fromEntries(
        Object.entries(teamContext.teamMeta.rolesByPlayerId || {}).filter(([key]) => Number(key) !== Number(caller.playerId)),
      ),
      dealerMaxBetByPlayerId: Object.fromEntries(
        Object.entries(teamContext.teamMeta.dealerMaxBetByPlayerId || {}).filter(([key]) => Number(key) !== Number(caller.playerId)),
      ),
      contributionByPlayerId: Object.fromEntries(
        Object.entries(teamContext.teamMeta.contributionByPlayerId || {}).filter(([key]) => Number(key) !== Number(caller.playerId)),
      ),
    }, caller.playerId));
  }

  return { body: `"s", 1`, source: "supabase:teamquit" };
}

async function handleTeamDeposit(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext } = await loadCallerTeamContext(context, "supabase:teamdeposit", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamdeposit:bad-session" };
  }
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:teamdeposit:no-team" };
  }

  const amount = Math.floor(Number(params.get("amount") || parseActionNumbers(params)[0] || 0));
  if (amount <= 0 || amount > 100000000) {
    return { body: `"s", -2`, source: "supabase:teamdeposit:bad-amount" };
  }
  if (Number(caller.player.money || 0) < amount) {
    return { body: `"s", -1`, source: "supabase:teamdeposit:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, Number(caller.player.money || 0) - amount);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: Number(teamContext.team.team_fund || 0) + amount,
  });
  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(caller.playerId)]: Number(teamContext.teamMeta.contributionByPlayerId?.[String(caller.playerId)] || 0) + amount,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamdeposit" };
}

async function handleTeamWithdraw(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext } = await loadCallerTeamContext(context, "supabase:teamwithdraw", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamwithdraw:bad-session" };
  }
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:teamwithdraw:no-team" };
  }

  const amount = Math.floor(Number(params.get("amount") || parseActionNumbers(params)[0] || 0));
  if (amount <= 0 || amount > 100000000) {
    return { body: `"s", -2`, source: "supabase:teamwithdraw:bad-amount" };
  }

  const contribution = Number(teamContext.teamMeta.contributionByPlayerId?.[String(caller.playerId)] || 0);
  const teamFunds = Number(teamContext.team.team_fund || 0);
  if (amount > contribution || amount > teamFunds) {
    return { body: `"s", -1`, source: "supabase:teamwithdraw:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, Number(caller.player.money || 0) + amount);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: teamFunds - amount,
  });
  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(caller.playerId)]: contribution - amount,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamwithdraw" };
}

async function handleTeamDisperse(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:teamdisperse", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamdisperse:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:teamdisperse:not-manager" };
  }

  const values = parseActionNumbers(params);
  const amount = Math.floor(Number(params.get("amount") || values[0] || 0));
  const targetPublicId = Number(params.get("aidto") || params.get("aid") || values[1] || 0);
  const targetPlayer = teamContext.playersByPublicId.get(targetPublicId);
  if (!targetPlayer) {
    return { body: `"s", -1`, source: "supabase:teamdisperse:missing-member" };
  }
  if (amount <= 0 || amount > 100000000) {
    return { body: `"s", -2`, source: "supabase:teamdisperse:bad-amount" };
  }

  const contribution = Number(teamContext.teamMeta.contributionByPlayerId?.[String(targetPlayer.id)] || 0);
  const teamFunds = Number(teamContext.team.team_fund || 0);
  if (amount > contribution || amount > teamFunds) {
    return { body: `"s", -2`, source: "supabase:teamdisperse:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, targetPlayer.id, Number(targetPlayer.money || 0) + amount);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: teamFunds - amount,
  });
  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(targetPlayer.id)]: contribution - amount,
    },
  });

  return { body: `"s", 1`, source: "supabase:teamdisperse" };
}

async function handleTeamAccept(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:teamaccept");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamaccept:bad-session" };
  }

  if (Number(caller.player?.team_id || 0) > 0) {
    return { body: `"s", -1`, source: "supabase:teamaccept:already-on-team" };
  }

  const teamId = Number(params.get("tid") || parseActionNumbers(params)[0] || 0);
  if (!teamId) {
    return { body: `"s", 0`, source: "supabase:teamaccept:no-team" };
  }

  const teamContext = await loadTeamContextById({ supabase, services, teamId });
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:teamaccept:unknown-team" };
  }

  const application = (teamContext.teamMeta.applications || []).find((entry) =>
    Number(entry.applicantPlayerId || 0) === Number(caller.playerId)
    && String(entry.status || TEAM_APP_STATUS.PENDING) === TEAM_APP_STATUS.ACCEPTED,
  );

  if (!application) {
    return { body: `"s", -1`, source: "supabase:teamaccept:not-accepted" };
  }

  await updatePlayerTeamMembership(supabase, caller.playerId, teamContext.team, {
    dbMemberRole: "member",
  });
  saveTeamMeta(services, teamContext.team.id, removeApplicationsForPlayer({
    ...teamContext.teamMeta,
    rolesByPlayerId: {
      ...teamContext.teamMeta.rolesByPlayerId,
      [String(caller.playerId)]: TEAM_ROLE.MEMBER,
    },
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(caller.playerId)]: 0,
    },
  }, caller.playerId));
  refreshTcpTeamMembership(services, {
    playerId: caller.playerId,
    teamId: teamContext.team.id,
    teamRole: TEAM_ROLE.MEMBER,
  });

  return { body: `"s", 1`, source: "supabase:teamaccept" };
}

async function handleTeamGetAllApps(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getallteamapps");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getallteamapps:bad-session" };
  }

  const teamId = Number(params.get("tid") || 0);
  if (!teamId) {
    return { body: wrapSuccessData("<apps></apps>"), source: "supabase:getallteamapps:none" };
  }

  const teamContext = await loadTeamContextById({ supabase, services, teamId });
  const applications = teamContext?.teamMeta?.applications || [];
  return {
    body: wrapSuccessData(buildTeamApplicationsXml(applications)),
    source: "supabase:getallteamapps",
  };
}

async function handleTeamGetMyApps(context) {
  const { supabase, services } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getallmyapps");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getallmyapps:bad-session" };
  }

  const applications = [];
  for (const teamMetaEntry of services?.teamState?.list?.() || []) {
    for (const application of teamMetaEntry.applications || []) {
      if (Number(application.applicantPlayerId || 0) === Number(caller.playerId)) {
        applications.push(application);
      }
    }
  }

  return {
    body: wrapSuccessData(buildMyApplicationsXml(applications)),
    source: "supabase:getallmyapps",
  };
}

async function handleTeamAddApplication(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:addteamapp");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:addteamapp:bad-session" };
  }
  if (Number(caller.player?.team_id || 0) > 0) {
    return { body: `"s", -1`, source: "supabase:addteamapp:already-on-team" };
  }

  const teamId = Number(params.get("tid") || 0);
  const comment = String(params.get("c") || "").trim();
  if (!teamId) {
    return { body: `"s", 0`, source: "supabase:addteamapp:no-team" };
  }
  if (comment.length > 280) {
    return { body: `"s", -5`, source: "supabase:addteamapp:comment-too-long" };
  }

  const teamContext = await loadTeamContextById({ supabase, services, teamId });
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:addteamapp:unknown-team" };
  }
  if (String(teamContext.team.recruitment_type || "open").toLowerCase() === "closed") {
    return { body: `"s", -3`, source: "supabase:addteamapp:closed" };
  }
  if ((teamContext.teamMeta.applications || []).some(
    (entry) => Number(entry.applicantPlayerId || 0) === Number(caller.playerId),
  )) {
    return { body: `"s", -2`, source: "supabase:addteamapp:duplicate" };
  }

  const application = {
    id: `${teamId}:${caller.playerId}`,
    applicantPlayerId: Number(caller.playerId),
    applicantPublicId: Number(caller.publicId),
    applicantName: caller.player.username,
    applicantScore: Number(caller.player.score || 0),
    teamId: Number(teamContext.team.id),
    teamName: teamContext.team.name,
    teamScore: Number(teamContext.team.score || 0),
    comment,
    status: TEAM_APP_STATUS.PENDING,
    createdAt: Date.now(),
  };

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    applications: [...(teamContext.teamMeta.applications || []), application],
  });

  return { body: `"s", 1`, source: "supabase:addteamapp" };
}

async function handleTeamDeleteApplication(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:deleteapp");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:deleteapp:bad-session" };
  }

  const teamId = Number(params.get("tid") || 0);
  if (!teamId) {
    return { body: `"s", 0`, source: "supabase:deleteapp:no-team" };
  }

  const teamContext = await loadTeamContextById({ supabase, services, teamId });
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:deleteapp:unknown-team" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    applications: (teamContext.teamMeta.applications || []).filter(
      (entry) => Number(entry.applicantPlayerId || 0) !== Number(caller.playerId),
    ),
  });

  return { body: `"s", 1`, source: "supabase:deleteapp" };
}

async function handleTeamUpdateApplication(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:updateteamapp", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:updateteamapp:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:updateteamapp:not-manager" };
  }

  const applicantPublicId = Number(params.get("aaid") || 0);
  const responseValue = Number(params.get("r") || 0);
  const targetStatus = responseValue === 1 ? TEAM_APP_STATUS.ACCEPTED : TEAM_APP_STATUS.DECLINED;
  const existingApp = (teamContext.teamMeta.applications || []).find(
    (entry) => Number(entry.applicantPublicId || 0) === applicantPublicId,
  );

  if (!existingApp) {
    return { body: `"s", -1`, source: "supabase:updateteamapp:missing-app" };
  }
  if (String(existingApp.status || TEAM_APP_STATUS.PENDING) !== TEAM_APP_STATUS.PENDING) {
    return { body: `"s", -2`, source: "supabase:updateteamapp:already-processed" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    applications: (teamContext.teamMeta.applications || []).map((entry) => (
      Number(entry.applicantPublicId || 0) === applicantPublicId
        ? { ...entry, status: targetStatus }
        : entry
    )),
  });

  return { body: `"s", 1`, source: "supabase:updateteamapp" };
}

async function handleTeamUpdateLeaderComments(context) {
  const { supabase, services, params } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:updateleadercomments", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:updateleadercomments:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:updateleadercomments:not-manager" };
  }

  saveTeamMeta(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    leaderComments: String(params.get("lc") || "").slice(0, 400),
  });

  return { body: `"s", 1`, source: "supabase:updateleadercomments" };
}

async function handleSetTeamColor(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:setteamcolor", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:setteamcolor:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:setteamcolor:not-manager" };
  }

  const colorCode = String(params.get("bg") || "").replace(/[^0-9A-F]/gi, "").toUpperCase().slice(0, 6) || "7D7D7D";
  await updateTeamRecord(supabase, teamContext.team.id, { background_color: colorCode });
  return { body: `"s", 1`, source: "supabase:setteamcolor" };
}

async function handleUpdateTeamReq(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const { caller, teamContext, callerRole } = await loadCallerTeamContext(context, "supabase:updateteamreq", {
    requireMembership: true,
  });
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:updateteamreq:bad-session" };
  }
  if (!teamContext || !isTeamManager(callerRole)) {
    return { body: `"s", 0`, source: "supabase:updateteamreq:not-manager" };
  }

  const recruitmentType = String(params.get("rt") || teamContext.team.recruitment_type || "open");
  const vip = Number(params.get("v") || teamContext.team.vip || 0);
  await updateTeamRecord(supabase, teamContext.team.id, {
    recruitment_type: recruitmentType,
    vip,
  });

  return { body: `"s", 1`, source: "supabase:updateteamreq" };
}

async function loadTeamRivalsContext({ supabase, roomPlayers = [], teamIds = [] }) {
  const relevantTeamIds = [
    ...new Set(
      [
        ...roomPlayers.map((player) => Number(player.teamId || 0)),
        ...teamIds.map((teamId) => Number(teamId || 0)),
      ].filter((teamId) => teamId > 0),
    ),
  ];

  if (relevantTeamIds.length === 0) {
    return { teams: [], members: [], players: [], playersById: new Map(), membersByTeamId: new Map() };
  }

  const [teams, members] = await Promise.all([
    listTeamsByIds(supabase, relevantTeamIds),
    listTeamMembersForTeams(supabase, relevantTeamIds),
  ]);
  const players = await listPlayersByIds(
    supabase,
    members.map((member) => Number(member.player_id || 0)),
  );
  const playersById = new Map(players.map((player) => [Number(player.id), player]));
  const membersByTeamId = new Map();

  for (const member of members) {
    const key = Number(member.team_id || 0);
    if (!membersByTeamId.has(key)) {
      membersByTeamId.set(key, []);
    }
    membersByTeamId.get(key).push({
      ...member,
      player: playersById.get(Number(member.player_id || 0)) || null,
    });
  }

  return { teams, members, players, playersById, membersByTeamId };
}

function getLeaderForTeam(team, membersByTeamId, roomPlayersById = new Map()) {
  const members = membersByTeamId.get(Number(team.id)) || [];
  const onlineMembers = members.filter((member) => roomPlayersById.has(Number(member.player_id || 0)));
  const preferred = onlineMembers[0] || members[0] || null;
  return preferred?.player || null;
}

function buildTeamRivalsTeamsXml({ teams, membersByTeamId, roomPlayers, callerTeamId }) {
  const roomPlayersById = new Map(
    roomPlayers.map((player) => [Number(player.playerId || 0), player]),
  );
  const callerTeam = teams.find((team) => Number(team.id) === Number(callerTeamId)) || null;
  const rootMaxBet = Number(callerTeam?.team_fund || 0);
  const teamsXml = teams.map((team) => {
    const leader = getLeaderForTeam(team, membersByTeamId, roomPlayersById);
    return (
      `<t i='${Number(team.id)}' n='${escapeXml(team.name || "")}' ` +
      `l='${escapeXml(leader?.username || "")}' li='${Number(leader?.id || 0)}' ` +
      `sc='${Number(team.score || 0)}' mb='${Number(team.team_fund || 0)}'/>`
    );
  }).join("");

  return `<t mb='${rootMaxBet}'>${teamsXml}</t>`;
}

function buildTeamRivalsChallengeXml(challenge) {
  const matchesXml = (challenge.matches || []).map((match, index) =>
    `<m idx='${index + 1}' ai1='${Number(match.ai1 || 0)}' ai2='${Number(match.ai2 || 0)}' ` +
    `aci1='${Number(match.aci1 || 0)}' aci2='${Number(match.aci2 || 0)}' ` +
    `bt1='${Number(match.bt1 || 0)}' bt2='${Number(match.bt2 || 0)}'/>`
  ).join("");

  return (
    `<tr id='${escapeXml(challenge.id)}' ti1='${Number(challenge.ti1 || 0)}' ti2='${Number(challenge.ti2 || 0)}' ` +
    `ai1='${Number(challenge.ai1 || 0)}' h='${Number(challenge.h || 0)}' r='${Number(challenge.r || 0)}' ` +
    `b='${Number(challenge.b || 0)}' mb='${Number(challenge.b || 0)}' s='${escapeXml(challenge.status || "pending")}' ` +
    `cr='${Number(challenge.createdBy || 0)}'>${matchesXml}</tr>`
  );
}

function buildTeamRivalsQueueXml() {
  const challenges = [...teamRivalsChallengesById.values()]
    .filter((challenge) => challenge.status !== "denied")
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
  return `<q>${challenges.map((challenge) => buildTeamRivalsChallengeXml(challenge)).join("")}</q>`;
}

function refreshTeamRivalsRoomState(services) {
  const raceRoomRegistry = services?.raceRoomRegistry;
  const tcpServer = services?.tcpServer;
  const queueXml = buildTeamRivalsQueueXml();

  if (raceRoomRegistry) {
    const room = raceRoomRegistry.get(TEAM_RIVALS_ROOM_ID);
    if (room) {
      raceRoomRegistry.upsert(TEAM_RIVALS_ROOM_ID, {
        ...room,
        teamRivalsQueueXml: queueXml,
      });
    }
  }

  if (!tcpServer) {
    return;
  }

  const roomPlayers = tcpServer.rooms.get(TEAM_RIVALS_ROOM_ID) || [];
  for (const player of roomPlayers) {
    const conn = tcpServer.connections.get(player.connId);
    if (!conn) {
      continue;
    }
    tcpServer.sendMessage(conn, `"ac", "LR", "s", "${escapeTcpXml(queueXml)}"`);
    tcpServer.sendRoomUsers(conn, roomPlayers);
  }
}

async function handleTeamRivalsGetTeams(context) {
  const { supabase, services } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:trgetteams");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:trgetteams:bad-session" };
  }

  const roomPlayers = services?.tcpServer?.rooms?.get(TEAM_RIVALS_ROOM_ID) || [];
  const callerRoomPlayer = roomPlayers.find((player) => Number(player.playerId || 0) === Number(caller.playerId));
  const membership = callerRoomPlayer?.teamId
    ? { team_id: callerRoomPlayer.teamId }
    : await getPlayerTeamMembership(supabase, caller.playerId);
  const callerTeamId = Number(membership?.team_id || 0);

  const { teams, membersByTeamId } = await loadTeamRivalsContext({
    supabase,
    roomPlayers,
    teamIds: callerTeamId ? [callerTeamId] : [],
  });

  return {
    body: wrapSuccessData(
      buildTeamRivalsTeamsXml({
        teams,
        membersByTeamId,
        roomPlayers,
        callerTeamId,
      }),
    ),
    source: "supabase:trgetteams",
  };
}

async function handleTeamRivalsGetRacers() {
  return {
    body: wrapSuccessData(buildTeamRivalsQueueXml()),
    source: "generated:trgetracers",
  };
}

async function handleTeamRivalsPreRequest(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:trprerequest");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:trprerequest:bad-session" };
  }

  const values = getActionValueCandidates(params);
  const challengeeTeamId = Number(
    params.get("tid")
    || params.get("teamid")
    || params.get("challengeeteamid")
    || values[0]
    || 0,
  );
  const callerMembership = await getPlayerTeamMembership(supabase, caller.playerId);
  const callerTeamId = Number(callerMembership?.team_id || 0);

  if (!callerTeamId || !challengeeTeamId || callerTeamId === challengeeTeamId) {
    return { body: `"s", 0`, source: "supabase:trprerequest:invalid-team" };
  }

  return {
    body: `"s", 1`,
    source: "supabase:trprerequest",
  };
}

async function handleTeamRivalsRequest(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:trrequest");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:trrequest:bad-session" };
  }

  const callerMembership = await getPlayerTeamMembership(supabase, caller.playerId);
  const callerTeamId = Number(callerMembership?.team_id || 0);
  const values = getActionValueCandidates(params);
  const challengeeTeamId = Number(params.get("tid") || params.get("teamid") || values[0] || 0);
  const challengerIds = parseCsvIntegerList(params.get("caids") || params.get("aids1") || params.get("challengeraccountids") || values[1]);
  const challengeeIds = parseCsvIntegerList(params.get("oaids") || params.get("aids2") || params.get("challengeeaccountids") || values[2]);
  const challengerCarIds = parseCsvIntegerList(params.get("cacids") || params.get("cids1") || params.get("challengeraccountcarids") || values[3]);
  const challengeeCarIds = parseCsvIntegerList(params.get("oacids") || params.get("cids2") || params.get("challengeeaccountcarids") || values[4]);
  const betAmount = Number(params.get("b") || params.get("bet") || params.get("betamount") || values[5] || 0);
  const isHeadsUp = Number(params.get("h") || params.get("headsup") || values[6] || 0) ? 1 : 0;
  const isRanked = Number(params.get("r") || params.get("ranked") || values[7] || 0) ? 1 : 0;

  const expectedMatchCount = challengerIds.length;
  const lengths = [challengeeIds.length, challengerCarIds.length, challengeeCarIds.length];
  if (!callerTeamId || !challengeeTeamId || callerTeamId === challengeeTeamId || expectedMatchCount < 2 || lengths.some((length) => length !== expectedMatchCount)) {
    return {
      body: `"s", 0, "d", "<e e='Invalid Team Rivals challenge setup.'/>"`,
      source: "supabase:trrequest:invalid",
    };
  }

  const challengeId = randomUUID();
  const challenge = {
    id: challengeId,
    createdAt: Date.now(),
    createdBy: caller.playerId,
    ti1: callerTeamId,
    ti2: challengeeTeamId,
    ai1: challengerIds[0],
    b: betAmount,
    h: isHeadsUp ? 1 : 0,
    r: isRanked ? 1 : 0,
    status: "pending",
    matches: challengerIds.map((challengerId, index) => ({
      ai1: challengerId,
      ai2: challengeeIds[index],
      aci1: challengerCarIds[index],
      aci2: challengeeCarIds[index],
      bt1: 0,
      bt2: 0,
    })),
  };

  teamRivalsChallengesById.set(challengeId, challenge);
  refreshTeamRivalsRoomState(services);

  return {
    body: `"s", 1`,
    source: "supabase:trrequest",
  };
}

async function handleTeamRivalsResponse(context) {
  const { params, services } = context;
  const values = getActionValueCandidates(params);
  const raceGuid = String(params.get("id") || params.get("guid") || params.get("raceguid") || values[0] || "").trim();
  const accept = Number(params.get("a") || params.get("accept") || values[1] || 0) ? 1 : 0;
  const challenge = teamRivalsChallengesById.get(raceGuid);

  if (!challenge) {
    return {
      body: `"s", -1, "msg", "Challenge no longer exists."`,
      source: "generated:trresponse:not-found",
    };
  }

  if (!accept) {
    teamRivalsChallengesById.delete(raceGuid);
    refreshTeamRivalsRoomState(services);
    return {
      body: `"s", 1, "msg", ""`,
      source: "generated:trresponse:denied",
    };
  }

  challenge.status = "accepted";
  teamRivalsChallengesById.set(raceGuid, challenge);
  refreshTeamRivalsRoomState(services);
  return {
    body: `"s", 1, "msg", ""`,
    source: "generated:trresponse:accepted",
  };
}

async function handleTeamRivalsOk(context) {
  const caller = await resolveCallerSession(context, "supabase:trok");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:trok:bad-session" };
  }

  const values = getActionValueCandidates(context.params);
  const bracketTime = Number(context.params.get("bt") || context.params.get("brackettime") || values[0] || 0) || 0;

  return {
    body: wrapSuccessData(`<r i='${Number(caller.playerId)}' bt='${bracketTime}'/>`),
    source: "generated:trok",
  };
}

async function handleLogin(context) {
  const { supabase, params, logger } = context;
  if (!supabase) {
    return null;
  }

  const username = normalizeUsername(params.get("u"));
  const password = params.get("p") || "";

  if (!username || !password) {
    logger.warn("Login failed: missing credentials", { username: username || "(empty)" });
    return { body: failureBody(), source: "supabase:login:missing-credentials" };
  }

  try {
    const player = await getPlayerByUsername(supabase, username);

    if (!player || !verifyGamePassword(password, player.password_hash)) {
      logger.warn("Login failed: invalid credentials", { 
        username, 
        playerExists: !!player,
        passwordMatch: player ? verifyGamePassword(password, player.password_hash) : false
      });
      return { body: failureBody(), source: "supabase:login:invalid" };
    }

    logger.info("Login successful", { username, playerId: player.id, publicId: player.public_id });

    const cars = await ensurePlayerHasGarageCar(supabase, player.id, {
      catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
      wheelXml: getDefaultWheelXmlForCar(DEFAULT_STARTER_CATALOG_CAR_ID),
      partsXml: DEFAULT_STOCK_PARTS_XML,
    });
    const garageCars = decorateCarsWithTestDriveState(player.id, cars);
    const sessionKey = await createLoginSession({ supabase, playerId: player.id });
    return {
      body: buildLoginBody(player, garageCars, null, sessionKey, logger, {
        testDriveCar: buildTestDriveLoginState(player.id, garageCars),
      }),
      source: "supabase:login",
    };
  } catch (error) {
    logger.error("Login error", { error: error.message, stack: error.stack });
    return { body: failureBody(), source: "supabase:login:error" };
  }
}

async function handleCreateAccount(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const username = normalizeUsername(params.get("u") || params.get("un") || params.get("username"));
  const password = params.get("p") || params.get("pw") || params.get("password") || "";

  if (!username || !password) {
    return { body: `"s", -18`, source: "supabase:createaccount:missing-credentials" };
  }

  const existing = await getPlayerByUsername(supabase, username);
  if (existing) {
    return { body: `"s", -2`, source: "supabase:createaccount:exists" };
  }

  // Optional hints from the client (safe defaults if absent).
  const genderRaw = params.get("g") ?? params.get("gender");
  const gender = genderRaw === "1" || /^f/i.test(String(genderRaw || "")) ? "f" : "m";
  const imageId = Number(params.get("im") ?? params.get("image") ?? 0) || 0;
  const starterCatalogCarId = Number(params.get("cid") ?? params.get("ci") ?? DEFAULT_STARTER_CATALOG_CAR_ID)
    || DEFAULT_STARTER_CATALOG_CAR_ID;
  const starterWheelId = String(params.get("wid") || "1001").replace(/[^0-9]/g, "") || "1001";
  const starterColor = String(params.get("clr") || "C0C0C0").replace(/[^0-9a-f]/gi, "").slice(0, 6) || "C0C0C0";

  let player;
  try {
    player = await createPlayer(supabase, {
      username,
      passwordHash: hashGamePassword(password),
      gender,
      imageId,
      money: 50000,
      points: 0,
      score: 0,
      clientRole: 5,
    });
  } catch (error) {
    // Most common failure is unique username constraint.
    return { body: `"s", -9`, source: "supabase:createaccount:insert-failed" };
  }

  // Give the player a starter car if they do not have one yet.
  try {
    await createStarterCar(supabase, {
      playerId: player.id,
      catalogCarId: starterCatalogCarId,
      paintIndex: 4,
      plateName: "",
      colorCode: starterColor,
      partsXml: getDefaultPartsXmlForCar(starterCatalogCarId),
      wheelXml: getDefaultWheelXmlForCar(starterCatalogCarId),
    });
  } catch (error) {
    // If a starter car insert fails (e.g. constraint), continue; login will still work.
  }

  return {
    // Create-account is status-only; client should call `login` afterwards.
    body: `"s", 1`,
    source: "supabase:createaccount:ok",
  };
}

async function handleGetCode() {
  return {
    body: wrapSuccessData(randomUUID()),
    source: "generated:getcode",
  };
}

async function handleGetUser(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getuser");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getuser:bad-session" };
  }

  const targetPublicId = Number(params.get("tid") || params.get("aid") || 0);
  if (!targetPublicId) {
    return { body: failureBody(), source: "supabase:getuser:missing-target" };
  }

  const player = await resolveTargetPlayerByPublicId(supabase, targetPublicId);
  if (!player) {
    return { body: failureBody(), source: "supabase:getuser:not-found" };
  }

  return {
    body: wrapSuccessData(renderUserSummary(player, { publicId: getPublicIdForPlayer(player) })),
    source: "supabase:getuser",
  };
}

async function handleGetUsers(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getusers");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getusers:bad-session" };
  }

  const targetPublicIds = (params.get("aids") || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (targetPublicIds.length === 0) {
    return { body: failureBody(), source: "supabase:getusers:missing-targets" };
  }

  const players = [];
  for (const publicId of targetPublicIds) {
    const player = await resolveTargetPlayerByPublicId(supabase, publicId);
    if (player) {
      players.push(player);
    }
  }

  return {
    body: wrapSuccessData(
      renderUserSummaries(
        players,
        new Map(players.map((player) => [Number(player.id), { publicId: getPublicIdForPlayer(player) }])),
      ),
    ),
    source: "supabase:getusers",
  };
}

async function handleGetRacersCars(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const acidList = (params.get("acids") || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  const caller = await resolveCallerSession(context, "supabase:getracerscars");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getracerscars:bad-session" };
  }

  const cars = await listCarsByIds(supabase, acidList);
  const racerCars = await attachOwnerPublicIds(supabase, cars);

  return {
    body: wrapSuccessData(renderRacerCars(racerCars)),
    source: "supabase:getracerscars",
  };
}

async function handleGetAllOtherUserCars(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getallotherusercars");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:getallotherusercars:bad-session",
    };
  }

  const targetPublicId = Number(params.get("tid") || 0);
  if (!targetPublicId) {
    return { body: failureBody(), source: "supabase:getallotherusercars:missing-target" };
  }

  const targetPlayer = await resolveTargetPlayerByPublicId(supabase, targetPublicId);
  if (!targetPlayer) {
    return { body: failureBody(), source: "supabase:getallotherusercars:not-found" };
  }

  return {
    body: wrapSuccessData(
      renderOwnedGarageCarsWrapper(await ensurePlayerHasGarageCar(supabase, targetPlayer.id, {
        catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
        wheelXml: getDefaultWheelXmlForCar(DEFAULT_STARTER_CATALOG_CAR_ID),
        partsXml: DEFAULT_STOCK_PARTS_XML,
      }), {
        ownerPublicId: getPublicIdForPlayer(targetPlayer),
      }),
    ),
    source: "supabase:getallotherusercars",
  };
}

async function handleGetTwoRacersCars(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:gettworacerscars");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:gettworacerscars:bad-session",
    };
  }

  const gameCarIds = [params.get("r1acid"), params.get("r2acid")]
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (gameCarIds.length === 0) {
    return { body: failureBody(), source: "supabase:gettworacerscars:missing-cars" };
  }

  return {
    body: wrapSuccessData(renderTwoRacerCars(await listCarsByIds(supabase, gameCarIds))),
    source: "supabase:gettworacerscars",
  };
}

async function handleGetAllCars(context) {
  const { supabase, logger } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getallcars");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getallcars:bad-session" };
  }

  const cars = await ensurePlayerHasGarageCar(supabase, caller.playerId, {
    catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
    wheelXml: getDefaultWheelXmlForCar(DEFAULT_STARTER_CATALOG_CAR_ID),
    partsXml: DEFAULT_STOCK_PARTS_XML,
  });
  const garageCars = decorateCarsWithTestDriveState(caller.playerId, cars);

  logger?.info("GetAllCars returning cars", { 
    count: garageCars.length, 
    carIds: garageCars.map(c => c.game_car_id),
    partsXmlLengths: garageCars.map(c => c.parts_xml?.length || 0)
  });

  return {
    body: wrapSuccessData(renderOwnedGarageCarsWrapper(garageCars, { ownerPublicId: caller.publicId })),
    source: "supabase:getallcars",
  };
}

async function handleGetAllParts(context) {
  const { supabase } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getallparts");
    if (!caller?.ok) {
      return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getallparts:bad-session" };
    }
  }

  return {
    body: wrapSuccessData(PARTS_CATALOG_XML),
    source: "static:getallparts",
  };
}

async function handleGetOneCarEngine(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";
  let car = null;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getonecarengine");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getonecarengine:bad-session",
      };
    }

    if (accountCarId) {
      car = await getCarById(supabase, accountCarId);
    }
  }

  if (!car) {
    return {
      body: failureBody(),
      source: "generated:getonecarengine:no-car",
    };
  }

  const { boostType, nosSize, compressionLevel } = getCarBuildFlags(car);

  const engineSound = boostType === "T" ? 2 : boostType === "S" ? 3 : 1;

  const catalogCarId = String(car?.catalog_car_id || "");
  if (!hasShowroomCarSpec(catalogCarId)) {
    return {
      body: failureBody(),
      source: "generated:getonecarengine:unsupported-car",
    };
  }
  const timing = generateTimingArray(catalogCarId);
  const engineXml = buildDriveableEngineXml({
    catalogCarId,
    accountCarId,
    boostType,
    nosSize,
    compressionLevel,
    engineSound,
  });

  return {
    body: `"s", 1, "d", "${engineXml}", "t", [${timing.join(', ')}]`,
    source: "generated:getonecarengine",
  };
}

async function handleBuyDyno(context) {
  const { supabase } = context;

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buydyno");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buydyno:bad-session" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buydyno:no-player" };
  }

  if (player.has_dyno === 1 || player.has_dyno === true) {
    return {
      body:
        `"s", 1, "b", ${player.money}, ` +
        `"bs", ${DEFAULT_DYNO_PURCHASE_STATE.boostSetting}, ` +
        `"mp", ${DEFAULT_DYNO_PURCHASE_STATE.maxPsi}, ` +
        `"cs", ${DEFAULT_DYNO_PURCHASE_STATE.chipSetting}, ` +
        `"sl", ${DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm}, ` +
        `"rl", ${DEFAULT_DYNO_PURCHASE_STATE.redLine}`,
      source: "supabase:buydyno:already-owned",
    };
  }

  const dynoPrice = 500;
  const newBalance = Number(player.money) - dynoPrice;

  if (newBalance < 0) {
    return { body: `"s", -2`, source: "supabase:buydyno:insufficient-funds" };
  }

  try {
    await updatePlayerRecord(supabase, caller.playerId, { money: newBalance, hasDyno: 1 });
  } catch (error) {
    console.error("Failed to update dyno ownership:", error);
    return { body: failureBody(), source: "supabase:buydyno:update-failed" };
  }

  // 10.0.03 garageDynoBuyCB expects positional scalar args:
  // (s, b, bs, mp, cs, sl, rl)
  return {
    body:
      `"s", 1, "b", ${newBalance}, ` +
      `"bs", ${DEFAULT_DYNO_PURCHASE_STATE.boostSetting}, ` +
      `"mp", ${DEFAULT_DYNO_PURCHASE_STATE.maxPsi}, ` +
      `"cs", ${DEFAULT_DYNO_PURCHASE_STATE.chipSetting}, ` +
      `"sl", ${DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm}, ` +
      `"rl", ${DEFAULT_DYNO_PURCHASE_STATE.redLine}`,
    source: "supabase:buydyno",
  };
}

async function handleBuyPart(context) {
  const { supabase, params, logger } = context;
  const accountCarId = params.get("acid") || "";
  const partId = Number(params.get("pid") || 0);
  const decalId = params.get("did") || "";
  const partType = params.get("pt") || "";
  const partPrice = Number(params.get("pr") || 0);

  if (!accountCarId) {
    return { body: failureBody(), source: "buypart:missing-params" };
  }

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buypart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buypart:bad-session" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buypart:no-player" };
  }

  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: failureBody(), source: "supabase:buypart:no-car" };
  }

  const catalogPart = partId ? (getPartsCatalogById().get(Number(partId)) ?? getWheelsTiresCatalogById().get(Number(partId))) : null;
  const isWheelPart = catalogPart && String(catalogPart.pi || "") === "14";
  let partName = "Part";
  let partSlotId = "";
  let partPs = "";
  let price = partPrice;

  if (catalogPart) {
    partName = catalogPart.n || "Part";
    partSlotId = String(catalogPart.pi || "");
    partPs = catalogPart.ps || "";
    if (price === 0) price = Number(catalogPart.p || 0);
  }

  // For custom panel graphics (pt=p), price from catalog if not provided
  if (price === 0 && partType === "p" && partId) {
    const panelPrices = {
      6000: 110,
      6001: 190,
      6002: 130,
      6003: 135,
      16001: 110,
      16101: 190,
      16201: 130,
      16301: 135,
    };
    price = panelPrices[partId] || 0;
  }

  if (!catalogPart && !(partType === "p" && decalId)) {
    return { body: failureBody(), source: "supabase:buypart:no-part" };
  }

  const newBalance = Number(player.money) - price;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buypart:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  let installId = createInstalledPartId();

  // Save part to the owned car's parts_xml
  if (accountCarId && partId) {
    if (partType === "p" && decalId) {
      const partSlotMap = {
        6000: "160",
        6001: "161",
        6002: "162",
        6003: "163",
        16001: "160",
        16101: "161",
        16201: "162",
        16301: "163",
      };
      const slotId = partSlotMap[partId] || String(catalogPart?.pi || "161");

      try {
        const { existsSync, mkdirSync, renameSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const decalDir = resolve(process.cwd(), "../cache/car/userDecals");
        mkdirSync(decalDir, { recursive: true });
        const sourcePath = resolve(decalDir, `${decalId}.jpg`);
        const targetPath = resolve(decalDir, `${slotId}_${decalId}.swf`);
        if (existsSync(sourcePath)) {
          renameSync(sourcePath, targetPath);
        } else {
          logger?.warn("Custom graphic source upload missing", { decalId, slotId, sourcePath });
        }
      } catch (err) {
        logger?.error("Failed to rename decal", { error: err.message });
      }

      const installedPartXml = `<p ai='${installId}' i='${partId}' ci='${slotId}' pt='c' n='Custom Graphic' in='1' cc='0' pdi='${decalId}' di='${decalId}' ps=''/>`;
      const partsXml = upsertInstalledPartXml(car.parts_xml || "", slotId, installedPartXml);
      try {
        await saveCarPartsXml(supabase, accountCarId, partsXml);
        logger?.info("Saved custom graphic to car", { accountCarId, partId, slotId, partsXmlLength: partsXml.length });
      } catch (error) {
        logger?.error("Failed to save custom graphic", { error, accountCarId, partId });
      }
    } else if (catalogPart && partSlotId) {
      if (isWheelPart) {
        // Wheels update wheel_xml (wid=designId, id=partId, ws=wheelSize)
        const designId = catalogPart.di || catalogPart.pdi || "1";
        const wheelSize = catalogPart.ps || "17";
        const newWheelXml = `<ws><w wid='${designId}' id='${partId}' ws='${wheelSize}'/></ws>`;
        try {
          await saveCarWheelXml(supabase, accountCarId, newWheelXml);
          logger?.info("Saved wheel to car", { accountCarId, partId, designId, wheelSize, installId });
        } catch (error) {
          logger?.error("Failed to save wheel", { error, accountCarId, partId });
        }
        // Also update parts_xml so the client sees ci='14' installed
        const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId, {
          t: "c",
          ps: wheelSize,
        });
        const partsXml = upsertInstalledPartXml(car.parts_xml || "", "14", installedPartXml);
        await saveCarPartsXml(supabase, accountCarId, partsXml);
      } else {
        const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId, {
          t: catalogPart.t || partType || "",
          ps: partPs,
        });
        const partsXml = upsertInstalledPartXml(car.parts_xml || "", partSlotId, installedPartXml);
        try {
          await saveCarPartsXml(supabase, accountCarId, partsXml);
          logger?.info("Saved part to car", { accountCarId, partId, partSlotId, partName, installId, partsXmlLength: partsXml.length });
        } catch (error) {
          logger?.error("Failed to save part", { error, accountCarId, partId, partSlotId });
        }
      }
    }
  }

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${installId}'/>", "d", "<r s='1' b='0'></r>"`,
    source: "supabase:buypart",
  };
}

async function handleBuyEnginePart(context) {
  const { supabase, params, logger } = context;
  const accountCarId = params.get("acid") || "";
  const partId = Number(params.get("epid") || 0);
  const partPrice = Number(params.get("pr") || 0);

  if (!accountCarId) {
    return { body: failureBody(), source: "buyenginepart:missing-params" };
  }

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buyenginepart");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:buyenginepart:bad-session",
    };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buyenginepart:no-player" };
  }

  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: failureBody(), source: "supabase:buyenginepart:no-car" };
  }

  const catalogPart = partId ? getPartsCatalogById().get(Number(partId)) : null;
  if (!catalogPart) {
    return { body: failureBody(), source: "supabase:buyenginepart:no-part" };
  }

  const price = partPrice || Number(catalogPart.p || 0);
  const newBalance = Number(player.money) - price;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buyenginepart:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  const installId = createInstalledPartId();
  const slotId = String(catalogPart.pi || "");
  const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId);
  const partsXml = upsertInstalledPartXml(car.parts_xml || "", slotId, installedPartXml);
  try {
    await saveCarPartsXml(supabase, accountCarId, partsXml);
    logger?.info("Saved engine part to car", { accountCarId, partId, slotId, installId, partsXmlLength: partsXml.length });
  } catch (error) {
    logger?.error("Failed to save engine part", { error, accountCarId, partId, slotId });
  }

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${installId}'/>", "d", "<r s='1' b='0'></r>"`,
    source: "supabase:buyenginepart",
  };
}

async function handleBuyCar(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buycar");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buycar:bad-session" };
  }

  const catalogCarId = parseShowroomPurchaseCatalogCarId(params);
  if (!catalogCarId) {
    return { body: failureBody(), source: "supabase:buycar:missing-car" };
  }
  if (!hasShowroomCarSpec(catalogCarId)) {
    return { body: failureBody(), source: "supabase:buycar:unsupported-car" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buycar:no-player" };
  }

  const purchasePrice = parseShowroomPurchasePrice(params) || getCatalogCarPrice(catalogCarId);
  const newBalance = Number(player.money) - purchasePrice;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buycar:insufficient-funds" };
  }

  const existingCars = await listCarsForPlayer(supabase, caller.playerId);
  
  // Allow color selection via 'cc' or 'c' parameter, default to silver
  const selectedColor = String(params.get("cc") || params.get("c") || "C0C0C0")
    .replace(/[^0-9A-F]/gi, "")
    .toUpperCase()
    .slice(0, 6) || "C0C0C0";
  const paintIndex = Number(getPaintIdForColorCode(selectedColor)) || 5;
  
  const createdCar = await createOwnedCar(supabase, {
    playerId: caller.playerId,
    catalogCarId,
    selected: existingCars.length === 0,
    paintIndex,
    plateName: "",
    colorCode: selectedColor,
    partsXml: getDefaultPartsXmlForCar(catalogCarId),
    wheelXml: getDefaultWheelXmlForCar(catalogCarId),
  });

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  return {
    body: `"s", 2, "m", "${newBalance}", "d", "<r i='${createdCar.game_car_id}' ai='${createdCar.game_car_id}' ci='${catalogCarId}'/>"`,
    source: "supabase:buycar",
  };
}

async function handleUpdateDefaultCar(context) {
  const { supabase, params } = context;
  const gameCarId = Number(params.get("acid") || params.get("cid") || 0);

  if (!gameCarId) {
    return { body: failureBody(), source: "updatedefaultcar:missing-params" };
  }

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:updatedefaultcar");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:updatedefaultcar:bad-session",
    };
  }

  // Verify the car belongs to this player
  const car = await getCarById(supabase, gameCarId);
  if (!car || Number(car.player_id) !== caller.playerId) {
    return { body: failureBody(), source: "supabase:updatedefaultcar:invalid-car" };
  }

  await updatePlayerDefaultCar(supabase, caller.playerId, gameCarId);

  // Response is just success
  return {
    body: `"s", 1`,
    source: "supabase:updatedefaultcar",
  };
}

async function handleGetTotalNewMail(context) {
  return handleGetTotalNewMailImpl(context);
}

async function handleGetRemarks(context) {
  return handleGetRemarksImpl(context);
}

async function handleGetWinsAndLosses(context) {
  const { supabase } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getwinsandlosses");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getwinsandlosses:bad-session",
      };
    }

    const player = await getPlayerById(supabase, caller.playerId);
    if (player) {
      return {
        body: wrapSuccessData(`<wl w='${player.wins ?? 0}' l='${player.losses ?? 0}'/>`),
        source: "supabase:getwinsandlosses",
      };
    }
  }

  return {
    body: wrapSuccessData("<wl w='0' l='0'/>"),
    source: "getwinsandlosses:zero",
  };
}

async function handleGetCarPrice(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";

  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getcarprice");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getcarprice:bad-session" };
  }

  if (!accountCarId) {
    return { body: failureBody(), source: "supabase:getcarprice:missing-car" };
  }

  // Get the car from database
  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: failureBody(), source: "supabase:getcarprice:invalid-car" };
  }

  // Calculate sell price (50% of catalog price)
  const catalogPrice = getCatalogCarPrice(car.catalog_car_id);
  const sellPrice = Math.floor(catalogPrice * 0.5);

  // Response format: "s", 1, "p", <price>
  return {
    body: `"s", 1, "p", ${sellPrice}`,
    source: "supabase:getcarprice",
  };
}

async function handleGetEmailList(context) {
  return handleGetEmailListImpl(context);
}

async function handleGetEmail(context) {
  return handleGetEmailImpl(context);
}

async function handleMarkEmailRead(context) {
  return handleMarkEmailReadImpl(context);
}

async function handleDeleteEmail(context) {
  return handleDeleteEmailImpl(context);
}

async function handleSendEmail(context) {
  return handleSendEmailImpl(context);
}

async function handleAddRemark(context) {
  return handleAddRemarkImpl(context);
}

async function handleDeleteRemark(context) {
  return handleDeleteRemarkImpl(context);
}

async function handleGetUserRemarks(context) {
  return handleGetUserRemarksImpl(context);
}

async function handleGetBlackCardProgress(context) {
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

  // Response format: "s", 1, "d", "<x s='0'/>"
  return {
    body: wrapSuccessData("<x s='0'/>"),
    source: "getblackcardprogress:zero",
  };
}

async function handleCheckTestDrive(context) {
  const { supabase } = context;
  let caller = null;

  if (supabase) {
    caller = await resolveCallerSession(context, "supabase:checktestdrive");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:checktestdrive:bad-session",
      };
    }
  }

  const player = caller?.player || null;
  const offer = player ? createTestDriveInvitation(player) : buildGuestTestDriveOffer(100);
  if (!offer) {
    return {
      body: failureBody(),
      source: "checktestdrive:no-supported-cars",
    };
  }
  const xml = `<t ci='${offer.catalogCarId}' c='${offer.colorCode}' tid='${offer.invitationId}' lod='${offer.locationId}'/>`;

  return {
    body: wrapSuccessData(xml),
    source: "checktestdrive:available",
  };
}

async function handleAcceptTestDrive(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:accepttestdrive");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:accepttestdrive:bad-session",
    };
  }

  const invitationId = Number(params.get("tid") || 0);
  const pendingInvitation = getPendingTestDriveInvitation(invitationId);
  if (!pendingInvitation || Number(pendingInvitation.playerId) !== Number(caller.playerId)) {
    return { body: `"s", -1`, source: "accepttestdrive:invalid-invitation" };
  }

  const createdCar = await createOwnedCar(supabase, {
    playerId: caller.playerId,
    catalogCarId: pendingInvitation.catalogCarId,
    selected: true,
    paintIndex: 4,
    plateName: "",
    colorCode: String(params.get("c") || pendingInvitation.colorCode || "C0C0C0"),
    partsXml: getDefaultPartsXmlForCar(pendingInvitation.catalogCarId),
    wheelXml: getDefaultWheelXmlForCar(pendingInvitation.catalogCarId),
    testDriveInvitationId: invitationId,
    testDriveName: getCatalogCarName(pendingInvitation.catalogCarId),
    testDriveMoneyPrice: pendingInvitation.moneyPrice,
    testDrivePointPrice: pendingInvitation.pointPrice,
    testDriveExpiresAt: new Date(Date.now() + pendingInvitation.hoursRemaining * 60 * 60 * 1000).toISOString(),
  });

  clearPendingTestDriveInvitation(invitationId);
  setActiveTestDriveCar({
    playerId: caller.playerId,
    gameCarId: createdCar.game_car_id,
    catalogCarId: pendingInvitation.catalogCarId,
    invitationId,
    moneyPrice: pendingInvitation.moneyPrice,
    pointPrice: pendingInvitation.pointPrice,
    hoursRemaining: pendingInvitation.hoursRemaining,
    expired: false,
  });

  return {
    body: `"s", 1, "h", "${pendingInvitation.hoursRemaining}", "m", "${pendingInvitation.moneyPrice}", "p", "${pendingInvitation.pointPrice}", "d", "${renderOwnedGarageCar(createdCar)}"`,
    source: "accepttestdrive:created",
  };
}

async function handleBuyTestDriveCar(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:buytestdrivecar");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:buytestdrivecar:bad-session",
    };
  }

  const activeTestDrive = await loadActiveTestDriveCar(supabase, caller.playerId);
  const invitationId = Number(params.get("tid") || 0);
  if (!activeTestDrive || Number(activeTestDrive.invitationId) !== invitationId) {
    return { body: `"s", 0`, source: "buytestdrivecar:missing-test-drive" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: `"s", -3`, source: "buytestdrivecar:no-player" };
  }

  const paymentType = String(params.get("pt") || "m").toLowerCase();
  if (paymentType === "p") {
    const newPointsBalance = Number(player.points) - Number(activeTestDrive.pointPrice);
    if (newPointsBalance < 0) {
      return { body: `"s", -4`, source: "buytestdrivecar:insufficient-points" };
    }

    await updatePlayerRecord(supabase, caller.playerId, { points: newPointsBalance });

    clearActiveTestDriveCar(caller.playerId);
    await clearCarTestDriveState(supabase, activeTestDrive.gameCarId);
    return {
      body: `"s", 1, "m", "${newPointsBalance}"`,
      source: "buytestdrivecar:points",
    };
  }

  const newMoneyBalance = Number(player.money) - Number(activeTestDrive.moneyPrice);
  if (newMoneyBalance < 0) {
    return { body: `"s", -4`, source: "buytestdrivecar:insufficient-money" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
  clearActiveTestDriveCar(caller.playerId);
  await clearCarTestDriveState(supabase, activeTestDrive.gameCarId);
  return {
    body: `"s", 2, "m", "${newMoneyBalance}"`,
    source: "buytestdrivecar:money",
  };
}

async function handleRemoveTestDriveCar(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:removetestdrivecar");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:removetestdrivecar:bad-session",
    };
  }

  const activeTestDrive = await loadActiveTestDriveCar(supabase, caller.playerId);
  const invitationId = Number(params.get("tid") || 0);
  if (!activeTestDrive || Number(activeTestDrive.invitationId) !== invitationId) {
    return { body: `"s", -1`, source: "removetestdrivecar:missing-test-drive" };
  }

  const car = await getCarById(supabase, activeTestDrive.gameCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    clearActiveTestDriveCar(caller.playerId);
    return { body: `"s", -2`, source: "removetestdrivecar:missing-car" };
  }

  await deleteCar(supabase, activeTestDrive.gameCarId);
  clearActiveTestDriveCar(caller.playerId);

  const remainingCars = await listCarsForPlayer(supabase, caller.playerId);
  if (remainingCars.length > 0) {
    await updatePlayerDefaultCar(supabase, caller.playerId, remainingCars[0].game_car_id);
  } else {
    await updatePlayerRecord(supabase, caller.playerId, { defaultCarGameId: null });
  }

  return {
    body: `"s", 1`,
    source: "removetestdrivecar:deleted",
  };
}

async function handleRejectTestDrive(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:rejecttestdrive");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:rejecttestdrive:bad-session",
    };
  }

  const invitationId = Number(params.get("tid") || 0);
  const invitation = getPendingTestDriveInvitation(invitationId);
  if (invitation && Number(invitation.playerId) === Number(caller.playerId)) {
    clearPendingTestDriveInvitation(invitationId);
  }

  return {
    body: `"s", 1`,
    source: "rejecttestdrive:ok",
  };
}

// ---------------------------------------------------------------------------
// Stub / generated handlers — actions the Python server handled that are not
// in our fixture data. Returning "s", 0 for any of these causes the game to
// emit "error 003" on the client. All stubs return "s", 1 (OK) with minimal
// valid XML so the client can move on.
// ---------------------------------------------------------------------------

function getCatalogCarName(catalogCarId) {
  return FULL_CAR_CATALOG.find(([cid]) => Number(cid) === Number(catalogCarId))?.[1] || "Unknown";
}

function getCatalogCarPointPrice(catalogCarId) {
  const moneyPrice = getCatalogCarPrice(catalogCarId);
  if (moneyPrice <= 0) return -1;
  return Math.max(1, Math.round(moneyPrice / 1000));
}

// Location-based tier for showroom filtering (from scripts/data/cars.py)
const LOCATION_MAX_PRICE = {
  100: 30000,   // Toreno
  200: 55000,   // Newburge
  300: 90000,   // Creek Side
  400: 175000,  // Vista Heights
  500: 999999,  // Diamond Point – all cars
};

// Dealer categories ported from scripts/data/dealers.py
const DEALER_CATEGORIES = [
  { i: "1001", pi: "0", n: "Toreno Showroom",       cl: "55AACC", l: "100" },
  { i: "1002", pi: "0", n: "Newburge Showroom",     cl: "55CC55", l: "200" },
  { i: "1003", pi: "0", n: "Creek Side Showroom",   cl: "CCAA55", l: "300" },
  { i: "1004", pi: "0", n: "Vista Heights Showroom",cl: "CC5555", l: "400" },
  { i: "1005", pi: "0", n: "Diamond Point Showroom",cl: "CC55CC", l: "500" },
];

function getShowroomLocationForCarPrice(price) {
  const locationTiers = Object.entries(LOCATION_MAX_PRICE).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [locationId, maxPrice] of locationTiers) {
    if (Number(price) <= Number(maxPrice)) {
      return Number(locationId);
    }
  }
  return 500;
}

function listShowroomCatalogCarsForLocation(locationId) {
  const targetLocationId = Number(locationId) || 100;
  return FULL_CAR_CATALOG.filter(([catalogCarId, , price]) => (
    hasShowroomCarSpec(catalogCarId) &&
    getShowroomLocationForCarPrice(price) === targetLocationId
  ));
}

function buildGuestTestDriveOffer(locationId = 100) {
  const [catalogCarId] = listShowroomCatalogCarsForLocation(locationId)[0] || [];
  if (!catalogCarId) {
    return null;
  }

  return {
    invitationId: Date.now(),
    catalogCarId: Number(catalogCarId),
    colorCode: "C0C0C0",
    locationId: Number(locationId) || 100,
  };
}

function createTestDriveInvitation(player) {
  const existingInvitation = pendingTestDriveInvitationsByPlayerId.get(Number(player?.id || 0));
  if (existingInvitation) {
    pendingTestDriveInvitationsById.delete(Number(existingInvitation.invitationId));
  }
  const showroomCars = listShowroomCatalogCarsForLocation(player?.location_id || 100);
  const [catalogCarId] = showroomCars[0] || [];
  if (!catalogCarId) {
    pendingTestDriveInvitationsByPlayerId.delete(Number(player?.id || 0));
    return null;
  }
  const invitationId = Date.now() + Math.floor(Math.random() * 1000);
  const offer = {
    invitationId,
    playerId: Number(player?.id || 0),
    catalogCarId: Number(catalogCarId),
    colorCode: "C0C0C0",
    locationId: Number(player?.location_id || 100) || 100,
    moneyPrice: getCatalogCarPrice(catalogCarId),
    pointPrice: getCatalogCarPointPrice(catalogCarId),
    hoursRemaining: TEST_DRIVE_DURATION_HOURS,
    expired: false,
  };
  pendingTestDriveInvitationsById.set(offer.invitationId, offer);
  pendingTestDriveInvitationsByPlayerId.set(offer.playerId, offer);
  return offer;
}

function clearPendingTestDriveInvitation(invitationId) {
  const existing = pendingTestDriveInvitationsById.get(Number(invitationId));
  if (!existing) {
    return null;
  }
  pendingTestDriveInvitationsById.delete(Number(invitationId));
  pendingTestDriveInvitationsByPlayerId.delete(Number(existing.playerId));
  return existing;
}

function getPendingTestDriveInvitation(invitationId) {
  return pendingTestDriveInvitationsById.get(Number(invitationId)) || null;
}

function setActiveTestDriveCar(state) {
  activeTestDriveCarsByPlayerId.set(Number(state.playerId), {
    ...state,
    playerId: Number(state.playerId),
    gameCarId: Number(state.gameCarId),
    catalogCarId: Number(state.catalogCarId),
    invitationId: Number(state.invitationId),
    moneyPrice: Number(state.moneyPrice),
    pointPrice: Number(state.pointPrice),
    hoursRemaining: Number(state.hoursRemaining),
    expired: Boolean(state.expired),
  });
}

function getActiveTestDriveCar(playerId) {
  return activeTestDriveCarsByPlayerId.get(Number(playerId)) || null;
}

function clearActiveTestDriveCar(playerId) {
  const existing = activeTestDriveCarsByPlayerId.get(Number(playerId)) || null;
  if (existing) {
    activeTestDriveCarsByPlayerId.delete(Number(playerId));
  }
  return existing;
}

function decorateCarsWithTestDriveState(playerId, cars) {
  const persistedTestDriveCar = findTestDriveCarInGarage(cars);
  if (persistedTestDriveCar) {
    return cars;
  }

  const activeTestDrive = getActiveTestDriveCar(playerId);
  if (!activeTestDrive) {
    return cars;
  }

  return cars.map((car) => {
    if (Number(car?.game_car_id || 0) !== Number(activeTestDrive.gameCarId)) {
      return car;
    }

    return {
      ...car,
      test_drive_active: 1,
      test_drive_expired: activeTestDrive.expired ? 1 : 0,
      test_drive_invitation_id: activeTestDrive.invitationId,
      test_drive_name: getCatalogCarName(activeTestDrive.catalogCarId),
      test_drive_money_price: activeTestDrive.moneyPrice,
      test_drive_point_price: activeTestDrive.pointPrice,
      test_drive_hours_remaining: activeTestDrive.hoursRemaining,
    };
  });
}

function findTestDriveCarInGarage(cars) {
  return cars.find((car) => Number(car?.test_drive_active || 0) === 1) || null;
}

async function loadActiveTestDriveCar(supabase, playerId) {
  const cars = await listCarsForPlayer(supabase, playerId);
  const persistedCar = findTestDriveCarInGarage(cars);
  if (persistedCar) {
    return {
      playerId: Number(playerId),
      gameCarId: Number(persistedCar.game_car_id),
      catalogCarId: Number(persistedCar.catalog_car_id),
      invitationId: Number(persistedCar.test_drive_invitation_id),
      moneyPrice: Number(persistedCar.test_drive_money_price),
      pointPrice: Number(persistedCar.test_drive_point_price),
      hoursRemaining: Number(persistedCar.test_drive_hours_remaining),
      expired: Number(persistedCar.test_drive_expired || 0) === 1,
    };
  }

  return getActiveTestDriveCar(playerId);
}

function buildTestDriveLoginState(playerId, cars = []) {
  const persistedCar = findTestDriveCarInGarage(cars);
  if (persistedCar) {
    return {
      gameCarId: Number(persistedCar.game_car_id),
      invitationId: Number(persistedCar.test_drive_invitation_id),
      moneyPrice: Number(persistedCar.test_drive_money_price),
      pointPrice: Number(persistedCar.test_drive_point_price),
      hoursRemaining: Number(persistedCar.test_drive_hours_remaining),
      expired: Number(persistedCar.test_drive_expired || 0),
    };
  }

  const activeTestDrive = getActiveTestDriveCar(playerId);
  if (!activeTestDrive) {
    return null;
  }

  return {
    gameCarId: activeTestDrive.gameCarId,
    invitationId: activeTestDrive.invitationId,
    moneyPrice: activeTestDrive.moneyPrice,
    pointPrice: activeTestDrive.pointPrice,
    hoursRemaining: activeTestDrive.hoursRemaining,
    expired: activeTestDrive.expired ? 1 : 0,
  };
}

// ── Physics-based timing array generation ────────────────────────────────────

/**
 * Build a CarRaceSpec from a car's showroom spec entry.
 */
function getShowroomSpecHorsepower(spec, catalogCarId) {
  const directHp = Number(spec.hp);
  if (Number.isFinite(directHp) && directHp > 0) {
    return directHp;
  }

  const hpMatch = String(spec.et || "").match(/^([\d.]+)/);
  if (hpMatch) {
    return Number(hpMatch[1]);
  }

  throw new Error(`Missing showroom horsepower for catalog car ${catalogCarId}`);
}

function getShowroomSpecWeight(spec, catalogCarId) {
  const weight = Number(spec.sw);
  if (Number.isFinite(weight) && weight > 0) {
    return weight;
  }

  throw new Error(`Missing showroom weight for catalog car ${catalogCarId}`);
}

function getShowroomSpecEstimatedEt(spec, catalogCarId) {
  const etMatch = String(spec.st || "").match(/^([\d.]+)/);
  if (etMatch) {
    return Number(etMatch[1]);
  }

  throw new Error(`Missing showroom ET for catalog car ${catalogCarId}`);
}

function buildSpecFromShowroomSpec(catalogCarId) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const hp = getShowroomSpecHorsepower(spec, catalogCarId);
  const weight = getShowroomSpecWeight(spec, catalogCarId);
  const estimatedEt = getShowroomSpecEstimatedEt(spec, catalogCarId);
  const transmissionStr = spec.tt;

  return buildCarRaceSpec({
    horsepower: hp,
    weightLbs: weight,
    engineStr: spec.eo,
    drivetrainStr: spec.dt,
    transmissionStr,
    bodyTypeStr: spec.ct,
    estimatedEt,
  });
}

function getCapturedTimingCurveProfile(spec) {
  const engine = String(spec?.eo || "").toLowerCase();
  const transmission = String(spec?.tt || "").toLowerCase();
  const isV8 = engine.includes("v8") || engine.includes("hemi");
  const isV10 = engine.includes("v10") || engine.includes("10-cyl");
  const isV6 = engine.includes("v6");
  const isRotary = engine.includes("rotary");
  const isBoosted = engine.includes("turbo") || engine.includes("supercharged") || /\btt\b/.test(engine) || /\bsc\b/.test(engine) || /\bt\b/.test(engine);
  const isSixSpeed = transmission.includes("6-speed");

  if (isV8 || isV10) {
    return {
      startFactor: 0.4,
      endFactor: isSixSpeed ? 0.406 : 0.404,
      curvePower: 1.7,
      length: 102,
    };
  }

  if (isV6) {
    return {
      startFactor: 0.395,
      endFactor: 0.425,
      curvePower: 1.45,
      length: 102,
    };
  }

  if (isRotary) {
    return {
      startFactor: 0.39,
      endFactor: 0.46,
      curvePower: 1.2,
      length: 102,
    };
  }

  if (isBoosted) {
    return {
      startFactor: 0.4,
      endFactor: 0.43,
      curvePower: 1.35,
      length: 102,
    };
  }

  return {
    startFactor: 0.4,
    endFactor: 0.47,
    curvePower: 1.15,
    length: 102,
  };
}

/**
 * Generate the live-style engine curve array for practice/getonecarengine.
 *
 * Community-server captures show this is a compact torque-style curve, not the
 * quarter-mile position-delta array used for computer opponents.
 */
const TEMP_USE_LEGACY_CAPTURED_TIMING_FOR_TESTING = true;

function applyTimingDeltas(values, deltas) {
  let currentValue = values[values.length - 1];
  for (const delta of deltas) {
    currentValue += delta;
    values.push(currentValue);
  }
}

function generateLegacyTimingArray() {
  const values = Array(9).fill(273);

  values.push(375);

  applyTimingDeltas(values, [
    12, 11, 12, 11, 11,
    12, 11, 12, 11, 12,
    11, 12, 11, 12, 11,
    12, 11, 12, 11, 12,
  ]);

  applyTimingDeltas(values, [
    9,
    3, 2, 3, 2, 2,
    3, 2, 3, 2, 3,
    2, 3, 2, 2, 3,
    2, 3, 2, 3, 2,
    2, 3, 2, 3, 2,
    3, 2, 0,
  ]);

  applyTimingDeltas(values, [
    -8, -7,
    -8, -8, -8, -8, -8,
    -8, -8, -8, -8, -8,
    -8, -8, -8, -7,
    -8, -9, -8, -9, -8,
    -9, -9, -8, -9, -8,
    -9, -8, -9, -8, -9,
    -8, -9, -8, -9, -8,
    -9, -8, -9, -8, -9,
  ]);

  if (values.length !== 100) {
    throw new Error(`Expected 100 timing values, got ${values.length}`);
  }

  return values;
}

function generateTimingArray(catalogCarId) {
  // Temporary testing switch: use the exact legacy captured curve so we can
  // verify client behavior, then flip this back off to restore generated timing.
  if (TEMP_USE_LEGACY_CAPTURED_TIMING_FOR_TESTING) {
    return generateLegacyTimingArray();
  }

  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const torque = getShowroomSpecTorque(spec, catalogCarId);
  const profile = getCapturedTimingCurveProfile(spec);
  const startValue = torque * profile.startFactor;
  const endValue = Math.max(startValue + 1, torque * profile.endFactor);
  const values = [];

  for (let index = 0; index < profile.length; index += 1) {
    const progress = profile.length <= 1 ? 1 : index / (profile.length - 1);
    const eased = Math.pow(progress, profile.curvePower);
    const value = startValue + ((endValue - startValue) * eased);
    values.push(Math.max(1, Math.round(value)));
  }

  return values;
}

/**
 * Get the redline RPM for a catalog car (used in n2 sl= and a= attributes).
 */
function getCarRedLine(catalogCarId) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }
  return getRedLine(spec.eo, spec.tt);
}

/**
 * Build the per-car n2 physics fields from showroom spec data.
 *
 * Derived formulas:
 *   x = z = hp * 0.02859
 *   y = x * 5.5
 *   r = weightLbs + 18
 *   aa = cylinder count from engine string
 *   sl = redline RPM (from engine type)
 *   a = power peak RPM (≈ redline for high-revving engines, lower for V8/V6)
 *   n = torque peak RPM (≈ 0.82 * redline for V8, ≈ redline for I4)
 *   o = rev limiter (redline + 100-200)
 *   f/g/h/i/j/l = gear ratios from gearbox profile
 */
function buildN2Fields(catalogCarId) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const hp = getShowroomSpecHorsepower(spec, catalogCarId);
  const weight = getShowroomSpecWeight(spec, catalogCarId);
  const engineStr = spec.eo.toLowerCase();
  const drivetrainStr = spec.dt.toUpperCase();
  const transmissionStr = spec.tt;

  // x, y, z — physics power params
  const x = parseFloat((hp * 0.02859).toFixed(3));
  const z = x;
  const y = parseFloat((x * 5.5).toFixed(3));

  // r — weight-derived field
  const r = weight + 18;

  // aa — cylinder count
  let aa = 4;
  if (engineStr.includes("v10") || engineStr.includes("10-cyl")) aa = 10;
  else if (engineStr.includes("v8") || engineStr.includes("8-cyl") || engineStr.includes("hemi")) aa = 8;
  else if (engineStr.includes("v6") || engineStr.includes("6-cyl") || engineStr.includes("i6") || engineStr.includes("h6")) aa = 6;
  else if (engineStr.includes("rotary")) aa = 2;
  else if (engineStr.includes("3-cyl") || engineStr.includes("i3")) aa = 3;

  // RPM fields
  const sl = getRedLine(spec.eo, spec.tt);
  const o = sl + (engineStr.includes("vtec") || engineStr.includes("i4") ? 200 : 100);

  // Power peak RPM (a) and torque peak RPM (n)
  let a = sl;
  let n = sl;
  if (engineStr.includes("v8") || engineStr.includes("hemi")) {
    a = Math.round(sl * 0.92);
    n = Math.round(sl * 0.985);
  } else if (engineStr.includes("v6")) {
    a = Math.round(sl * 0.94);
    n = Math.round(sl * 0.985);
  } else if (engineStr.includes("turbo") || engineStr.includes(" tt") || engineStr.includes(" t ") || / t$/.test(engineStr)) {
    a = Math.round(sl * 0.88);
    n = Math.round(sl * 0.68);
  }

  // Gear ratios from gearbox profile
  const raceSpec = buildCarRaceSpec({
    horsepower: hp, weightLbs: weight,
    engineStr: spec.eo, drivetrainStr,
    transmissionStr, bodyTypeStr: spec.ct,
  });
  const ratios = raceSpec.gearbox.forwardRatios;
  const f = ratios[0] ?? 3.587;
  const g = ratios[1] ?? 2.022;
  const h = ratios[2] ?? 1.384;
  const i = ratios[3] ?? 1.000;
  const j = ratios[4] ?? 0.861;
  const l = raceSpec.gearbox.finalDrive;

  return { x, y, z, r, aa, sl, a, n, o, f, g, h, i, j, l };
}

function getShowroomSpecTorque(spec, catalogCarId) {
  const tq = Number(spec?.tq || 0);
  if (Number.isFinite(tq) && tq > 0) {
    return tq;
  }

  const hp = getShowroomSpecHorsepower(spec, catalogCarId);
  return Math.max(100, Math.round(hp * 0.92));
}

function getCarBuildFlags(car) {
  const xml = String(car?.parts_xml || "");
  let boostType = "0";
  let nosSize = 0;
  let compressionLevel = 0;

  if (xml) {
    if (/<p[^>]*\b(?:ci|pi)=["']87["'][^>]*\/>/.test(xml)) boostType = "T";
    else if (/<p[^>]*\b(?:ci|pi)=["']81["'][^>]*\/>/.test(xml)) boostType = "S";
    const hasBottles = /<p[^>]*\b(?:ci|pi)=["']203["'][^>]*\/>/.test(xml);
    const hasJets = /<p[^>]*\b(?:ci|pi)=["']204["'][^>]*\/>/.test(xml);
    if (hasBottles && hasJets) nosSize = 100;

    const pistonMatch = xml.match(/<p[^>]*\b(?:ci|pi)=["']190["'][^>]*\b(?:di|pdi)=["'](\d+)["'][^>]*\/>/i);
    compressionLevel = pistonMatch ? Number(pistonMatch[1]) : 0;
  }

  if (boostType === "0" && car?.catalog_car_id) {
    const defaultParts = getDefaultPartsXmlForCar(car.catalog_car_id);
    if (defaultParts) {
      if (/<p[^>]*\bpi=["']87["'][^>]*\/>/.test(defaultParts)) boostType = "T";
      else if (/<p[^>]*\bpi=["']81["'][^>]*\/>/.test(defaultParts)) boostType = "S";
    }
  }

  return { boostType, nosSize, compressionLevel };
}

function getDriveableBoostField(boostType) {
  const numericBoost = Number(boostType);
  // The legacy Flash practice client expects `b` to stay numeric. String
  // flags like "T" / "S" bubble into NaN client-side and break launch state.
  return Number.isFinite(numericBoost) ? numericBoost : 0;
}

function buildDriveableEngineXml({ catalogCarId }) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const n2 = buildN2Fields(catalogCarId);
  const valveCount = n2.aa * 4;

  return (
    `<n2 es='1' sl='${n2.sl}' sg='0' rc='0' tmp='0' r='${n2.r}' v='0' ` +
    `a='${n2.a}' n='${n2.n}' o='${n2.o}' s='0.854' b='0' p='1.8' c='0' e='0' d='N' ` +
    `f='${n2.f}' g='${n2.g}' h='${n2.h}' i='${n2.i}' j='${n2.j}' k='0' l='${n2.l}' ` +
    `q='0' m='0' t='0' u='10' w='0' x='${n2.x}' y='${n2.y}' z='${n2.z}' ` +
    `aa='${n2.aa}' ab='${valveCount}' ac='0' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
    `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
    `at='100' au='100' av='0' aw='100' ax='0'/>`
  );
}

function buildShowroomXml(locationId, starterOnly = false) {
  const targetLocationId = Number(locationId) || 100;

  // Show all cars at every location — players can buy any car regardless of where they live.
  // For starter showroom, restrict to the cheapest tier only.
  const locationTiers = Object.entries(LOCATION_MAX_PRICE).sort((a, b) => Number(a[0]) - Number(b[0]));
  const getCarLocation = (price) => {
    for (const [lid, maxP] of locationTiers) {
      if (Number(price) <= maxP) return Number(lid);
    }
    return 500;
  };

  const eligible = FULL_CAR_CATALOG.filter(([catalogCarId, , price]) => {
    const numPrice = Number(price);
    if (numPrice <= 0) return false;
    if (!hasShowroomCarSpec(catalogCarId)) return false;
    if (starterOnly) return getCarLocation(numPrice) === 100;
    return true; // all priced cars available at every location
  });

  const locationToCatId = { 100: 1001, 200: 1002, 300: 1003, 400: 1004, 500: 1005 };

  const selectedCarId = eligible.length > 0 ? eligible[0][0] : "0";
  const showroomColors = [
    { paintId: "5", colorCode: "C0C0C0" },
    { paintId: "15", colorCode: "CC0000" },
    { paintId: "3", colorCode: "000000" },
    { paintId: "4", colorCode: "FFFFFF" },
    { paintId: "16", colorCode: "0033FF" },
    { paintId: "6", colorCode: "FFD700" },
    { paintId: "7", colorCode: "00AA00" },
    { paintId: "8", colorCode: "FF6600" },
  ];

  const carNodes = eligible
    .map(([cid, name, price], index) => {
      const escapedName = escapeXml(name);
      const spec = getShowroomCarSpec(cid);
      const wheelFitment = getDefaultWheelFitmentForCar(cid);
      const carLocationId = starterOnly ? 100 : getCarLocation(price);
      const catId = locationToCatId[carLocationId] || 1001;
      const primarySwatch = showroomColors[index % showroomColors.length];
      const swatchNodes = showroomColors
        .map(({ paintId, colorCode }) => `<p i='${paintId}' cd='${colorCode}'/>`)
        .join("");
      const purchasePrice = Number(price) || 0;
      const pointPrice = getCatalogCarPointPrice(cid);

      return (
        `<c ai='0' id='${cid}' i='${cid}' ci='${cid}' ` +
        `sel='${index === 0 ? "1" : "0"}' pi='${catId}' pn='' ` +
        `l='${carLocationId}' lid='${carLocationId}' cid='${carLocationId}' ` +
        `b='0' n='${escapedName}' c='${escapedName}' p='${purchasePrice}' pr='${purchasePrice}' pp='${pointPrice}' cp='${purchasePrice}' ` +
        `lk='0' ae='0' cc='${primarySwatch.colorCode}' g='' ii='0' ` +
        `wid='${wheelFitment.designId}' ws='${wheelFitment.size}' rh='0' ts='0' mo='0' ` +
        `cbl='0' cb='0' po='0' poc='0' led='' ` +
        `le='0' lea='999' les='0' lec='999' let='0' ` +
        `eo='${escapeXml(spec.eo)}' dt='${escapeXml(spec.dt)}' np='${escapeXml(spec.np)}' ct='${escapeXml(spec.ct)}' ` +
        `et='${escapeXml(spec.et)}' tt='${escapeXml(spec.tt)}' sw='${escapeXml(spec.sw)}' st='${escapeXml(spec.st)}' y='${escapeXml(spec.y)}'` +
        `>` +
        renderShowroomCarBody(cid, {
          colorCode: primarySwatch.colorCode,
          paintIndex: primarySwatch.paintId,
        }) +
        swatchNodes +
        `</c>`
      );
    })
    .join("");

  return `<cars i='0' dc='${selectedCarId}' l='${targetLocationId}'>${carNodes}</cars>`;
}

async function handleMoveLocation(context) {
  const { supabase, params } = context;
  const locationId = Number(params.get("lid") || params.get("l") || params.get("id") || 0);
  const paymentType = String(params.get("pt") || "m").toLowerCase(); // "p"=points, "m"=money

  if (supabase && locationId) {
    const caller = await resolveCallerSession(context, "supabase:movelocation");
    if (caller?.ok) {
      await updatePlayerLocation(supabase, caller.playerId, locationId);
      // s=1 means points payment, s=2 means money payment
      // m = current balance (client sets its display to this value)
      const player = await getPlayerById(supabase, caller.playerId);
      const s = paymentType === "p" ? 1 : 2;
      const balance = s === 1 ? Number(player?.points ?? 0) : Number(player?.money ?? 0);
      return {
        body: `"s", ${s}, "m", ${balance}`,
        source: "supabase:movelocation",
      };
    }
  }

  return { body: `"s", 2, "m", 0`, source: `stub:movelocation:${locationId}` };
}


async function handleListClassified(context) {
  // Empty classified ads list.
  return {
    body: wrapSuccessData(`<cars i='0' dc='0'></cars>`),
    source: "stub:listclassified",
  };
}

async function handleViewShowroom(context) {
  const { params } = context;
  let locationId = Number(params.get("lid") || params.get("l") || 0);

  // Opening the showroom should not depend on the player's current city.
  // Default to the first category so players can browse the full catalog
  // without moving locations first.
  if (!locationId) locationId = 100;

  const xml = buildShowroomXml(locationId);
  return {
    body: wrapSuccessData(xml),
    source: `stub:viewshowroom:lid=${locationId}`,
  };
}

async function handleGetStarterShowroom(context) {
  return {
    body: wrapSuccessData(buildShowroomXml(100, true)),
    source: "stub:getstartershowroom",
  };
}

async function handleUploadRequest(context) {
  // The client uploads decals/avatars to an external CDN. In local mode we
  // just tell it the upload is accepted.
  return { body: `"s", 1`, source: "stub:uploadrequest" };
}

async function handleSellCar(context) {
  const { supabase, params } = context;

  if (!supabase) {
    return { body: `"s", 1`, source: "stub:sellcar:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:sellcar");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:sellcar:bad-session" };
  }

  const gameCarId = Number(params.get("acid") || params.get("cid") || 0);
  const salePrice = Number(params.get("pr") || params.get("price") || 0);

  if (gameCarId) {
    // Verify the car belongs to this player before crediting money
    const car = await getCarById(supabase, gameCarId);
    if (car && Number(car.player_id) === caller.playerId) {
      const player = await getPlayerById(supabase, caller.playerId);
      const newBalance = Number(player?.money ?? 0) + salePrice;
      await updatePlayerMoney(supabase, caller.playerId, newBalance);
      await deleteCar(supabase, gameCarId);
      return {
        body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='0'/>", "d", "<r s='1' b='0'/>"`,
        source: "supabase:sellcar",
      };
    }
  }

  return { body: `"s", 1`, source: "stub:sellcar" };
}

async function handleGetCarCategories(context) {
  const catNodes = DEALER_CATEGORIES
    .map((c) => `<c i='${c.i}' pi='${c.pi}' n='${escapeXml(c.n)}' cl='${c.cl}' l='${c.l}'/>`)
    .join("");
  return {
    body: wrapSuccessData(`<cats>${catNodes}</cats>`),
    source: "stub:getcarcategories",
  };
}

async function handleGetGearInfo(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";
  let car = null;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getgearinfo");
    if (caller && !caller.ok) {
      return { body: caller.body || failureBody(), source: caller.source || "supabase:getgearinfo:bad-session" };
    }

    if (accountCarId) {
      car = await getCarById(supabase, accountCarId);
      if (car && caller?.playerId && Number(car.player_id) !== Number(caller.playerId)) {
        car = null;
      }
    }
  }

  let ratios = {
    g1: "3.587",
    g2: "2.022",
    g3: "1.384",
    g4: "1",
    g5: "0.861",
    g6: "0",
    fg: "4.058",
  };

  const catalogCarId = String(car?.catalog_car_id || "");
  if (catalogCarId && hasShowroomCarSpec(catalogCarId)) {
    const n2 = buildN2Fields(catalogCarId);
    ratios = {
      g1: String(n2.f ?? ratios.g1),
      g2: String(n2.g ?? ratios.g2),
      g3: String(n2.h ?? ratios.g3),
      g4: String(n2.i ?? ratios.g4),
      g5: String(n2.j ?? ratios.g5),
      g6: "0",
      fg: String(n2.l ?? ratios.fg),
    };
  }

  const gearRatios =
    `<g p='2500' pp='25'>` +
    `<r g1='${ratios.g1}' g2='${ratios.g2}' g3='${ratios.g3}' g4='${ratios.g4}' g5='${ratios.g5}' g6='${ratios.g6}' fg='${ratios.fg}'/>` +
    `</g>`;
  return {
    body: wrapSuccessData(gearRatios),
    source: "generated:getgearinfo",
  };
}

async function handlePractice(context) {
  const { supabase, logger, params } = context;
  const accountCarId = params.get("acid") || "";
  let car = null;

  if (!accountCarId) {
    return {
      body: failureBody(),
      source: "generated:practice:missing-car",
    };
  }

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:practice");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:practice:bad-session",
      };
    }

    car = await getCarById(supabase, accountCarId);
    if (!car || Number(car.player_id) !== Number(caller.playerId)) {
      return {
        body: failureBody(),
        source: "supabase:practice:no-car",
      };
    }
  }

  if (!car) {
    return {
      body: failureBody(),
      source: "generated:practice:no-car",
    };
  }

  const { boostType, nosSize, compressionLevel } = getCarBuildFlags(car);
  const engineSound = boostType === "T" ? 2 : boostType === "S" ? 3 : 1;

  const catalogCarId = String(car?.catalog_car_id || "");
  if (!hasShowroomCarSpec(catalogCarId)) {
    return {
      body: failureBody(),
      source: "generated:practice:unsupported-car",
    };
  }
  const timing = generateTimingArray(catalogCarId);
  const carStats = buildDriveableEngineXml({
    catalogCarId,
    accountCarId,
    boostType,
    nosSize,
    compressionLevel,
    engineSound,
  });

  const body = `"s", 1, "d", "${carStats}", "t", [${timing.join(', ')}]`;

  logger?.info("Practice response", {
    carId: accountCarId,
    catalogCarId,
    boostType,
    nosSize,
    bodyLength: body.length,
  });

  return { body, source: "generated:practice" };
}

async function handlePracticeLifecycleAck(context, actionName) {
  const { supabase, params } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, `supabase:${actionName}`);
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || `supabase:${actionName}:bad-session`,
      };
    }

    const accountCarId = params.get("acid") || params.get("cid") || "";
    if (accountCarId) {
      const car = await getCarById(supabase, accountCarId);
      if (!car || Number(car.player_id) !== Number(caller.playerId)) {
        return {
          body: failureBody(),
          source: `supabase:${actionName}:no-car`,
        };
      }
    }
  }

  return {
    body: `"s", 1`,
    source: `generated:${actionName}`,
  };
}

const COMPUTER_TOURNAMENTS = [
  { id: 1, type: "tourneyA", name: "Amateur Computer Tournament", minEt: 15.2, maxEt: 16.9, minRt: 0.085, maxRt: 0.225, minHp: 155, maxHp: 225, minWeight: 2550, maxWeight: 3200, minTrap: 84, maxTrap: 101, purse: 250 },
  { id: 2, type: "tourneyS", name: "Sport Computer Tournament", minEt: 13.1, maxEt: 14.7, minRt: 0.07, maxRt: 0.18, minHp: 240, maxHp: 360, minWeight: 2450, maxWeight: 3150, minTrap: 101, maxTrap: 121, purse: 750 },
  { id: 3, type: "tourneyP", name: "Pro Computer Tournament", minEt: 10.4, maxEt: 12.3, minRt: 0.045, maxRt: 0.14, minHp: 420, maxHp: 680, minWeight: 2250, maxWeight: 3050, minTrap: 122, maxTrap: 151, purse: 2000 },
];

const computerTournamentSessions = new Map();

function getComputerTournamentDefinition(tournamentId) {
  return COMPUTER_TOURNAMENTS.find((entry) => Number(entry.id) === Number(tournamentId)) || COMPUTER_TOURNAMENTS[0];
}

function seededFraction(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function interpolate(min, max, fraction) {
  return min + (max - min) * fraction;
}

function formatMetric(value, decimals = 3) {
  return Number(value || 0).toFixed(decimals);
}

function buildComputerTournamentCompetitorNode(tournament, index) {
  const seedBase = Number(tournament.id) * 100 + index * 17;
  const horsepower = Math.round(interpolate(tournament.minHp, tournament.maxHp, seededFraction(seedBase + 1)));
  const weight = Math.round(interpolate(tournament.minWeight, tournament.maxWeight, seededFraction(seedBase + 2)));
  const reactionTime = interpolate(tournament.minRt, tournament.maxRt, seededFraction(seedBase + 3));
  const elapsedTime = interpolate(tournament.minEt, tournament.maxEt, seededFraction(seedBase + 4));
  const trapSpeed = interpolate(tournament.minTrap, tournament.maxTrap, seededFraction(seedBase + 5));
  const totalTime = reactionTime + elapsedTime;
  const competitorId = 1000 + Number(tournament.id) * 100 + index;
  const accountCarId = 2000 + Number(tournament.id) * 100 + index;
  const racerNumber = 100 + index;
  const username = `${tournament.type} ${String(index + 1).padStart(2, "0")}`;

  return (
    `<r id='${competitorId}' i='${accountCarId}' n='${escapeXml(username)}' u='${escapeXml(username)}' ` +
    `bt='0' rt='${formatMetric(reactionTime)}' et='${formatMetric(elapsedTime)}' ts='${formatMetric(trapSpeed, 2)}' ` +
    `racerNum='${racerNumber}' type='C' hp='${horsepower}' w='${weight}'/>`
  );
}

function buildComputerTournamentFieldXml(tournamentId) {
  const tournament = getComputerTournamentDefinition(tournamentId);
  const competitorsXml = Array.from({ length: 31 }, (_, index) =>
    buildComputerTournamentCompetitorNode(tournament, index)
  ).join("");
  return `<n2>${competitorsXml}</n2>`;
}

function buildComputerTournamentOpponentXml(session) {
  const tournament = getComputerTournamentDefinition(session?.tournamentId);
  const opponentIndex = Number(session?.wins || 0) % 31;
  const purse = Number(tournament.purse || 0) * (Number(session?.wins || 0) + 1);
  const seedBase = Number(tournament.id) * 300 + opponentIndex * 19;
  const reactionTime = interpolate(tournament.minRt, tournament.maxRt, seededFraction(seedBase + 1));
  const elapsedTime = interpolate(tournament.minEt, tournament.maxEt, seededFraction(seedBase + 2));
  const trapSpeed = interpolate(tournament.minTrap, tournament.maxTrap, seededFraction(seedBase + 3));
  const opponentId = 5000 + Number(tournament.id) * 100 + opponentIndex;
  const opponentCarId = 6000 + Number(tournament.id) * 100 + opponentIndex;
  const opponentName = `${tournament.name} Opponent ${String(opponentIndex + 1).padStart(2, "0")}`;

  return {
    purse,
    xml:
      `<n2><r id='${opponentId}' i='${opponentCarId}' n='${escapeXml(opponentName)}' u='${escapeXml(opponentName)}' ` +
      `bt='0' rt='${formatMetric(reactionTime)}' et='${formatMetric(elapsedTime)}' ts='${formatMetric(trapSpeed, 2)}' ` +
      `total='${formatMetric(reactionTime + elapsedTime)}' racerNum='${200 + opponentIndex}' type='C'/></n2>`,
  };
}

async function handleGetAvatarAge(context) {
  const { params } = context;
  const tidsParam = params.get("tids") || "";
  const tids = tidsParam.split(",").filter(Boolean).map(Number);
  
  // Return avatar age for each team ID (age is always 0 for now)
  const result = tids.map(tid => [tid, 0]);
  
  return {
    body: `"s", 1, "tids", [${result.map(pair => `[${pair.join(', ')}]`).join(', ')}]`,
    source: "stub:getavatarage",
  };
}

async function handleGetTeamAvatarAge(context) {
  const { params } = context;
  const tidsParam = params.get("tids") || "";
  const tids = tidsParam.split(",").filter(Boolean).map(Number);
  
  // Return avatar age for each team ID (age is always 0 for now)
  const result = tids.map(tid => [tid, 0]);
  
  return {
    body: `"s", 1, "tids", [${result.map(pair => `[${pair.join(', ')}]`).join(', ')}]`,
    source: "stub:getteamavatarage",
  };
}

async function handleGetLeaderboard(context) {
  return handleGetLeaderboardImpl(context);
}

async function handleGetLeaderboardMenu(context) {
  return handleGetLeaderboardMenuImpl(context);
}

async function handleGetNews(context) {
  return {
    body: wrapSuccessData(
      `<news><n i='1' d='4/5/2026 12:00:00 PM'><t>Welcome to Nitto Legends</t><c>We are here for fun, to test, and to race! So let's race!</c></n></news>`,
    ),
    source: "generated:getnews",
  };
}

async function handleGetSpotlightRacers(context) {
  return {
    body: wrapSuccessData(
      `<spotlight><r u='Community' c='Acura Integra GSR' et='11.234' w='50' t='Apr 5th 2026' uid='1' ad='4/5/2026' aauid='0' aa='Server Admin' at='Community Spotlight'><b>Welcome to Nitto!!</b></r></spotlight>`,
    ),
    source: "generated:getspotlightracers",
  };
}


async function handleGetRacerSearch(context) {
  const { supabase, params, logger } = context;
  const username = params.get("u") || params.get("un") || params.get("username") || "";

  if (!supabase || !username) {
    logger.warn("Racer search: no username provided");
    return { body: wrapSuccessData(`<u></u>`), source: "racersearch:empty" };
  }

  let players = [];
  try {
    players = await searchPlayersByUsername(supabase, username, 20);
  } catch (error) {
    logger.error("Racer search error", { error: error.message });
    return { body: wrapSuccessData(`<u></u>`), source: "supabase:racersearch:error" };
  }

  const nodes = (players || [])
    .map((p) => `<r u='${escapeXml(p.username)}' i='${getPublicIdForPlayer(p)}' r='${p.client_role}' />`)
    .join("");

  return {
    body: wrapSuccessData(`<u>${nodes}</u>`),
    source: "supabase:racersearch",
  };
}

async function handleGetSupport(context) {
  // Support request handler for moderator tools and player reports
  return {
    body: `"s", 1`,
    source: "stub:getsupport",
  };
}

async function handleGetDescription(context) {
  return {
    body: wrapSuccessData(`<d></d>`),
    source: "stub:getdescription",
  };
}

async function handleGetBuddies(context) {
  // Return empty buddies list - TCP server not implemented yet
  return {
    body: wrapSuccessData(`<buddies></buddies>`),
    source: "stub:getbuddies",
  };
}

async function handleCompletePollQuestion(context) {
  const { logger, params } = context;
  const caller = await resolveCallerSession(context, "supabase:completepollquestion");
  if (!caller?.ok) {
    return caller;
  }

  const answerId = Number(params.get("said"));
  const questionId = Number(params.get("sqid"));

  logger.info("Ignoring completed poll submission for inactive poll", {
    playerId: caller.playerId,
    publicId: caller.publicId,
    answerId: Number.isFinite(answerId) && answerId > 0 ? answerId : null,
    questionId: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
  });

  return {
    body: `"s", 1`,
    source: "generated:completepollquestion:noop",
  };
}

async function handleTeamInfo(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
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
      body: wrapSuccessData("<teams></teams>"),
      source: "supabase:teaminfo:none",
    };
  }

  const [teams, players] = await Promise.all([
    listTeamsByIds(supabase, teamIds),
    listPlayersForTeams(supabase, teamIds),
  ]);

  if (teams.length === 0) {
    return {
      body: wrapSuccessData("<teams></teams>"),
      source: "supabase:teaminfo:not-found",
    };
  }

  const playersByTeamId = groupPlayersByTeamId(players);

  return {
    body: wrapSuccessData(renderTeamsWithMetadata(teams, playersByTeamId, services)),
    source: "supabase:teaminfo",
  };
}

const handlers = {
  // --- Authentication ---
  login: handleLogin,
  getcode: handleGetCode,
  createaccount: handleCreateAccount,
  createuser: handleCreateAccount,
  register: handleCreateAccount,
  registerswf: handleCreateAccount,
  signup: handleCreateAccount,
  // --- Players ---
  getuser: handleGetUser,
  getusers: handleGetUsers,
  // --- Cars ---
  getracerscars: handleGetRacersCars,
  getallotherusercars: handleGetAllOtherUserCars,
  gettworacerscars: handleGetTwoRacersCars,
  getallcars: handleGetAllCars,
  getonecar: handleGetAllCars, // same shape as getallcars, returns the player's car(s)
  getallcats: async () => {
    return { body: PARTS_CATEGORIES_BODY, source: "static:getallcats" };
  },
  getpaintcats: handleGetPaintCategories,
  getpaints: handleGetPaints,
  updatedefaultcar: handleUpdateDefaultCar,
  getcarprice: handleGetCarPrice,
  sellcar: handleSellCar,
  // --- Parts & Engine ---
  getallparts: handleGetAllParts,
  getallwheelstires: async () => {
    return { body: wrapSuccessData(buildWheelsTiresCatalogXml()), source: "generated:getallwheelstires" };
  },
  getonecarengine: handleGetOneCarEngine,
  getgearinfo: handleGetGearInfo,
  buydyno: handleBuyDyno,
  buypart: handleBuyPart,
  buyenginepart: handleBuyEnginePart,
  // --- Showroom / Dealership ---
  buycar: handleBuyCar,
  buyshowroomcar: handleBuyCar,
  buystartercar: handleBuyCar,
  buydealercar: handleBuyCar,
  buytestdrivecar: handleBuyTestDriveCar,
  buyshowroom: handleBuyCar,
  purchasecar: handleBuyCar,
  viewshowroom: handleViewShowroom,
  getstartershowroom: handleGetStarterShowroom,
  buildviewshowroom: handleViewShowroom,
  getcarcategories: handleGetCarCategories,
  listclassified: handleListClassified,
  // --- Location / World ---
  movelocation: handleMoveLocation,
  // --- Social / Mail / Badges ---
  gettotalnewmail: handleGetTotalNewMail,
  getemaillist: handleGetEmailList,
  getremarks: handleGetRemarks,
  getwinsandlosses: handleGetWinsAndLosses,
  getblackcardprogress: handleGetBlackCardProgress,
  // Email actions
  getemail: handleGetEmail,
  markemailread: handleMarkEmailRead,
  deleteemail: handleDeleteEmail,
  sendemail: handleSendEmail,
  // Remarks
  addremark: handleAddRemark,
  deleteremark: handleDeleteRemark,
  getuserremarks: handleGetUserRemarks,
  setnondeletes: async () => ({ body: `"s", 1`, source: "stub:setnondeletes" }),
  setdeletes: async () => ({ body: `"s", 1`, source: "stub:setdeletes" }),
  // Repair
  getrepairparts: async (context) => {
    const { params } = context;
    const acid = params.get("acid") || "0";
    return { body: `"s", 1, "d", "<parts/>"`, source: "stub:getrepairparts" };
  },
  repairparts: async () => ({ body: `"s", 2`, source: "stub:repairparts" }),
  // Garage / parts bin
  getcarpartsbin: handleGetCarPartsBinImpl,
  getpartsbin: handleGetPartsBinImpl,
  sellcarpart: async () => ({ body: `"s", 1`, source: "stub:sellcarpart" }),
  sellenginepart: async () => ({ body: `"s", 1`, source: "stub:sellenginepart" }),
  sellengine: async () => ({ body: `"s", 1`, source: "stub:sellengine" }),
  installpart: handleInstallPartImpl,
  installenginepart: async () => ({ body: wrapSuccessData(`<r s='1' b='0'/>`), source: "stub:installenginepart" }),
  swapengine: async () => ({ body: wrapSuccessData(`<r s='1' b='0'/>`), source: "stub:swapengine" }),
  // Account / profile
  updatebg: async () => ({ body: `"s", 1`, source: "stub:updatebg" }),
  addastopbuddy: async () => ({ body: `"s", 1`, source: "stub:addastopbuddy" }),
  removeastopbuddy: async () => ({ body: `"s", 1`, source: "stub:removeastopbuddy" }),
  changepassword: async () => ({ body: `"s", 1`, source: "stub:changepassword" }),
  changepasswordreq: async () => ({ body: `"s", 1`, source: "stub:changepasswordreq" }),
  changeemail: async () => ({ body: `"s", 1`, source: "stub:changeemail" }),
  changehomemachine: async () => ({ body: `"s", 1`, source: "stub:changehomemachine" }),
  agreetoterms: async () => ({ body: `"s", 1`, source: "stub:agreetoterms" }),
  verifyaccount: async () => ({ body: `"s", 1`, source: "stub:verifyaccount" }),
  activateaccount: async () => ({ body: `"s", 1`, source: "stub:activateaccount" }),
  resendactivation: async () => ({ body: `"s", 1`, source: "stub:resendactivation" }),
  forgotpw: async () => ({ body: `"s", 1`, source: "stub:forgotpw" }),
  activatepoints: async () => ({ body: `"s", 1`, source: "stub:activatepoints" }),
  activatemember: async () => ({ body: `"s", 1`, source: "stub:activatemember" }),
  getinfo: async () => ({ body: `"s", 1`, source: "stub:getinfo" }),
  getlocations: async (context) => {
    // Already in login payload but client may request it separately
    return { body: `"s", 1`, source: "stub:getlocations" };
  },
  getinstalledenginepartbyaccountcar: async () => ({ body: `"s", 1, "d", "<parts/>"`, source: "stub:getinstalledenginepartbyaccountcar" }),
  racersearchnopage: async (context) => {
    // Same as racersearch but without pagination
    return handleGetRacerSearch(context);
  },
  checktestdrive: handleCheckTestDrive,
  accepttestdrive: handleAcceptTestDrive,
  removetestdrivecar: handleRemoveTestDriveCar,
  rejecttestdrive: handleRejectTestDrive,
  teamcreate: handleTeamCreate,
  teamkick: handleTeamKick,
  teamchangerole: handleTeamChangeRole,
  teamupdatemaxbet: handleTeamUpdateMaxBet,
  teamnewleader: handleTeamNewLeader,
  teamquit: handleTeamQuit,
  teamaccept: handleTeamAccept,
  teamdisperse: handleTeamDisperse,
  teamstepdown: handleTeamStepDown,
  teamdeposit: handleTeamDeposit,
  teamwithdraw: handleTeamWithdraw,
  teamwithdrawal: handleTeamWithdraw,
  teaminfo: handleTeamInfo,
  getteaminfo: handleTeamInfo,
  addteamapp: handleTeamAddApplication,
  getallteamapps: handleTeamGetAllApps,
  getallmyapps: handleTeamGetMyApps,
  deleteapp: handleTeamDeleteApplication,
  updateteamapp: handleTeamUpdateApplication,
  updateleadercomments: handleTeamUpdateLeaderComments,
  setteamcolor: handleSetTeamColor,
  updateteamreq: handleUpdateTeamReq,
  getleaderboardmenu: handleGetLeaderboardMenu,
  getleaderboard: handleGetLeaderboard,
  getnews: handleGetNews,
  getspotlightracers: handleGetSpotlightRacers,
  racersearch: handleGetRacerSearch,
  getsupport: handleGetSupport,
  getdescription: handleGetDescription,
  getavatarage: handleGetAvatarAge,
  getteamavatarage: handleGetTeamAvatarAge,
  completepollquestion: handleCompletePollQuestion,
  trgetracers: handleTeamRivalsGetRacers,
  trgetteams: handleTeamRivalsGetTeams,
  trprerequest: handleTeamRivalsPreRequest,
  trrequest: handleTeamRivalsRequest,
  trresponse: handleTeamRivalsResponse,
  trok: handleTeamRivalsOk,
  // --- Buddies ---
  getbuddies: handleGetBuddies,
  getbuddylist: handleGetBuddies,
  buddylist: handleGetBuddies,
  // --- Uploads ---
  uploadrequest: handleUploadRequest,
  // --- Race ---
  practice: handlePractice,
  endpractice: async (context) => handlePracticeLifecycleAck(context, "endpractice"),
  leavepractice: async (context) => handlePracticeLifecycleAck(context, "leavepractice"),
  exitpractice: async (context) => handlePracticeLifecycleAck(context, "exitpractice"),
  practiceend: async (context) => handlePracticeLifecycleAck(context, "practiceend"),
  // --- Computer Tournaments (10.0.03 source of truth) ---
  ctgr: async (context) => {
    const { params, logger } = context;
    const tournamentId = Number(params.get("ctid") || params.get("tid") || 1);
    const xml = buildComputerTournamentFieldXml(tournamentId);

    logger.info("ctgr called - returning computer tournament racers", {
      tournamentId,
      racerCount: 31,
    });

    return {
      body: wrapSuccessData(xml),
      source: `generated:ctgr:tournament=${tournamentId}`,
    };
  },
  ctjt: async (context) => {
    const { params, logger } = context;
    const tournamentId = Number(params.get("ctid") || 1);
    const tournamentKey = randomUUID();
    const session = {
      tournamentId,
      createdAt: Date.now(),
      bracketTime: null,
      qualifyingComplete: false,
      wins: 0,
    };
    computerTournamentSessions.set(tournamentKey, session);

    logger.info("ctjt called - joined computer tournament", {
      tournamentId,
      tournamentKey,
    });

    return {
      body: `"s", 1, "k", "${tournamentKey}"`,
      source: `generated:ctjt:tournament=${tournamentId}`,
    };
  },
  ctct: async (context) => {
    const { params, logger } = context;
    const tournamentKey = params.get("k") || "";
    const bracketTime = Number(params.get("bt") || 0);
    const session = computerTournamentSessions.get(tournamentKey) || {
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
    };

    session.bracketTime = bracketTime;
    session.qualifyingComplete = true;
    computerTournamentSessions.set(tournamentKey, session);

    logger.info("ctct called - saved computer tournament qualifying pass", {
      tournamentKey,
      bracketTime,
    });

    return {
      body: `"s", 1`,
      source: "generated:ctct",
    };
  },
  ctrt: async (context) => {
    const { params, logger } = context;
    const tournamentKey = params.get("k") || "";
    const session = computerTournamentSessions.get(tournamentKey) || {
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
    };
    const opponent = buildComputerTournamentOpponentXml(session);

    logger.info("ctrt called - returning computer tournament opponent", {
      tournamentKey,
      tournamentId: session.tournamentId,
      wins: session.wins,
      purse: opponent.purse,
    });

    return {
      body: `"s", 1, "d", "${opponent.xml}", "b", ${opponent.purse}`,
      source: "generated:ctrt",
    };
  },
  ctst: async (context) => {
    const { params, logger } = context;
    const tournamentKey = params.get("k") || "";
    const session = computerTournamentSessions.get(tournamentKey) || {
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
    };
    const winState = Number(params.get("w") || 1) ? 1 : 0;
    const payout = Number(params.get("b") || getComputerTournamentDefinition(session.tournamentId).purse || 0);

    if (winState) {
      session.wins = Number(session.wins || 0) + 1;
    }
    computerTournamentSessions.set(tournamentKey, session);

    logger.info("ctst called - saved computer tournament race result", {
      tournamentKey,
      winState,
      payout,
      wins: session.wins,
    });

    return {
      body: `"s", 1, "d", "<n2 w='${winState}' b='${payout}'/>"`,
      source: "generated:ctst",
    };
  },
  leaveroom: async (context) => {
    // Leave current race room
    const { services, supabase } = context;
    const raceRoomRegistry = services?.raceRoomRegistry;
    const tcpNotify = services?.tcpNotify;
    
    if (!raceRoomRegistry) {
      return { body: wrapSuccessData("<leave s='0'/>"), source: "leaveroom:no-registry" };
    }
    
    // Get player info from session
    const caller = await resolveCallerSession(context, "leaveroom");
    if (!caller?.ok) {
      return { body: wrapSuccessData("<leave s='0'/>"), source: "leaveroom:bad-session" };
    }
    
    // Get rooms player was in before removing
    const affectedRooms = [];
    for (const room of raceRoomRegistry.list()) {
      if (room.players?.some(p => p.id === caller.playerId)) {
        affectedRooms.push(room.roomId);
      }
    }
    
    // Remove player from all rooms
    const removedFrom = raceRoomRegistry.removePlayerFromAllRooms(caller.playerId);
    
    return {
      body: wrapSuccessData(`<leave s='1' rooms='${removedFrom.length}'/>`),
      source: "generated:leaveroom",
    };
  },
  setready: async (context) => {
    // Set player ready status in race room
    const { params, services, supabase } = context;
      const raceManager = services?.raceManager;
    const ready = params.get("ready") === "1" || params.get("ready") === "true";
    const raceRoomRegistry = services?.raceRoomRegistry;
    const tcpNotify = services?.tcpNotify;
    
    if (!raceRoomRegistry) {
      return { body: wrapSuccessData("<ready s='0'/>"), source: "setready:no-registry" };
    }
    
    // Get player info from session
    const caller = await resolveCallerSession(context, "setready");
    if (!caller?.ok) {
      return { body: wrapSuccessData("<ready s='0'/>"), source: "setready:bad-session" };
    }
    
    // Find which room the player is in
    const room = raceRoomRegistry.getRoomByPlayer(caller.playerId);
    if (!room) {
      return { body: wrapSuccessData("<ready s='0' error='not_in_room'/>"), source: "setready:not-in-room" };
    }
    
    // Set ready status
    const result = raceRoomRegistry.setPlayerReady(room.roomId, caller.playerId, ready);
    if (!result.success) {
      return { body: wrapSuccessData(`<ready s='0' error='${result.error}'/>`), source: `setready:${result.error}` };
    }
    
    // Check if all players are ready and minimum players met
    const allReady = raceRoomRegistry.areAllPlayersReady(room.roomId);
    const minPlayers = 2; // Minimum players to start a race
    const canStart = allReady && result.room.players.length >= minPlayers;
    
    if (canStart) {
        const raceManager = services?.raceManager;
        if (!raceManager) {
          context.logger.warn("RaceManager not available, cannot start race.", { roomId: room.roomId });
          return { body: wrapSuccessData("<ready s='0' error='no_race_manager'/>"), source: "setready:no-race-manager" };
        }

        // Create a new race instance
        // For simplicity, let's assume a default trackId for now.
        // In a real scenario, the trackId would likely come from the room configuration or player input.
        const trackId = "default_track_01"; // Placeholder
        const newRace = raceManager.createRace(
          room.roomId,
          room.type,
          result.room.players,
          trackId
        );
        newRace.startRace(); // Set the race status to running

        context.logger.info("Race instance created and started", {
          raceId: newRace.id,
          roomId: room.roomId,
          playerCount: result.room.players.length,
        });

        // Update room status to "racing" and associate with the new race instance
        result.room.status = "racing";
        result.room.currentRaceId = newRace.id; // Store the race instance ID in the room
        raceRoomRegistry.upsert(room.roomId, result.room);

        // Notify players that race is starting, including the raceId
        if (tcpNotify) {
          // Assuming broadcastToRoom can handle additional data
          tcpNotify.broadcastToRoom(room.roomId, { ...result.room, raceId: newRace.id }, "race_starting");
        }
    }
    
    return {
      body: wrapSuccessData(`<ready s='1' ready='${ready ? 1 : 0}' canstart='${canStart ? 1 : 0}'/>`),
      source: "generated:setready",
    };
  },
};

export async function handleGameAction(context) {
  const { action, rawQuery, decodedQuery, logger } = context;
  const normalizedAction = String(action || "");
  const handler = handlers[normalizedAction] || handlers[normalizedAction.toLowerCase()];

  if (handler) {
    const result = await handler(context);
    if (result) {
      return result;
    }
  }

  logger.warn("No handler for action", { action, decodedQuery });
  return {
    body: `"s", 1`,
    source: "unimplemented:stub",
  };
}
