import {
  DEFAULT_COLOR_CODE,
  DEFAULT_OWNED_STOCK_WHEEL_XML,
  DEFAULT_PAINT_INDEX,
  DEFAULT_STARTER_CATALOG_CAR_ID,
  DEFAULT_STOCK_PARTS_XML,
  getDefaultPartsXmlForCar,
  getDefaultWheelXmlForCar,
  normalizeOwnedWheelXmlValue,
} from "./car-defaults.js";
import { normalizeOwnedPartsXmlValue } from "./parts-xml.js";

const TEST_DRIVE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_CLIENT_ROLE = 5;

function toNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toStringValue(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

function toNullableString(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function toBoolean(value, fallback = false) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalizedValue = String(value).trim().toLowerCase();
  if (normalizedValue === "true" || normalizedValue === "t" || normalizedValue === "1") {
    return true;
  }
  if (normalizedValue === "false" || normalizedValue === "f" || normalizedValue === "0") {
    return false;
  }
  return fallback;
}

function toTimestampString(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeCatalogCarIdValue(value) {
  const numericValue = toNumber(value, 0);
  if (numericValue === 101 || numericValue === 12) {
    return DEFAULT_STARTER_CATALOG_CAR_ID;
  }
  return numericValue;
}

function normalizeWheelXmlValue(value, catalogCarId = 0) {
  return normalizeOwnedWheelXmlValue(value, catalogCarId);
}

function hasForcedInductionSlot(partsXml) {
  return /<p[^>]*\b(?:ci|pi)=["'](?:81|87)["'][^>]*\/>/i.test(String(partsXml || ""));
}

function normalizePartsXmlValue(value, catalogCarId = 0) {
  const partsXml = String(value || "").trim();
  const normalizedFactoryPartsXml = normalizeOwnedPartsXmlValue(getDefaultPartsXmlForCar(catalogCarId));
  if (!partsXml) {
    return normalizedFactoryPartsXml;
  }

  const normalizedPartsXml = normalizeOwnedPartsXmlValue(partsXml);
  if (!normalizedFactoryPartsXml || hasForcedInductionSlot(normalizedPartsXml)) {
    return normalizedPartsXml;
  }

  return `${normalizedPartsXml}${normalizedFactoryPartsXml}`;
}

function deriveTestDriveState(record) {
  const invitationId = toNumber(record?.test_drive_invitation_id, 0);
  if (invitationId <= 0) {
    return null;
  }

  const expiresAt = toTimestampString(record?.test_drive_expires_at);
  const msRemaining = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0;
  const expired = !expiresAt || msRemaining <= 0;
  const hoursRemaining = expiresAt ? Math.max(0, Math.ceil(msRemaining / TEST_DRIVE_HOUR_MS)) : 0;

  return {
    active: 1,
    expired: expired ? 1 : 0,
    hoursRemaining,
  };
}

export function parsePlayerRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    username: toStringValue(record.username),
    password_hash: toStringValue(record.password_hash),
    money: toNumber(record.money, 50000),
    points: toNumber(record.points, 0),
    score: toNumber(record.score, 0),
    wins: toNumber(record.wins, 0),
    losses: toNumber(record.losses, 0),
    image_id: toNumber(record.image_id, 0),
    gender: toStringValue(record.gender, "m"),
    driver_text: toStringValue(record.driver_text),
    team_name: toStringValue(record.team_name),
    team_id: toNullableNumber(record.team_id),
    role: toNullableNumber(record.role) ?? toNullableString(record.role),
    active: toNumber(record.active, 1),
    vip: toNumber(record.vip, 0),
    facebook_connected: toNumber(record.facebook_connected, 0),
    alert_flag: toNumber(record.alert_flag, 0),
    blackcard_progress: toNumber(record.blackcard_progress, 0),
    sponsor_rating: toNumber(record.sponsor_rating, 0),
    respect_level: toNumber(record.respect_level, 1),
    message_badge: toNumber(record.message_badge, 0),
    client_role: toNumber(record.client_role, DEFAULT_CLIENT_ROLE),
    has_dyno: toNumber(record.has_dyno, 0),
    badges_json: record.badges_json ?? [],
    location_id: toNumber(record.location_id, 100),
    background_id: toNumber(record.background_id, 1),
    title_id: toNumber(record.title_id, 0),
    track_rank: toNumber(record.track_rank, 0),
    default_car_game_id: toNullableNumber(record.default_car_game_id),
    created_at: toTimestampString(record.created_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function buildPlayerInsert(input = {}) {
  const normalizedUsername = toStringValue(input.username).trim();
  const passwordHash = toStringValue(input.passwordHash || input.password_hash);
  if (!normalizedUsername || !passwordHash) {
    return null;
  }

  return {
    username: normalizedUsername,
    password_hash: passwordHash,
    gender: toStringValue(input.gender, "m"),
    image_id: toNumber(input.imageId ?? input.image_id, 0),
    money: toNumber(input.money, 50000),
    points: toNumber(input.points, 0),
    score: toNumber(input.score, 0),
    client_role: toNumber(input.clientRole ?? input.client_role, DEFAULT_CLIENT_ROLE),
  };
}

export function buildPlayerPatch(input = {}) {
  const patch = {};
  if ("money" in input) patch.money = toNumber(input.money, 0);
  if ("points" in input) patch.points = toNumber(input.points, 0);
  if ("backgroundId" in input || "background_id" in input) {
    patch.background_id = toNumber(input.backgroundId ?? input.background_id, 1);
  }
  if ("hasDyno" in input || "has_dyno" in input) {
    patch.has_dyno = toNumber(input.hasDyno ?? input.has_dyno, 0);
  }
  if ("defaultCarGameId" in input || "default_car_game_id" in input) {
    patch.default_car_game_id = toNullableNumber(input.defaultCarGameId ?? input.default_car_game_id);
  }
  if ("locationId" in input || "location_id" in input) {
    patch.location_id = toNullableNumber(input.locationId ?? input.location_id);
  }
  if ("teamId" in input || "team_id" in input) {
    patch.team_id = toNullableNumber(input.teamId ?? input.team_id);
  }
  if ("teamName" in input || "team_name" in input) {
    patch.team_name = toStringValue(input.teamName ?? input.team_name);
  }
  if ("score" in input) patch.score = toNumber(input.score, 0);
  if ("wins" in input) patch.wins = toNumber(input.wins, 0);
  if ("losses" in input) patch.losses = toNumber(input.losses, 0);
  return patch;
}

export function parseOwnedCarRecord(record) {
  if (!record) {
    return null;
  }

  const catalogCarId = normalizeCatalogCarIdValue(record.catalog_car_id);
  const testDriveState = deriveTestDriveState(record);

  return {
    ...record,
    game_car_id: toNumber(record.game_car_id, 0),
    account_car_id: toNullableNumber(record.account_car_id),
    player_id: toNumber(record.player_id, 0),
    catalog_car_id: catalogCarId,
    selected: toBoolean(record.selected, false),
    paint_index: toNumber(record.paint_index, DEFAULT_PAINT_INDEX),
    plate_name: toStringValue(record.plate_name),
    color_code: toStringValue(record.color_code, DEFAULT_COLOR_CODE),
    image_index: toNumber(record.image_index, 0),
    locked: toNumber(record.locked, 0),
    aero: toNumber(record.aero, 0),
    wheel_xml: normalizeWheelXmlValue(record.wheel_xml, catalogCarId),
    parts_xml: normalizePartsXmlValue(record.parts_xml, catalogCarId),
    test_drive_invitation_id: toNullableNumber(record.test_drive_invitation_id),
    test_drive_name: toNullableString(record.test_drive_name),
    test_drive_money_price: toNullableNumber(record.test_drive_money_price),
    test_drive_point_price: toNullableNumber(record.test_drive_point_price),
    test_drive_expires_at: toTimestampString(record.test_drive_expires_at),
    test_drive_active: testDriveState?.active,
    test_drive_expired: testDriveState?.expired,
    test_drive_hours_remaining: testDriveState?.hoursRemaining,
    created_at: toTimestampString(record.created_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function buildOwnedCarInsert(input = {}) {
  const playerId = toNumber(input.playerId ?? input.player_id, 0);
  const catalogCarId = normalizeCatalogCarIdValue(input.catalogCarId ?? input.catalog_car_id);
  if (!playerId || !catalogCarId) {
    return null;
  }

  const insert = {
    player_id: playerId,
    catalog_car_id: catalogCarId,
    selected: toBoolean(input.selected, false),
    paint_index: toNumber(input.paintIndex ?? input.paint_index, DEFAULT_PAINT_INDEX),
    plate_name: toStringValue(input.plateName ?? input.plate_name),
    color_code: toStringValue(input.colorCode ?? input.color_code, DEFAULT_COLOR_CODE),
    parts_xml: normalizePartsXmlValue(input.partsXml ?? input.parts_xml, catalogCarId),
    wheel_xml: normalizeWheelXmlValue(
      input.wheelXml ?? input.wheel_xml ?? DEFAULT_OWNED_STOCK_WHEEL_XML,
      catalogCarId,
    ),
  };

  if ("gameCarId" in input || "game_car_id" in input) {
    insert.game_car_id = toNumber(input.gameCarId ?? input.game_car_id, 0);
  }
  if ("testDriveInvitationId" in input || "test_drive_invitation_id" in input) {
    insert.test_drive_invitation_id = toNullableNumber(input.testDriveInvitationId ?? input.test_drive_invitation_id);
    insert.test_drive_name = toStringValue(input.testDriveName ?? input.test_drive_name);
    insert.test_drive_money_price = toNumber(input.testDriveMoneyPrice ?? input.test_drive_money_price, 0);
    insert.test_drive_point_price = toNumber(input.testDrivePointPrice ?? input.test_drive_point_price, 0);
    insert.test_drive_expires_at = toTimestampString(input.testDriveExpiresAt ?? input.test_drive_expires_at);
  }

  return insert;
}

export function buildOwnedCarPatch(input = {}) {
  const patch = {};
  if ("catalogCarId" in input || "catalog_car_id" in input) {
    patch.catalog_car_id = normalizeCatalogCarIdValue(input.catalogCarId ?? input.catalog_car_id);
  }
  if ("selected" in input) patch.selected = toBoolean(input.selected, false);
  if ("paintIndex" in input || "paint_index" in input) {
    patch.paint_index = toNumber(input.paintIndex ?? input.paint_index, DEFAULT_PAINT_INDEX);
  }
  if ("plateName" in input || "plate_name" in input) {
    patch.plate_name = toStringValue(input.plateName ?? input.plate_name);
  }
  if ("colorCode" in input || "color_code" in input) {
    patch.color_code = toStringValue(input.colorCode ?? input.color_code, DEFAULT_COLOR_CODE);
  }
  if ("partsXml" in input || "parts_xml" in input) {
    patch.parts_xml = normalizeOwnedPartsXmlValue(input.partsXml ?? input.parts_xml);
  }
  if ("wheelXml" in input || "wheel_xml" in input) {
    patch.wheel_xml = normalizeOwnedWheelXmlValue(input.wheelXml ?? input.wheel_xml);
  }
  if ("testDriveInvitationId" in input || "test_drive_invitation_id" in input) {
    patch.test_drive_invitation_id = toNullableNumber(input.testDriveInvitationId ?? input.test_drive_invitation_id);
  }
  if ("testDriveName" in input || "test_drive_name" in input) {
    patch.test_drive_name = toNullableString(input.testDriveName ?? input.test_drive_name);
  }
  if ("testDriveMoneyPrice" in input || "test_drive_money_price" in input) {
    patch.test_drive_money_price = toNullableNumber(input.testDriveMoneyPrice ?? input.test_drive_money_price);
  }
  if ("testDrivePointPrice" in input || "test_drive_point_price" in input) {
    patch.test_drive_point_price = toNullableNumber(input.testDrivePointPrice ?? input.test_drive_point_price);
  }
  if ("testDriveExpiresAt" in input || "test_drive_expires_at" in input) {
    patch.test_drive_expires_at = toTimestampString(input.testDriveExpiresAt ?? input.test_drive_expires_at);
  }
  return patch;
}

export function parsePartsInventoryRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    player_id: toNumber(record.player_id, 0),
    part_catalog_id: toNumber(record.part_catalog_id, 0),
    quantity: toNumber(record.quantity, 1),
    acquired_at: toTimestampString(record.acquired_at),
  };
}

export function buildPartsInventoryInsert(input = {}) {
  return {
    player_id: toNumber(input.playerId ?? input.player_id, 0),
    part_catalog_id: toNumber(input.partCatalogId ?? input.part_catalog_id, 0),
    quantity: Math.max(1, toNumber(input.quantity, 1)),
  };
}

export function buildPartsInventoryPatch(input = {}) {
  const patch = {};
  if ("quantity" in input) {
    patch.quantity = Math.max(0, toNumber(input.quantity, 0));
  }
  return patch;
}

export function parseSessionRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    session_key: toStringValue(record.session_key),
    player_id: toNumber(record.player_id, 0),
    created_at: toTimestampString(record.created_at),
    last_seen_at: toTimestampString(record.last_seen_at),
  };
}

export function buildSessionInsert(input = {}) {
  const sessionKey = toStringValue(input.sessionKey ?? input.session_key);
  const playerId = toNumber(input.playerId ?? input.player_id, 0);
  if (!sessionKey || !playerId) {
    return null;
  }

  return {
    session_key: sessionKey,
    player_id: playerId,
  };
}

export function buildSessionPatch(input = {}) {
  const patch = {};
  if ("lastSeenAt" in input || "last_seen_at" in input) {
    patch.last_seen_at = toTimestampString(input.lastSeenAt ?? input.last_seen_at);
  }
  return patch;
}

export function parseTeamRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    name: toStringValue(record.name),
    score: toNumber(record.score, 0),
    team_fund: toNumber(record.team_fund, 0),
    wins: toNumber(record.wins, 0),
    losses: toNumber(record.losses, 0),
    owner_player_id: toNullableNumber(record.owner_player_id),
    background_color: toStringValue(record.background_color, "7D7D7D"),
    location_code: toStringValue(record.location_code),
    recruitment_type: toStringValue(record.recruitment_type, "open"),
    vip: toNumber(record.vip, 0),
    created_at: toTimestampString(record.created_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function buildTeamInsert(input = {}) {
  const name = toStringValue(input.name).trim();
  if (!name) {
    return null;
  }

  const insert = {
    name,
    score: toNumber(input.score, 0),
    team_fund: toNumber(input.teamFund ?? input.team_fund, 0),
    background_color: toStringValue(input.backgroundColor ?? input.background_color, "7D7D7D"),
    location_code: toStringValue(input.locationCode ?? input.location_code),
    recruitment_type: toStringValue(input.recruitmentType ?? input.recruitment_type, "open"),
    vip: toNumber(input.vip, 0),
  };

  if ("ownerPlayerId" in input || "owner_player_id" in input) {
    insert.owner_player_id = toNullableNumber(input.ownerPlayerId ?? input.owner_player_id);
  }

  return insert;
}

export function buildTeamPatch(input = {}) {
  const patch = {};
  if ("name" in input) patch.name = toStringValue(input.name).trim();
  if ("score" in input) patch.score = toNumber(input.score, 0);
  if ("teamFund" in input || "team_fund" in input) {
    patch.team_fund = toNumber(input.teamFund ?? input.team_fund, 0);
  }
  if ("wins" in input) patch.wins = toNumber(input.wins, 0);
  if ("losses" in input) patch.losses = toNumber(input.losses, 0);
  if ("ownerPlayerId" in input || "owner_player_id" in input) {
    patch.owner_player_id = toNullableNumber(input.ownerPlayerId ?? input.owner_player_id);
  }
  if ("backgroundColor" in input || "background_color" in input) {
    patch.background_color = toStringValue(input.backgroundColor ?? input.background_color, "7D7D7D");
  }
  if ("locationCode" in input || "location_code" in input) {
    patch.location_code = toStringValue(input.locationCode ?? input.location_code);
  }
  if ("recruitmentType" in input || "recruitment_type" in input) {
    patch.recruitment_type = toStringValue(input.recruitmentType ?? input.recruitment_type, "open");
  }
  if ("vip" in input) patch.vip = toNumber(input.vip, 0);
  return patch;
}

export function parseTeamMemberRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    team_id: toNumber(record.team_id, 0),
    player_id: toNumber(record.player_id, 0),
    contribution_score: toNumber(record.contribution_score, 0),
    role: toStringValue(record.role),
    joined_at: toTimestampString(record.joined_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function buildTeamMemberInsert(input = {}) {
  const rawRole = toStringValue(input.role, "member").trim().toLowerCase();
  const role = rawRole === "owner" || rawRole === "admin" ? rawRole : "member";

  return {
    team_id: toNumber(input.teamId ?? input.team_id, 0),
    player_id: toNumber(input.playerId ?? input.player_id, 0),
    role,
  };
}

export function buildClearedTestDrivePatch() {
  return {
    test_drive_invitation_id: null,
    test_drive_name: null,
    test_drive_money_price: null,
    test_drive_point_price: null,
    test_drive_expires_at: null,
  };
}

export function parseMailRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    sender_player_id: toNullableNumber(record.sender_player_id),
    recipient_player_id: toNullableNumber(record.recipient_player_id),
    subject: toStringValue(record.subject),
    body: toStringValue(record.body),
    folder: toStringValue(record.folder, "inbox"),
    is_read: toBoolean(record.is_read, false),
    is_deleted: toBoolean(record.is_deleted, false),
    attachment_money: toNumber(record.attachment_money, 0),
    attachment_points: toNumber(record.attachment_points, 0),
    created_at: toTimestampString(record.created_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function parseRemarkRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    id: toNumber(record.id, 0),
    target_player_id: toNullableNumber(record.target_player_id),
    author_player_id: toNullableNumber(record.author_player_id),
    body: toStringValue(record.body),
    is_deleted: toBoolean(record.is_deleted, false),
    created_at: toTimestampString(record.created_at),
    updated_at: toTimestampString(record.updated_at),
  };
}

export function parseTransactionRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    player_id: toNumber(record.player_id, 0),
    money_change: toNumber(record.money_change, 0),
    points_change: toNumber(record.points_change, 0),
    created_at: toTimestampString(record.created_at),
  };
}

export function parseRaceHistoryRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    player_id: toNumber(record.player_id, 0),
    race_type: toStringValue(record.race_type),
    won: toBoolean(record.won, false),
    time_ms: toNumber(record.time_ms, 0),
    car_id: toNumber(record.car_id, 0),
    raced_at: toTimestampString(record.raced_at),
  };
}

export function parseRaceLogRecord(record) {
  if (!record) {
    return null;
  }

  return {
    ...record,
    player_1_id: toNumber(record.player_1_id, 0),
    player_2_id: toNumber(record.player_2_id, 0),
    winner_id: toNumber(record.winner_id, 0),
    player_1_time: toNumber(record.player_1_time, 0),
    player_2_time: toNumber(record.player_2_time, 0),
    created_at: toTimestampString(record.created_at),
  };
}
