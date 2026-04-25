import { RaceManager } from "./race-manager.js";
import { buildLoginBody } from "./login-payload.js";
import { PARTS_CATALOG_XML, PARTS_CATEGORIES_BODY } from "./parts-catalog.js";
import { PAINT_CATS_FOR_LOC, getPaintColorsForLocation, getPaintIdForColorCode } from "./paint-catalog-source.js";
import { buildWheelsTiresCatalogXml } from "./wheels-catalog.js";
import { buildStaticCarsXml, FULL_CAR_CATALOG, getCatalogCarPrice } from "./car-catalog.js";
import { randomUUID, createHash } from "node:crypto";
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
  handleUninstallPart as handleUninstallPartImpl,
} from "./game-actions/parts.js";
import {
  escapeXml,
  failureBody,
  renderOwnedGarageCar,
  renderOwnedGarageCarsWithTournamentLanePlaceholder,
  renderOwnedGarageCarsWrapper,
  renderRacerCars,
  renderShowroomCarBody,
  renderTeams,
  renderTwoRacerCars,
  renderUserSummaries,
  renderUserSummary,
  wrapSuccessData,
} from "./game-xml.js";
import { buildCarRaceSpec, getRedLine, simulateRun } from "./engine-physics.js";
import { hashGamePassword, normalizeUsername, verifyGamePassword } from "./player-identity.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { createLoginSession, getSessionPlayerId, validateOrCreateSession } from "./session.js";
import { consumeRecentDecalUpload } from "./upload-state.js";
import {
  getBoostTypeForCar,
  getCarEngineIdentity,
  getEffectiveEngineString,
  getEngineTypeIdForCatalogCar,
  getEngineTypeIdForCar,
} from "./car-engine-state.js";
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
  updateTeamMemberContribution,
  updatePlayerRecord,
  updatePlayerDefaultCar,
  updatePlayerMoney,
  updatePlayerLocation,
  getCarById,
  deleteCar,
  clearCarTestDriveState,
  listPartsInventoryForPlayer,
  getPartInventoryItemById,
  addPartInventoryItem,
  consumePartInventoryItem,
  createOwnedEngine,
  getOwnedEngineById,
  updateOwnedEngineRecord,
  deleteOwnedEngine,
} from "./user-service.js";
import { getDefaultPartsXmlForCar, getDefaultWheelFitmentForCar, getDefaultWheelXmlForCar } from "./car-defaults.js";
import { getShowroomCarSpec, hasShowroomCarSpec } from "./showroom-car-specs.js";

const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
const DEFAULT_STOCK_PARTS_XML = "";
const TEST_DRIVE_DURATION_HOURS = 12;
const DEFAULT_DYNO_PURCHASE_STATE = Object.freeze({
  boostSetting: 5,
  maxPsi: 10,
  chipSetting: 0,
  shiftLightRpm: 7200,
  redLine: 7800,
});
const DYNO_TUNE_CARRIER_SLOT_IDS = ["23", "2005", "2006", "174", "134", "26", "22", "2013"];
const BOOST_CONTROLLER_SLOT_IDS = ["23", "2005"];
const AFR_CONTROLLER_SLOT_IDS = ["2006", "174", "134"];
const SHIFT_LIGHT_SLOT_IDS = ["26"];
const GEAR_TUNE_SLOT_IDS = ["22", "2013"];
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
const STATIC_LOCATIONS_ACTION_XML =
  "<n id='locations'>" +
  "<loc lid='100' ln='Toreno' f='0' pf='0' r='0' ps='3' sc='0'/>" +
  "<loc lid='200' ln='Newburge' f='10000' pf='100' r='500' ps='5' sc='500'/>" +
  "<loc lid='300' ln='Creek Side' f='50000' pf='500' r='2000' ps='8' sc='2000'/>" +
  "<loc lid='400' ln='Vista Heights' f='150000' pf='1500' r='5000' ps='12' sc='5000'/>" +
  "<loc lid='500' ln='Diamond Point' f='500000' pf='5000' r='10000' ps='20' sc='10000'/>" +
  "</n>";

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

function normalizeUserGraphicFileExt(value, fallback = "png") {
  const normalized = String(value || "").trim().toLowerCase().replace(/^\./, "");
  if (["jpg", "jpeg", "png", "gif"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractInfoXmlFromLoginBody(body) {
  const match = String(body || "").match(/"d", "([\s\S]*)", "aid", /);
  return match?.[1] || "<ini></ini>";
}

function logTournamentPayload(logger, label, payload, meta = {}) {
  logger?.info(`${label} payload`, {
    ...meta,
    payloadLength: String(payload || "").length,
    payload,
  });
}

function removeInstalledPartByAi(partsXml, installId) {
  const source = String(partsXml || "");
  const escapedInstallId = String(installId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`<p[^>]*\\bai=['"]${escapedInstallId}['"][^>]*/>`, "g"), "");
}

function findInstalledPartByAi(partsXml, installId) {
  const entries = collectInstalledPartEntries(partsXml);
  return entries.find((entry) => String(entry?.attrs?.ai || "") === String(installId || "")) || null;
}

function buildRepairPartsXml(car) {
  const entries = collectInstalledPartEntries(car?.parts_xml || "");
  const repairNodes = [];

  for (const entry of entries) {
    const attrs = entry.attrs || {};
    const partId = Number(attrs.i || 0);
    const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
    if (!catalogPart) {
      continue;
    }

    const slotId = Number(attrs.pi || attrs.ci || 0);
    const isConsumable = slotId === 102 || slotId === 165 || slotId === 168 || slotId === 169;
    const damageValue = isConsumable ? 65 : 35;
    const basePrice = Math.max(50, Math.round(Number(catalogPart.p || 0) * (isConsumable ? 0.35 : 0.25)));
    const pointPrice = Math.max(1, Math.round(Number(catalogPart.pp || 0) * (isConsumable ? 0.35 : 0.25)));

    repairNodes.push(
      `<p i='${escapeXml(String(attrs.ai || createInstalledPartId()))}' ` +
      `ci='${slotId || partId}' n='${escapeXml(catalogPart.n || attrs.n || "Part")}' ` +
      `d='${damageValue}' p='${basePrice}' pp='${pointPrice}'/>`
    );
  }

  return `<parts p='1' v='1'>${repairNodes.join("")}</parts>`;
}

function isEngineOwnedCatalogPart(catalogPart) {
  const type = String(catalogPart?.t || "");
  return type === "e" || type === "m";
}

function collectInstalledEngineEntries(partsXml) {
  return collectInstalledPartEntries(partsXml).filter((entry) => {
    const partId = Number(entry?.attrs?.i || 0);
    const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
    return isEngineOwnedCatalogPart(catalogPart);
  });
}

function buildInstalledEnginePartsXml(car) {
  const partsXml = collectInstalledEngineEntries(car?.parts_xml || "")
    .map((entry) => {
      const attrs = entry.attrs || {};
      const partId = Number(attrs.i || 0);
      const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
      if (!catalogPart) {
        return "";
      }
      return buildInstalledCatalogPartXml(catalogPart, attrs.ai || createInstalledPartId(), {
        i: attrs.i,
        pi: attrs.pi ?? attrs.ci ?? catalogPart.pi ?? "",
        t: catalogPart.t,
        n: attrs.n ?? catalogPart.n ?? "",
        p: attrs.p ?? catalogPart.p ?? "0",
        pp: attrs.pp ?? catalogPart.pp ?? "0",
        g: attrs.g ?? catalogPart.g ?? "",
        di: attrs.di ?? catalogPart.di ?? "",
        pdi: attrs.pdi ?? attrs.di ?? catalogPart.pdi ?? catalogPart.di ?? "",
        b: attrs.b ?? catalogPart.b ?? "",
        bn: attrs.bn ?? catalogPart.bn ?? "",
        mn: attrs.mn ?? catalogPart.mn ?? "",
        l: attrs.l ?? catalogPart.l ?? "100",
        in: "1",
        mo: attrs.mo ?? catalogPart.mo ?? "0",
        hp: attrs.hp ?? catalogPart.hp ?? "0",
        tq: attrs.tq ?? catalogPart.tq ?? "0",
        wt: attrs.wt ?? catalogPart.wt ?? "0",
        cc: attrs.cc ?? catalogPart.cc ?? "",
        ps: attrs.ps ?? catalogPart.ps ?? "",
      });
    })
    .filter(Boolean)
    .join("");
  return `<n2>${partsXml}</n2>`;
}

function buildEngineSwapXml(car) {
  const groups = new Map();
  for (const entry of collectInstalledEngineEntries(car?.parts_xml || "")) {
    const attrs = entry.attrs || {};
    const partId = Number(attrs.i || 0);
    const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
    if (!catalogPart) {
      continue;
    }
    const slotId = String(attrs.pi || attrs.ci || catalogPart.pi || "");
    const bucket = groups.get(slotId) || {
      slotId,
      name: catalogPart.mn || catalogPart.bn || catalogPart.n || `Slot ${slotId}`,
      parts: [],
    };
    bucket.parts.push(
      `<p ai='${escapeXml(String(attrs.ai || createInstalledPartId()))}' ` +
      `i='${partId}' n='${escapeXml(catalogPart.n || attrs.n || "Part")}'/>`
    );
    groups.set(slotId, bucket);
  }

  const categoriesXml = [...groups.values()]
    .map((group) => `<c i='${escapeXml(group.slotId)}' n='${escapeXml(group.name)}'>${group.parts.join("")}</c>`)
    .join("");
  return `<n2>${categoriesXml}</n2>`;
}

function replaceInstalledEngineEntries(partsXml, nextEngineEntries) {
  const nonEngineEntries = collectInstalledPartEntries(partsXml)
    .filter((entry) => {
      const partId = Number(entry?.attrs?.i || 0);
      const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
      return !isEngineOwnedCatalogPart(catalogPart);
    })
    .map((entry) => entry.raw)
    .join("");
  return `${nonEngineEntries}${nextEngineEntries.join("")}`;
}

async function resolveOwnedEngineCar(context, aeid) {
  const { supabase } = context;
  const caller = await resolveCallerSession(context, "supabase:engine-car");
  if (!caller?.ok) {
    return { caller, car: null, engine: null };
  }

  const cars = await listCarsForPlayer(supabase, caller.playerId);
  const target = cars.find((car) => Number(getCarEngineIdentity(car).ae) === Number(aeid || 0))
    || cars.find((car) => Number(car.game_car_id) === Number(aeid || 0))
    || null;
  const engine = target
    ? await getOwnedEngineById(supabase, Number(target.owned_engine_id || target.installed_engine_id || aeid || 0), caller.playerId)
    : await getOwnedEngineById(supabase, Number(aeid || 0), caller.playerId);
  const resolvedCar = target
    || (engine?.installed_on_car_id ? (cars.find((car) => Number(car.game_car_id) === Number(engine.installed_on_car_id)) || null) : null);
  return { caller, car: resolvedCar, engine };
}

async function handleGetInstalledEnginePartByAccountCar(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 1, "d", "<n2></n2>"`, source: "generated:getinstalledenginepartbyaccountcar:no-supabase" };
  }

  const { caller, engine } = await resolveOwnedEngineCar(context, params.get("aeid") || params.get("acid") || 0);
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getinstalledenginepartbyaccountcar:bad-session" };
  }

  return {
    body: `"s", 1, "d", "${buildInstalledEnginePartsXml(engine)}"`,
    source: engine ? "supabase:getinstalledenginepartbyaccountcar" : "supabase:getinstalledenginepartbyaccountcar:no-car",
  };
}

async function handleInstallEnginePart(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: wrapSuccessData(`<r s='-1' b='0'/>`), source: "generated:installenginepart:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:installenginepart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:installenginepart:bad-session" };
  }

  const inventoryId = Number(params.get("aepid") || 0);
  const partId = Number(params.get("epid") || 0);
  const carId = Number(params.get("acid") || 0);
  const [inventoryItem, car] = await Promise.all([
    getPartInventoryItemById(supabase, inventoryId, caller.playerId),
    getCarById(supabase, carId),
  ]);

  if (!inventoryItem || Number(inventoryItem.part_catalog_id || 0) !== partId) {
    return { body: wrapSuccessData(`<r s='-1' b='0'/>`), source: "supabase:installenginepart:no-inventory-part" };
  }
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: wrapSuccessData(`<r s='-4' b='0'/>`), source: "supabase:installenginepart:no-car" };
  }
  const engine = await getOwnedEngineById(supabase, Number(car.owned_engine_id || car.installed_engine_id || 0), caller.playerId);
  if (!engine) {
    return { body: wrapSuccessData(`<r s='-4' b='0'/>`), source: "supabase:installenginepart:no-engine" };
  }

  const catalogPart = getPartsCatalogById().get(partId);
  if (!catalogPart || !isEngineOwnedCatalogPart(catalogPart)) {
    return { body: wrapSuccessData(`<r s='-1' b='0'/>`), source: "supabase:installenginepart:no-catalog-part" };
  }

  const slotId = String(catalogPart.pi || "");
  const existingPart = findInstalledPartBySlotId(engine.parts_xml || "", slotId);
  if (Number(existingPart?.i || 0) === partId) {
    return { body: wrapSuccessData(`<r s='0' b='0'/>`), source: "supabase:installenginepart:already-installed" };
  }

  if (existingPart?.i) {
    await addPartInventoryItem(supabase, caller.playerId, Number(existingPart.i), 1);
  }

  const installedPartXml = buildInstalledCatalogPartXml(catalogPart, createInstalledPartId(), { in: "1" });
  const nextPartsXml = upsertInstalledPartXml(engine.parts_xml || "", slotId, installedPartXml);
  await updateOwnedEngineRecord(supabase, engine.id, {
    partsXml: nextPartsXml,
    engineTypeId: getEngineTypeIdForCar({ catalog_car_id: car.catalog_car_id, parts_xml: nextPartsXml }),
  });
  await consumePartInventoryItem(supabase, inventoryId, caller.playerId);

  return {
    body: wrapSuccessData(`<r s='1' b='0'/>`),
    source: "supabase:installenginepart",
  };
}

async function handleUninstallEnginePart(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: wrapSuccessData(`<r s='0'/>`), source: "generated:uninstallenginepart:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:uninstallenginepart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:uninstallenginepart:bad-session" };
  }

  const uninstallIds = String(params.get("aepids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const engineId = Number(params.get("aeid") || 0);
  const { car, engine } = await resolveOwnedEngineCar(context, engineId);
  if (!car || !engine || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: wrapSuccessData(`<r s='0'/>`), source: "supabase:uninstallenginepart:no-car" };
  }

  let nextPartsXml = String(engine.parts_xml || "");
  let removed = 0;
  for (const installId of uninstallIds) {
    const entry = findInstalledPartByAi(nextPartsXml, installId);
    const partId = Number(entry?.attrs?.i || 0);
    const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
    if (!entry || !isEngineOwnedCatalogPart(catalogPart)) {
      continue;
    }
    await addPartInventoryItem(supabase, caller.playerId, partId, 1);
    nextPartsXml = removeInstalledPartByAi(nextPartsXml, installId);
    removed += 1;
  }
  if (removed > 0) {
    await updateOwnedEngineRecord(supabase, engine.id, {
      partsXml: nextPartsXml,
      engineTypeId: getEngineTypeIdForCar({ catalog_car_id: car.catalog_car_id, parts_xml: nextPartsXml }),
    });
    return { body: wrapSuccessData(`<r s='1'/>`), source: "supabase:uninstallenginepart" };
  }
  return { body: wrapSuccessData(`<r s='0'/>`), source: "supabase:uninstallenginepart:no-op" };
}

async function handleSellEnginePart(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", -1, "b", 0`, source: "generated:sellenginepart:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:sellenginepart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:sellenginepart:bad-session" };
  }

  const inventoryId = Number(params.get("aepid") || 0);
  const inventoryItem = await getPartInventoryItemById(supabase, inventoryId, caller.playerId);
  let partId = Number(inventoryItem?.part_catalog_id || 0);
  let consumeInventory = Boolean(inventoryItem);
  let installedEngine = null;

  if (!partId && inventoryId > 0) {
    const cars = await listCarsForPlayer(supabase, caller.playerId);
    for (const car of cars) {
      const engine = await getOwnedEngineById(supabase, Number(car.owned_engine_id || car.installed_engine_id || 0), caller.playerId);
      const entry = findInstalledPartByAi(engine?.parts_xml || "", inventoryId);
      if (entry) {
        partId = Number(entry.attrs?.i || 0);
        consumeInventory = false;
        installedEngine = engine;
        break;
      }
    }
  }

  const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
  if (!catalogPart || !isEngineOwnedCatalogPart(catalogPart)) {
    return { body: `"s", -1, "b", 0`, source: "supabase:sellenginepart:not-found" };
  }

  const player = await getPlayerById(supabase, caller.playerId);
  const sellValue = Math.max(1, Math.round(Number(catalogPart.p || 0) * 0.5));
  const newBalance = toFiniteNumber(player?.money, 0) + sellValue;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  if (consumeInventory) {
    await consumePartInventoryItem(supabase, inventoryId, caller.playerId);
  } else if (installedEngine) {
    const nextPartsXml = removeInstalledPartByAi(installedEngine.parts_xml || "", inventoryId);
    await updateOwnedEngineRecord(
      supabase,
      installedEngine.id,
      {
        partsXml: nextPartsXml,
        engineTypeId: getEngineTypeIdForCar({ parts_xml: nextPartsXml }),
      },
    );
  }

  return {
    body: `"s", 1, "b", ${newBalance}`,
    source: "supabase:sellenginepart",
  };
}

async function handleSellEngine(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", -1, "b", 0`, source: "generated:sellengine:no-supabase" };
  }

  const { caller, engine } = await resolveOwnedEngineCar(context, params.get("aeid") || 0);
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:sellengine:bad-session" };
  }
  if (!engine) {
    return { body: `"s", -1, "b", 0`, source: "supabase:sellengine:not-found" };
  }

  const engineMarker = collectInstalledEngineEntries(engine.parts_xml || "").find((entry) => {
    const partId = Number(entry?.attrs?.i || 0);
    const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
    return String(catalogPart?.t || "") === "m";
  });

  if (!engineMarker) {
    return { body: `"s", 0, "b", 0`, source: "supabase:sellengine:no-engine-marker" };
  }

  const partId = Number(engineMarker.attrs?.i || 0);
  const catalogPart = getPartsCatalogById().get(partId);
  const sellValue = Math.max(1, Math.round(Number(catalogPart?.p || 0) * 0.5));
  const player = await getPlayerById(supabase, caller.playerId);
  const newBalance = toFiniteNumber(player?.money, 0) + sellValue;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  await deleteOwnedEngine(supabase, engine.id, caller.playerId);

  return {
    body: `"s", 1, "b", ${newBalance}`,
    source: "supabase:sellengine",
  };
}

async function handleBuyEngine(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: failureBody(), source: "generated:buyengine:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:buyengine");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:buyengine:bad-session" };
  }

  const carId = Number(params.get("acid") || 0);
  const engineCatalogId = Number(params.get("eid") || 0);
  const car = await getCarById(supabase, carId);
  const player = await getPlayerById(supabase, caller.playerId);
  const catalogPart = getPartsCatalogById().get(engineCatalogId);
  if (!car || Number(car.player_id) !== Number(caller.playerId) || !catalogPart || String(catalogPart.t || "") !== "m") {
    return { body: failureBody(), source: "supabase:buyengine:invalid-request" };
  }

  const price = Number(catalogPart.p || 0);
  const currentPointsBalance = toFiniteNumber(player?.points, 0);
  const newBalance = toFiniteNumber(player?.money, 0) - price;
  if (newBalance < 0) {
    return {
      body: `"s", 0, "d1", "<r s='-3' b='${toFiniteNumber(player?.money, 0)}' ai='0'/>", "d", "<r s='0' b='${currentPointsBalance}'/>"`,
      source: "supabase:buyengine:insufficient-funds",
    };
  }
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  const installId = createInstalledPartId();
  const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId, { in: "1" });
  const currentEngineId = Number(car.owned_engine_id || car.installed_engine_id || 0);
  if (currentEngineId > 0) {
    await updateOwnedEngineRecord(supabase, currentEngineId, { installedOnCarId: null });
  }
  await createOwnedEngine(supabase, {
    playerId: caller.playerId,
    installedOnCarId: carId,
    catalogEnginePartId: engineCatalogId,
    engineTypeId: getEngineTypeIdForCar(car),
    partsXml: installedPartXml,
  });
  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${installId}'/>", "d", "<r s='1' b='${currentPointsBalance}'></r>"`,
    source: "supabase:buyengine",
  };
}

async function handleSwapEngine(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: wrapSuccessData(`<r s='0' b='0'/>`), source: "generated:swapengine:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:swapengine");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:swapengine:bad-session" };
  }

  const targetCarId = Number(params.get("acid") || 0);
  const donorEngineId = Number(params.get("aeid") || 0);
  const [targetCar] = await Promise.all([getCarById(supabase, targetCarId)]);
  const donorEngine = await getOwnedEngineById(supabase, donorEngineId, caller.playerId);

  if (!targetCar || Number(targetCar.player_id) !== Number(caller.playerId)) {
    return { body: wrapSuccessData(`<r s='-1' b='0'/>`), source: "supabase:swapengine:no-target-car" };
  }
  if (!donorEngine) {
    return { body: wrapSuccessData(`<r s='0' b='0'/>`), source: "supabase:swapengine:no-donor-engine" };
  }

  const targetEngineId = Number(targetCar.owned_engine_id || targetCar.installed_engine_id || 0);
  const targetEngine = targetEngineId ? await getOwnedEngineById(supabase, targetEngineId, caller.playerId) : null;
  const donorInstalledCarId = Number(donorEngine.installed_on_car_id || 0) || null;
  await updateOwnedEngineRecord(supabase, donorEngine.id, { installedOnCarId: targetCar.game_car_id });
  if (targetEngine) {
    await updateOwnedEngineRecord(supabase, targetEngine.id, { installedOnCarId: donorInstalledCarId });
  }

  return {
    body: wrapSuccessData(`<r s='1' b='0'/>`),
    source: "supabase:swapengine",
  };
}

async function handleEngineGetAllParts(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: wrapSuccessData("<p></p>"), source: "generated:egep:no-supabase" };
  }

  const { caller, engine } = await resolveOwnedEngineCar(context, params.get("aeid") || 0);
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:egep:bad-session" };
  }

  const enginePartsXml = PARTS_CATALOG_XML.replace(/<p>([\s\S]*)<\/p>/, (_match, inner) => {
    const engineParts = [...inner.matchAll(/<p\b([^>]*)\/>/g)]
      .map((partMatch) => `<p${partMatch[1]}/>`)
      .filter((rawPart) => {
        const attrs = parsePartXmlAttributes(rawPart);
        const catalogPart = getPartsCatalogById().get(Number(attrs.i || 0));
        return isEngineOwnedCatalogPart(catalogPart);
      })
      .join("");
    return `<p>${engineParts}</p>`;
  });

  return {
    body: wrapSuccessData(enginePartsXml),
    source: engine ? "supabase:egep" : "supabase:egep:no-car",
  };
}

async function handleEngineSwapStart(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 0, "d", "<n2></n2>"`, source: "generated:esst:no-supabase" };
  }

  const { caller, engine } = await resolveOwnedEngineCar(context, params.get("aeid") || 0);
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:esst:bad-session" };
  }

  return {
    body: `"s", ${engine ? 1 : 0}, "d", "${engine ? buildEngineSwapXml(engine) : "<n2></n2>"}"`,
    source: engine ? "supabase:esst" : "supabase:esst:no-car",
  };
}

async function handleEngineSwapFinish(context) {
  const result = await handleSwapEngine(context);
  const success = String(result?.source || "").includes("supabase:swapengine") && !String(result?.source || "").includes("no-");
  return {
    body: `"s", ${success ? 1 : 0}`,
    source: success ? "supabase:esfi" : "supabase:esfi:failed",
  };
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

function listInstalledPartEntries(partsXml) {
  const entries = [];
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(String(partsXml || ""))) !== null) {
    entries.push({
      raw: match[0],
      attrs: parsePartXmlAttributes(match[0]),
    });
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return entries;
}

function collectInstalledPartEntries(partsXml) {
  return listInstalledPartEntries(partsXml);
}

function serializePartXmlAttributes(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}='${escapeXml(String(value))}'`)
    .join(" ");
}

function replaceInstalledPartEntry(partsXml, originalRaw, nextAttrs) {
  return String(partsXml || "").replace(originalRaw, `<p ${serializePartXmlAttributes(nextAttrs)}/>`); 
}

function findInstalledPartEntryBySlots(partsXml, slotIds = []) {
  const allowedSlots = new Set(slotIds.map((slotId) => String(slotId)));
  return listInstalledPartEntries(partsXml).find(({ attrs }) => {
    const slotId = String(attrs.ci || attrs.pi || "");
    return allowedSlots.has(slotId);
  }) || null;
}

function findTuneCarrierPartEntry(partsXml, preferredSlotIds = DYNO_TUNE_CARRIER_SLOT_IDS) {
  return findInstalledPartEntryBySlots(partsXml, preferredSlotIds) || listInstalledPartEntries(partsXml)[0] || null;
}

function readNumericPartAttr(attrs, key, fallback) {
  const numericValue = Number(attrs?.[key]);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

async function recoverPlayerLoginBalances(supabase, player, logger) {
  if (!player || (player._money_valid !== false && player._points_valid !== false)) {
    return player;
  }

  let transactions = [];
  try {
    const { data, error } = await supabase
      .from("game_transactions")
      .select("money_change, points_change")
      .eq("player_id", Number(player.id));

    if (error) {
      throw error;
    }

    transactions = Array.isArray(data) ? data : [];
  } catch (error) {
    logger?.warn?.("Unable to recover invalid player balance from transactions", {
      playerId: player.id,
      error: error?.message || String(error),
    });
  }

  let recoveredMoney = 0;
  let recoveredPoints = 0;
  if (transactions.length > 0) {
    recoveredMoney = 50000;
    for (const row of transactions) {
      recoveredMoney += toFiniteNumber(row?.money_change, 0);
      recoveredPoints += toFiniteNumber(row?.points_change, 0);
    }
  }

  return {
    ...player,
    money: player._money_valid === false ? recoveredMoney : toFiniteNumber(player.money, 0),
    points: player._points_valid === false ? recoveredPoints : toFiniteNumber(player.points, 0),
  };
}

function getPersistedDynoState(car) {
  const catalogCarId = String(car?.catalog_car_id || "");
  const engineTypeId = getEngineTypeIdForCar(car);
  const derivedRedLine = catalogCarId && hasShowroomCarSpec(catalogCarId)
    ? getCarRedLine(catalogCarId, engineTypeId)
    : DEFAULT_DYNO_PURCHASE_STATE.redLine;
  const carrier = findTuneCarrierPartEntry(car?.parts_xml || "");
  const attrs = carrier?.attrs || {};
  const safeRedLine = Math.max(1000, Math.min(readNumericPartAttr(attrs, "rl", derivedRedLine), derivedRedLine));
  const rawShiftLightRpm = readNumericPartAttr(attrs, "slr", DEFAULT_DYNO_PURCHASE_STATE.shiftLightRpm);
  const safeShiftLightRpm = Math.max(1000, Math.min(rawShiftLightRpm, safeRedLine));

  return {
    boostSetting: readNumericPartAttr(attrs, "bs", DEFAULT_DYNO_PURCHASE_STATE.boostSetting),
    maxPsi: readNumericPartAttr(attrs, "mp", DEFAULT_DYNO_PURCHASE_STATE.maxPsi),
    chipSetting: readNumericPartAttr(attrs, "cs", DEFAULT_DYNO_PURCHASE_STATE.chipSetting),
    shiftLightRpm: safeShiftLightRpm,
    redLine: safeRedLine,
  };
}

function saveDynoTuneAttrsToPartsXml(partsXml, attrs, preferredSlotIds = DYNO_TUNE_CARRIER_SLOT_IDS) {
  const carrier = findTuneCarrierPartEntry(partsXml, preferredSlotIds);
  if (!carrier) {
    return null;
  }

  return replaceInstalledPartEntry(partsXml, carrier.raw, {
    ...carrier.attrs,
    ...attrs,
  });
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

function normalizePurchasePriceValue(rawValue) {
  const normalized = String(rawValue)
    .replace(/[^0-9.-]/g, "")
    .trim();
  return Math.max(0, toFiniteNumber(normalized, 0));
}

function parseShowroomPurchasePrice(params) {
  const rawValue =
    params.get("pr")
    || params.get("price")
    || params.get("cp")
    || params.get("p")
    || 0;
  return normalizePurchasePriceValue(rawValue);
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

function getComputerTournamentSessionForPlayer(playerId) {
  const stored = computerTournamentSessionsByPlayerId.get(Number(playerId || 0)) || null;
  if (!stored) {
    return null;
  }

  if (typeof stored === "string") {
    return computerTournamentSessions.get(stored) || null;
  }

  return stored;
}

async function resolveCallerSessionWithComputerTournamentFallback(context, sourceLabel) {
  const caller = await resolveCallerSession(context, sourceLabel);
  if (caller?.ok) {
    return caller;
  }

  const requestedPublicId = Number(context?.params?.get("aid") || 0);
  const fallbackPlayerId = requestedPublicId > 0
    ? await resolveInternalPlayerIdByPublicId(context.supabase, requestedPublicId)
    : 0;
  const fallbackSession = fallbackPlayerId > 0
    ? getComputerTournamentSessionForPlayer(fallbackPlayerId)
    : null;
  const fallbackPlayer = fallbackSession
    ? await getPlayerById(context.supabase, fallbackPlayerId)
    : null;

  if (!fallbackSession || !fallbackPlayer) {
    return caller;
  }

  return {
    ok: true,
    player: fallbackPlayer,
    playerId: fallbackPlayerId,
    publicId: getPublicIdForPlayer(fallbackPlayer),
    sessionKey: "",
    source: `${sourceLabel}:computer-tournament-session-fallback`,
  };
}

async function resolveCallerSessionWithPublicIdFallback(context, sourceLabel) {
  const caller = await resolveCallerSessionWithComputerTournamentFallback(context, sourceLabel);
  if (caller?.ok) {
    return caller;
  }

  const requestedPublicId = Number(context?.params?.get("aid") || 0);
  const fallbackPlayerId = requestedPublicId > 0
    ? await resolveInternalPlayerIdByPublicId(context.supabase, requestedPublicId)
    : 0;
  const fallbackPlayer = fallbackPlayerId > 0
    ? await getPlayerById(context.supabase, fallbackPlayerId)
    : null;

  if (!fallbackPlayer) {
    return caller;
  }

  return {
    ok: true,
    player: fallbackPlayer,
    playerId: fallbackPlayerId,
    publicId: getPublicIdForPlayer(fallbackPlayer),
    sessionKey: "",
    source: `${sourceLabel}:public-id-fallback`,
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
      `<n id='getpaints'><s>${getPaintColorsForLocation(resolved.locationId)}</s></n>`,
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

function getEffectiveTeamFund(team, members = []) {
  const persistedTeamFund = Number(team?.team_fund || 0);
  const contributionTotal = (members || []).reduce(
    (sum, member) => sum + Number(member?.contribution_score || 0),
    0,
  );
  return Math.max(persistedTeamFund, contributionTotal);
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

function ensureTeamMetadata(services, team, players, members = []) {
  const playerIds = new Set(players.map((player) => Number(player.id)));
  const memberContributionByPlayerId = new Map(
    (members || []).map((member) => [Number(member.player_id), Number(member.contribution_score || 0)]),
  );
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
      teamMeta.contributionByPlayerId[key] = memberContributionByPlayerId.get(Number(player.id)) || 0;
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

function renderTeamsWithMetadata(teams, playersByTeamId, membersByTeamId, services) {
  const body = teams.map((team) => {
    const players = playersByTeamId.get(Number(team.id)) || [];
    const members = membersByTeamId.get(Number(team.id)) || [];
    const effectiveTeam = { ...team, team_fund: getEffectiveTeamFund(team, members) };
    const { teamMeta, sortedPlayers, totalContribution } = ensureTeamMetadata(services, effectiveTeam, players, members);
    return renderTeamDetailXml(effectiveTeam, sortedPlayers, teamMeta, totalContribution);
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

  const [players, members] = await Promise.all([
    listPlayersForTeams(supabase, [teamId]),
    listTeamMembersForTeams(supabase, [teamId]),
  ]);
  const effectiveTeam = { ...team, team_fund: getEffectiveTeamFund(team, members) };
  const { teamMeta, sortedPlayers, totalContribution } = ensureTeamMetadata(services, effectiveTeam, players, members);
  const playersByPublicId = new Map(sortedPlayers.map((player) => [Number(getPublicIdForPlayer(player)), player]));

  return {
    team: effectiveTeam,
    players: sortedPlayers,
    members,
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

const MAX_TEAM_TRANSACTION_HISTORY = 50;

function getTeamTransactionEntries(teamMeta) {
  if (!Array.isArray(teamMeta?.transactions)) {
    return [];
  }

  return teamMeta.transactions
    .filter((entry) => Number(entry?.type || 0) > 0)
    .map((entry) => ({
      type: Number(entry.type || 0),
      username: String(entry.username || ""),
      amount: Math.abs(Number(entry.amount || 0)),
      date: String(entry.date || ""),
      createdAt: Number(entry.createdAt || 0) || 0,
    }));
}

function formatTeamTransactionDate(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
}

function buildTeamTransactionsXml(transactions = []) {
  const body = transactions.map((entry) => (
    `<tr d='${escapeXml(entry.date || "")}' t='${Number(entry.type || 0)}' ` +
    `u='${escapeXml(entry.username || "")}' a='${Math.abs(Number(entry.amount || 0))}'/>`
  )).join("");

  return `<transactions><r>${body}</r></transactions>`;
}

function recordTeamTransaction(services, teamId, teamMeta, transactionInput = {}) {
  const normalizedTeamId = Number(teamId || 0);
  const normalizedType = Number(transactionInput.type || 0);
  if (!normalizedTeamId || !normalizedType) {
    return teamMeta;
  }

  const existingTransactions = getTeamTransactionEntries(teamMeta);
  const createdAt = Number(transactionInput.createdAt || Date.now()) || Date.now();
  return saveTeamMeta(services, normalizedTeamId, {
    ...(teamMeta || {}),
    transactions: [
      {
        type: normalizedType,
        username: String(transactionInput.username || ""),
        amount: Math.abs(Number(transactionInput.amount || 0)),
        date: String(transactionInput.date || formatTeamTransactionDate(createdAt)),
        createdAt,
      },
      ...existingTransactions,
    ].slice(0, MAX_TEAM_TRANSACTION_HISTORY),
  });
}

function removeApplicationsForPlayer(teamMeta, playerId) {
  return {
    ...teamMeta,
    applications: (teamMeta.applications || []).filter(
      (application) => Number(application.applicantPlayerId || 0) !== Number(playerId || 0),
    ),
  };
}

function listTeamMetaEntries(services) {
  const teamState = services?.teamState;
  if (!teamState) {
    return [];
  }
  if (typeof teamState.list === "function") {
    return teamState.list();
  }
  if (teamState instanceof Map) {
    return [...teamState.values()];
  }
  if (teamState?.teams instanceof Map) {
    return [...teamState.teams.values()];
  }
  return [];
}

function clearApplicationsForPlayerAcrossTeams(services, playerId, { excludeTeamId = 0 } = {}) {
  const numericPlayerId = Number(playerId || 0);
  const excludedTeamId = Number(excludeTeamId || 0);
  if (!numericPlayerId) {
    return 0;
  }

  let clearedTeamCount = 0;
  for (const teamMetaEntry of listTeamMetaEntries(services)) {
    const teamId = Number(teamMetaEntry?.teamId || teamMetaEntry?.team_id || teamMetaEntry?.id || 0);
    if (!teamId || teamId === excludedTeamId) {
      continue;
    }

    const currentTeamMeta = sanitizeTeamMeta(teamMetaEntry);
    const nextTeamMeta = removeApplicationsForPlayer(currentTeamMeta, numericPlayerId);
    if ((currentTeamMeta.applications || []).length === (nextTeamMeta.applications || []).length) {
      continue;
    }

    saveTeamMeta(services, teamId, nextTeamMeta);
    clearedTeamCount += 1;
  }

  return clearedTeamCount;
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
  clearApplicationsForPlayerAcrossTeams(services, caller.playerId);
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
    if (typeof services?.teamState?.remove === "function") {
      services.teamState.remove(teamContext.team.id);
    } else if (services?.teamState?.teams) {
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
  const callerMoney = toFiniteNumber(caller.player.money, 0);
  if (callerMoney < amount) {
    return { body: `"s", -1`, source: "supabase:teamdeposit:insufficient-funds" };
  }

  const newBalance = callerMoney - amount;
  const nextContribution = Number(teamContext.teamMeta.contributionByPlayerId?.[String(caller.playerId)] || 0) + amount;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: Number(teamContext.team.team_fund || 0) + amount,
  });
  await updateTeamMemberContribution(supabase, caller.playerId, nextContribution, {
    teamId: teamContext.team.id,
  });
  recordTeamTransaction(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(caller.playerId)]: nextContribution,
    },
  }, {
    type: 3,
    username: caller.player.username,
    amount,
  });

  return { body: `"s", 1, "b", ${newBalance}`, source: "supabase:teamdeposit" };
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

  const newBalance = toFiniteNumber(caller.player.money, 0) + amount;
  const nextContribution = contribution - amount;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: teamFunds - amount,
  });
  await updateTeamMemberContribution(supabase, caller.playerId, nextContribution, {
    teamId: teamContext.team.id,
  });
  recordTeamTransaction(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(caller.playerId)]: nextContribution,
    },
  }, {
    type: 2,
    username: caller.player.username,
    amount,
  });

  return { body: `"s", 1, "b", ${newBalance}`, source: "supabase:teamwithdraw" };
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

  const nextContribution = contribution - amount;
  await updatePlayerMoney(supabase, targetPlayer.id, toFiniteNumber(targetPlayer.money, 0) + amount);
  await updateTeamRecord(supabase, teamContext.team.id, {
    team_fund: teamFunds - amount,
  });
  await updateTeamMemberContribution(supabase, targetPlayer.id, nextContribution, {
    teamId: teamContext.team.id,
  });
  recordTeamTransaction(services, teamContext.team.id, {
    ...teamContext.teamMeta,
    contributionByPlayerId: {
      ...teamContext.teamMeta.contributionByPlayerId,
      [String(targetPlayer.id)]: nextContribution,
    },
  }, {
    type: 1,
    username: targetPlayer.username,
    amount,
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
    return { body: `"s", -2`, source: "supabase:teamaccept:already-on-team" };
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
  clearApplicationsForPlayerAcrossTeams(services, caller.playerId, {
    excludeTeamId: teamContext.team.id,
  });
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

async function handleTeamTransactions(context) {
  const { supabase, params, services } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:teamtrans");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:teamtrans:bad-session" };
  }

  const teamId = Number(params.get("tid") || caller.player?.team_id || 0);
  if (!teamId) {
    return {
      body: wrapSuccessData(buildTeamTransactionsXml()),
      source: "supabase:teamtrans:none",
    };
  }

  const teamMeta = getTeamMeta(services, teamId);
  return {
    body: wrapSuccessData(buildTeamTransactionsXml(getTeamTransactionEntries(teamMeta))),
    source: "supabase:teamtrans",
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
  if (Number(caller.player?.active || 0) <= 0) {
    return { body: `"s", -60`, source: "supabase:addteamapp:inactive-account" };
  }
  if (Number(caller.player?.team_id || 0) > 0) {
    return { body: `"s", -6`, source: "supabase:addteamapp:already-on-team" };
  }

  const teamId = Number(params.get("tid") || 0);
  const comment = String(params.get("c") || "").trim().slice(0, 280);
  if (!teamId) {
    return { body: `"s", 0`, source: "supabase:addteamapp:no-team" };
  }

  const teamContext = await loadTeamContextById({ supabase, services, teamId });
  if (!teamContext) {
    return { body: `"s", 0`, source: "supabase:addteamapp:unknown-team" };
  }
  if (String(teamContext.team.recruitment_type || "open").toLowerCase() === "closed") {
    return { body: `"s", -1`, source: "supabase:addteamapp:closed" };
  }
  if ((teamContext.teamMeta.applications || []).some(
    (entry) => Number(entry.applicantPlayerId || 0) === Number(caller.playerId),
  )) {
    return { body: `"s", -5`, source: "supabase:addteamapp:duplicate" };
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

  const effectiveTeams = teams.map((team) => ({
    ...team,
    team_fund: getEffectiveTeamFund(team, membersByTeamId.get(Number(team.id)) || []),
  }));

  return { teams: effectiveTeams, members, players, playersById, membersByTeamId };
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
  const { supabase, params, logger, services } = context;
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
    let player = await getPlayerByUsername(supabase, username);

    if (!player || !verifyGamePassword(password, player.password_hash)) {
      logger.warn("Login failed: invalid credentials", {
        username,
        playerExists: !!player,
        passwordMatch: player ? verifyGamePassword(password, player.password_hash) : false
      });
      return { body: failureBody(), source: "supabase:login:invalid" };
    }

    logger.info("Login successful", { username, playerId: player.id, publicId: player.public_id });
    player = await recoverPlayerLoginBalances(supabase, player, logger);

    const cars = await ensurePlayerHasGarageCar(supabase, player.id, {
      catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
      wheelXml: getDefaultWheelXmlForCar(DEFAULT_STARTER_CATALOG_CAR_ID),
      partsXml: DEFAULT_STOCK_PARTS_XML,
    });
    const garageCars = decorateCarsWithTestDriveState(player.id, cars);
    const sessionKey = await createLoginSession({ supabase, playerId: player.id });
    const pollXml = services?.homePollState?.renderPollNodeForPlayer?.(player.id);
    return {
      body: buildLoginBody(player, garageCars, null, sessionKey, logger, {
        testDriveCar: buildTestDriveLoginState(player.id, garageCars),
        pollXml,
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

  const caller = await resolveCallerSessionWithPublicIdFallback(context, "supabase:getuser");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getuser:bad-session" };
  }

  const targetPublicId = Number(params.get("tid") || params.get("aid") || 0);
  if (!targetPublicId) {
    return { body: failureBody(), source: "supabase:getuser:missing-target" };
  }

  const player = await resolveTargetPlayerByPublicId(supabase, targetPublicId);
  if (!player) {
    const tournamentSession = getComputerTournamentSessionForPlayer(Number(caller.playerId)) || null;
    const syntheticUser = buildComputerTournamentSyntheticUser(tournamentSession, targetPublicId);
    if (syntheticUser) {
      return {
        body: wrapSuccessData(renderUserSummary(syntheticUser, { publicId: targetPublicId })),
        source: "generated:getuser:computer-tournament",
      };
    }

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

  const caller = await resolveCallerSessionWithPublicIdFallback(context, "supabase:getusers");
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
  const optionsByPlayerId = new Map();
  const tournamentSession = getComputerTournamentSessionForPlayer(Number(caller.playerId)) || null;
  let usedSyntheticUser = false;
  for (const publicId of targetPublicIds) {
    const player = await resolveTargetPlayerByPublicId(supabase, publicId);
    if (player) {
      players.push(player);
      optionsByPlayerId.set(Number(player.id), { publicId: getPublicIdForPlayer(player) });
      continue;
    }

    const syntheticUser = buildComputerTournamentSyntheticUser(tournamentSession, publicId);
    if (syntheticUser) {
      players.push(syntheticUser);
      optionsByPlayerId.set(Number(syntheticUser.id), { publicId });
      usedSyntheticUser = true;
    }
  }

  return {
    body: wrapSuccessData(
      renderUserSummaries(players, optionsByPlayerId),
    ),
    source: usedSyntheticUser
      ? "generated:getusers:computer-tournament"
      : "supabase:getusers",
  };
}

function isFixtureModeEnabled(context) {
  return Boolean(context?.config?.useFixtures);
}

function buildFixtureRaceCar(gameCarId, options = {}) {
  const resolvedGameCarId = Number(gameCarId || options.accountCarId || 1);
  const catalogCarId = Number(options.catalogCarId || DEFAULT_STARTER_CATALOG_CAR_ID);

  return {
    game_car_id: resolvedGameCarId,
    account_car_id: Number(options.accountCarId || resolvedGameCarId),
    catalog_car_id: catalogCarId,
    selected: Boolean(options.selected),
    color_code: String(options.colorCode || "FF0000"),
    paint_index: Number(options.paintIndex || 1),
    image_index: Number(options.imageIndex || 0),
    wheel_xml: options.wheelXml || getDefaultWheelXmlForCar(catalogCarId),
    parts_xml: options.partsXml || DEFAULT_STOCK_PARTS_XML,
    locked: 0,
    owner_public_id: Number(options.ownerPublicId || Math.max(1, Math.floor(resolvedGameCarId / 100) || 1)),
    plate_name: "",
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

  if (isFixtureModeEnabled(context)) {
    const fixtureCars = acidList.map((gameCarId) => buildFixtureRaceCar(gameCarId));
    return {
      body: wrapSuccessData(renderRacerCars(fixtureCars)),
      source: "fixture:getracerscars",
    };
  }

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

  if (isFixtureModeEnabled(context)) {
    return {
      body: wrapSuccessData(
        renderOwnedGarageCarsWrapper([
          buildFixtureRaceCar(targetPublicId, {
            selected: true,
            ownerPublicId: targetPublicId,
          }),
        ], {
          ownerPublicId: targetPublicId,
        }),
      ),
      source: "fixture:getallotherusercars",
    };
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
  const { supabase, params, logger } = context;
  if (!supabase) {
    return null;
  }

  logger?.info("gettworacerscars called", {
    r1acid: params.get("r1acid"),
    r2acid: params.get("r2acid"),
  });

  const caller = await resolveCallerSessionWithPublicIdFallback(context, "supabase:gettworacerscars");
  const callerPlayerId = caller?.ok ? caller.playerId : 0;
  const tournamentSession = callerPlayerId > 0
    ? getComputerTournamentSessionForPlayer(Number(callerPlayerId)) || null
    : null;
  let computerTournamentQualifyEnginePayload = null;

  const requestedCarIds = [params.get("r1acid"), params.get("r2acid")]
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value));
  const gameCarIds = requestedCarIds.filter((value) => value > 0);

  if (gameCarIds.length === 0) {
    return { body: failureBody(), source: "supabase:gettworacerscars:missing-cars" };
  }

  if (isFixtureModeEnabled(context)) {
    const orderedCars = gameCarIds.map((gameCarId) =>
      buildFixtureRaceCar(gameCarId, {
        accountCarId: gameCarId,
      }),
    );

    if (requestedCarIds.length >= 2 && Number(requestedCarIds[1] || 0) <= 0 && orderedCars.length === 1) {
      const primaryCar = orderedCars[0];
      orderedCars.push({
        ...primaryCar,
        game_car_id: Number(primaryCar.game_car_id),
        account_car_id: Number(primaryCar.account_car_id || primaryCar.game_car_id),
      });
    }

    return {
      body: wrapSuccessData(renderTwoRacerCars(orderedCars)),
      source: "fixture:gettworacerscars",
    };
  }

  const cars = await listCarsByIds(supabase, gameCarIds);
  const carsById = new Map((cars || []).map((car) => [Number(car.game_car_id), car]));
  const orderedCars = gameCarIds
    .map((gameCarId) => carsById.get(gameCarId) || buildComputerTournamentVirtualCar(gameCarId))
    .filter(Boolean);
  let isComputerTournamentQualifyResponse = false;

  // The tournament qualify flow requests (myCarId, 0) but still reuses the
  // two-racer XML structure. Mirror the player's car into lane 2 so the client
  // always has childNodes[0] and childNodes[1] available during that flow.
  if (requestedCarIds.length >= 2 && Number(requestedCarIds[1] || 0) <= 0 && orderedCars.length === 1) {
    const primaryCar = orderedCars[0];
    isComputerTournamentQualifyResponse =
      !!tournamentSession
      && Number(tournamentSession.lastRequestedCarId || tournamentSession.activeCarId || 0) === Number(primaryCar?.game_car_id || 0)
      && Number(tournamentSession.wins || 0) === 0
      && Number(tournamentSession.currentRound || 0) === 0
      && Number(tournamentSession.qualifyingComplete || 0) === 1;
    if (isComputerTournamentQualifyResponse) {
      tournamentSession.lastQualifyCarsFetchAt = Date.now();
      bindComputerTournamentSession(tournamentSession);
      computerTournamentQualifyEnginePayload = buildDriveableEnginePayloadForCar(primaryCar);
    }

    orderedCars.push({
      ...primaryCar,
      game_car_id: 0,
      account_car_id: 0,
      owner_public_id: Number(primaryCar?.owner_public_id || caller?.publicId || 0),
      solo_lane_placeholder: 1,
    });
  }

  const responseXml = renderTwoRacerCars(orderedCars);
  logTournamentPayload(context.logger, "gettworacerscars", responseXml, {
    requestedCarIds,
    resolvedGameCarIds: orderedCars.map((car) => Number(car?.game_car_id || 0)),
    callerPlayerId,
    includesEngineTiming: Boolean(computerTournamentQualifyEnginePayload?.timing?.length),
  });

  return {
    body: computerTournamentQualifyEnginePayload
      ? `"s", 1, "d", "${responseXml}", "t", [${computerTournamentQualifyEnginePayload.timing.join(", ")}]`
      : wrapSuccessData(responseXml),
    source: caller?.ok
      ? (computerTournamentQualifyEnginePayload ? "supabase:gettworacerscars:qualify-with-timing" : "supabase:gettworacerscars")
      : "supabase:gettworacerscars:anon-fallback",
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
    body: wrapSuccessData(
      `<cars i='${escapeXml(caller.publicId)}' dc='${escapeXml(
        garageCars.find((car) => car.selected)?.game_car_id ?? garageCars[0]?.game_car_id ?? "",
      )}'>${renderOwnedGarageCarsWithTournamentLanePlaceholder(garageCars)}</cars>`,
    ),
    source: "supabase:getallcars",
  };
}

async function handleGetOneCar(context) {
  const { supabase, params, logger } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getonecar");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getonecar:bad-session" };
  }

  const requestedCarId = Number(params.get("acid") || 0);

  if (isFixtureModeEnabled(context)) {
    const fixtureCar = buildFixtureRaceCar(requestedCarId || 1, {
      selected: true,
      ownerPublicId: caller.publicId,
    });
    return {
      body: wrapSuccessData(renderOwnedGarageCar(fixtureCar)),
      source: "fixture:getonecar",
    };
  }

  const cars = await ensurePlayerHasGarageCar(supabase, caller.playerId, {
    catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
    wheelXml: getDefaultWheelXmlForCar(DEFAULT_STARTER_CATALOG_CAR_ID),
    partsXml: DEFAULT_STOCK_PARTS_XML,
  });
  const garageCars = decorateCarsWithTestDriveState(caller.playerId, cars);
  const resolvedCar = (
    requestedCarId > 0
      ? garageCars.find((car) => Number(car.game_car_id) === requestedCarId || Number(car.account_car_id || 0) === requestedCarId)
      : null
  ) || garageCars.find((car) => car.selected) || garageCars[0] || null;

  if (!resolvedCar) {
    return { body: failureBody(), source: "supabase:getonecar:no-car" };
  }

  logger?.info("GetOneCar returning car", {
    requestedCarId,
    returnedCarId: resolvedCar.game_car_id,
    partsXmlLength: resolvedCar.parts_xml?.length || 0,
  });

  return {
    body: wrapSuccessData(renderOwnedGarageCar(resolvedCar)),
    source: "supabase:getonecar",
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

function buildDriveableEnginePayloadForCar(car) {
  if (!car) {
    return null;
  }

  const { engineTypeId } = getCarBuildFlags(car);
  const catalogCarId = String(car?.catalog_car_id || "");
  if (!hasShowroomCarSpec(catalogCarId)) {
    return null;
  }

  const timing = generateTimingArray(catalogCarId, engineTypeId);
  const gearRatios = getPersistedGearRatios(car);
  const engineXml = buildDriveableEngineXml({
    catalogCarId,
    gearRatios,
    engineTypeId,
  });

  return { engineXml, timing };
}

async function handleGetOneCarEngine(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";
  let car = null;

  if (isFixtureModeEnabled(context)) {
    const caller = await resolveCallerSession(context, "fixture:getonecarengine");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "fixture:getonecarengine:bad-session",
      };
    }

    car = buildFixtureRaceCar(Number(accountCarId || 1), {
      selected: true,
      ownerPublicId: caller.publicId,
    });
  }

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getonecarengine");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getonecarengine:bad-session",
      };
    }

    if (accountCarId) {
      car = car || await getCarById(supabase, accountCarId);
    }
  }

  if (!car) {
    return {
      body: failureBody(),
      source: "generated:getonecarengine:no-car",
    };
  }

  const { boostType, nosSize, compressionLevel, engineTypeId } = getCarBuildFlags(car);

  const engineSound = boostType === "T" ? 2 : boostType === "S" ? 3 : 1;

  const catalogCarId = String(car?.catalog_car_id || "");
  if (!hasShowroomCarSpec(catalogCarId)) {
    return {
      body: failureBody(),
      source: "generated:getonecarengine:unsupported-car",
    };
  }
  const timing = generateTimingArray(catalogCarId, engineTypeId);
  const gearRatios = getPersistedGearRatios(car);
  const engineXml = buildDriveableEngineXml({
    catalogCarId,
    gearRatios,
    engineTypeId,
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

  const accountCarId = context.params.get("acid") || "";
  const car = accountCarId ? await getCarById(supabase, accountCarId) : null;
  const dynoState = car ? getPersistedDynoState(car) : DEFAULT_DYNO_PURCHASE_STATE;

  if (player.has_dyno === 1 || player.has_dyno === true) {
    return {
      body:
        `"s", 1, "b", ${toFiniteNumber(player.money, 0)}, ` +
        `"bs", ${Number(dynoState.boostSetting)}, ` +
        `"mp", ${Number(dynoState.maxPsi)}, ` +
        `"cs", ${Number(dynoState.chipSetting)}, ` +
        `"sl", ${Number(dynoState.shiftLightRpm)}, ` +
        `"rl", ${Number(dynoState.redLine)}`,
      source: "supabase:buydyno:already-owned",
    };
  }

  const dynoPrice = 500;
  const newBalance = toFiniteNumber(player.money, 0) - dynoPrice;

  if (newBalance < 0) {
    return { body: `"s", "-2"`, source: "supabase:buydyno:insufficient-funds" };
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
      `"bs", ${Number(dynoState.boostSetting)}, ` +
      `"mp", ${Number(dynoState.maxPsi)}, ` +
      `"cs", ${Number(dynoState.chipSetting)}, ` +
      `"sl", ${Number(dynoState.shiftLightRpm)}, ` +
      `"rl", ${Number(dynoState.redLine)}`,
    source: "supabase:buydyno",
  };
}

function resolvePartPurchaseCharge({
  rawPaymentType = "",
  requestedPrice = 0,
  moneyPrice = 0,
  pointsPrice = 0,
  treatRawPAsCustomGraphic = false,
} = {}) {
  const normalizedPaymentType = String(rawPaymentType || "").trim().toLowerCase();
  const normalizedRequestedPrice = normalizePurchasePriceValue(requestedPrice);
  const normalizedMoneyPrice = Math.max(0, toFiniteNumber(moneyPrice, 0));
  const normalizedPointsPrice = Math.max(0, toFiniteNumber(pointsPrice, 0));
  if (treatRawPAsCustomGraphic) {
    return {
      chargePoints: false,
      price: normalizedRequestedPrice || normalizedMoneyPrice,
    };
  }
  const explicitPointsPayment = normalizedPaymentType === "p" && !treatRawPAsCustomGraphic;
  const explicitMoneyPayment = normalizedPaymentType === "m";
  const requestedLooksLikePoints = normalizedRequestedPrice > 0
    && normalizedPointsPrice > 0
    && normalizedRequestedPrice === normalizedPointsPrice
    && normalizedRequestedPrice !== normalizedMoneyPrice;
  const requestedLooksLikeMoney = normalizedRequestedPrice > 0 && normalizedRequestedPrice === normalizedMoneyPrice;
  const pointsOnlyCatalogPrice = normalizedRequestedPrice === 0 && normalizedMoneyPrice === 0 && normalizedPointsPrice > 0;
  const chargePoints = normalizedPointsPrice > 0
    && !requestedLooksLikeMoney
    && (explicitPointsPayment || requestedLooksLikePoints || (pointsOnlyCatalogPrice && !explicitMoneyPayment));

  let price = normalizedRequestedPrice;
  if (price === 0) {
    price = chargePoints ? normalizedPointsPrice : normalizedMoneyPrice;
  }

  return {
    chargePoints,
    price,
  };
}

function buildPartPurchaseResponseBody({ moneyBalance, pointsBalance, installId }) {
  return `"s", 1, "d1", "<r s='2' b='${moneyBalance}' ai='${installId}'/>", "d", "<r s='1' b='${pointsBalance}'></r>"`;
}

function buildCarPurchaseResponseBody({ moneyBalance, pointsBalance, gameCarId }) {
  return `"s", 1, "d1", "<r s='2' b='${moneyBalance}' ai='${gameCarId}'/>", "d", "<r s='1' b='${pointsBalance}'></r>"`;
}

async function handleBuyPart(context) {
  const { supabase, params, logger, remoteAddress } = context;
  const accountCarId = params.get("acid") || "";
  const partId = Number(params.get("pid") || 0);
  const decalId = params.get("did") || "";
  const decalFileExt = normalizeUserGraphicFileExt(params.get("fx") || "", "png");
  const rawPartType = params.get("pt") || "";
  const requestedPrice = parseShowroomPurchasePrice(params);
  const isCustomGraphicRequest = rawPartType === "p" && Boolean(decalId);

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
  const moneyPrice = Number(catalogPart?.p || 0);
  const pointsPrice = Number(catalogPart?.pp || 0);
  const purchase = resolvePartPurchaseCharge({
    rawPaymentType: rawPartType,
    requestedPrice,
    moneyPrice,
    pointsPrice,
    treatRawPAsCustomGraphic: isCustomGraphicRequest,
  });
  let price = purchase.price;

  if (catalogPart) {
    partName = catalogPart.n || "Part";
    partSlotId = String(catalogPart.pi || "");
    partPs = catalogPart.ps || "";
  }

  // Legacy custom graphics can still arrive without a catalog wallet price.
  if (price === 0 && isCustomGraphicRequest && partId && !purchase.chargePoints) {
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

  if (!catalogPart && !isCustomGraphicRequest) {
    return { body: failureBody(), source: "supabase:buypart:no-part" };
  }

  const currentMoneyBalance = toFiniteNumber(player.money, 0);
  const currentPointsBalance = toFiniteNumber(player.points, 0);
  let newMoneyBalance = currentMoneyBalance;
  let newPointsBalance = currentPointsBalance;
  if (purchase.chargePoints) {
    newPointsBalance -= price;
    if (newPointsBalance < 0) {
      return { body: failureBody(), source: "supabase:buypart:insufficient-points" };
    }
    await updatePlayerRecord(supabase, caller.playerId, { points: newPointsBalance });
  } else {
    newMoneyBalance -= price;
    if (newMoneyBalance < 0) {
      return { body: failureBody(), source: "supabase:buypart:insufficient-funds" };
    }
    await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
  }

  let installId = createInstalledPartId();

  // Save part to the owned car's parts_xml
  if (accountCarId && partId) {
    if (isCustomGraphicRequest) {
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
      let resolvedDecalFileExt = decalFileExt;

      try {
        const { existsSync, mkdirSync, readdirSync, renameSync, statSync } = await import("node:fs");
        const { extname, resolve } = await import("node:path");
        const decalDir = resolve(process.cwd(), "../cache/car/userDecals");
        mkdirSync(decalDir, { recursive: true });
        const targetPath = resolve(decalDir, `${slotId}_${decalId}.${decalFileExt}`);
        const exactSourceCandidates = [
          resolve(decalDir, `${decalId}.${decalFileExt}`),
          resolve(decalDir, `${decalId}.png`),
          resolve(decalDir, `${decalId}.jpg`),
          resolve(decalDir, `${decalId}.jpeg`),
          resolve(decalDir, `${decalId}.gif`),
        ];
        const exactSourcePath = exactSourceCandidates.find((candidate) => existsSync(candidate)) || "";
        let sourcePath = existsSync(exactSourcePath) ? exactSourcePath : "";
        if (sourcePath) {
          resolvedDecalFileExt = normalizeUserGraphicFileExt(extname(sourcePath), decalFileExt);
        }

        if (!sourcePath) {
          const recentUpload = consumeRecentDecalUpload({ remoteAddress, slotId });
          if (recentUpload?.targetPath && existsSync(recentUpload.targetPath)) {
            sourcePath = recentUpload.targetPath;
            resolvedDecalFileExt = normalizeUserGraphicFileExt(extname(recentUpload.targetPath), decalFileExt);
          }
        }

        if (!sourcePath) {
          const now = Date.now();
          const fallbackUpload = readdirSync(decalDir)
            .filter((file) => /\.(png|jpe?g|gif)$/i.test(file))
            .map((file) => {
              const filePath = resolve(decalDir, file);
              return {
                filePath,
                ageMs: now - statSync(filePath).mtimeMs,
              };
            })
            .filter((file) => file.ageMs <= 2 * 60 * 1000)
            .sort((a, b) => a.ageMs - b.ageMs)[0];

          sourcePath = fallbackUpload?.filePath || "";
          if (sourcePath) {
            resolvedDecalFileExt = normalizeUserGraphicFileExt(extname(sourcePath), decalFileExt);
            logger?.warn("Using recent upload fallback for custom graphic", {
              decalId,
              slotId,
              sourcePath,
              remoteAddress,
            });
          }
        }

        if (sourcePath) {
          const normalizedTargetPath = resolve(decalDir, `${slotId}_${decalId}.${resolvedDecalFileExt}`);
          renameSync(sourcePath, normalizedTargetPath);
        } else {
          logger?.warn("Custom graphic source upload missing", {
            decalId,
            slotId,
            exactSourcePath,
            remoteAddress,
          });
        }
      } catch (err) {
        logger?.error("Failed to rename decal", { error: err.message });
      }

      const installedPartXml = `<p ai='${installId}' i='${partId}' ci='${slotId}' pi='${slotId}' pt='c' t='c' n='Custom Graphic' in='1' cc='0' pdi='${decalId}' di='${decalId}' fe='${resolvedDecalFileExt}' ps=''/>`;
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
        // Also update parts_xml so the client sees the installed wheel slot state
        const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId, {
          t: "c",
          ps: wheelSize,
        });
        const partsXml = upsertInstalledPartXml(car.parts_xml || "", "14", installedPartXml);
        await saveCarPartsXml(supabase, accountCarId, partsXml);
      } else {
        const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId, {
          t: catalogPart.t || rawPartType || "",
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
    body: buildPartPurchaseResponseBody({
      moneyBalance: newMoneyBalance,
      pointsBalance: newPointsBalance,
      installId,
    }),
    source: "supabase:buypart",
  };
}

async function handleBuyEnginePart(context) {
  const { supabase, params, logger } = context;
  const accountCarId = params.get("acid") || "";
  const partId = Number(params.get("epid") || 0);
  const rawPaymentType = params.get("pt") || "";
  const requestedPrice = parseShowroomPurchasePrice(params);

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
  const engine = await getOwnedEngineById(supabase, Number(car.owned_engine_id || car.installed_engine_id || 0), caller.playerId);
  if (!engine) {
    return { body: failureBody(), source: "supabase:buyenginepart:no-engine" };
  }

  const catalogPart = partId ? getPartsCatalogById().get(Number(partId)) : null;
  if (!catalogPart) {
    return { body: failureBody(), source: "supabase:buyenginepart:no-part" };
  }

  const purchase = resolvePartPurchaseCharge({
    rawPaymentType,
    requestedPrice,
    moneyPrice: Number(catalogPart.p || 0),
    pointsPrice: Number(catalogPart.pp || 0),
  });
  const currentMoneyBalance = toFiniteNumber(player.money, 0);
  const currentPointsBalance = toFiniteNumber(player.points, 0);
  let newMoneyBalance = currentMoneyBalance;
  let newPointsBalance = currentPointsBalance;
  if (purchase.chargePoints) {
    newPointsBalance -= purchase.price;
    if (newPointsBalance < 0) {
      return { body: failureBody(), source: "supabase:buyenginepart:insufficient-points" };
    }
    await updatePlayerRecord(supabase, caller.playerId, { points: newPointsBalance });
  } else {
    newMoneyBalance -= purchase.price;
    if (newMoneyBalance < 0) {
      return { body: failureBody(), source: "supabase:buyenginepart:insufficient-funds" };
    }
    await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
  }

  const installId = createInstalledPartId();
  const slotId = String(catalogPart.pi || "");
  const installedPartXml = buildInstalledCatalogPartXml(catalogPart, installId);
  const partsXml = upsertInstalledPartXml(engine.parts_xml || "", slotId, installedPartXml);
  try {
    await updateOwnedEngineRecord(supabase, engine.id, {
      partsXml,
      engineTypeId: getEngineTypeIdForCar({ catalog_car_id: car.catalog_car_id, parts_xml: partsXml }),
    });
    logger?.info("Saved engine part to owned engine", { accountCarId, engineId: engine.id, partId, slotId, installId, partsXmlLength: partsXml.length });
  } catch (error) {
    logger?.error("Failed to save engine part", { error, accountCarId, engineId: engine.id, partId, slotId });
  }

  return {
    body: buildPartPurchaseResponseBody({
      moneyBalance: newMoneyBalance,
      pointsBalance: newPointsBalance,
      installId,
    }),
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

  const paymentType = String(params.get("pt") || "m").toLowerCase();
  const moneyPrice = getCatalogCarPrice(catalogCarId);
  const pointPrice = getCatalogCarPointPrice(catalogCarId);
  const requestedPrice = parseShowroomPurchasePrice(params);
  const purchasePrice = requestedPrice || (paymentType === "p" ? pointPrice : moneyPrice);
  const currentMoneyBalance = toFiniteNumber(player.money, 0);
  const currentPointsBalance = toFiniteNumber(player.points, 0);
  let newMoneyBalance = currentMoneyBalance;
  let newPointsBalance = currentPointsBalance;

  if (paymentType === "p") {
    newPointsBalance -= purchasePrice;
    if (newPointsBalance < 0) {
      return { body: failureBody(), source: "supabase:buycar:insufficient-points" };
    }
  } else {
    newMoneyBalance -= purchasePrice;
    if (newMoneyBalance < 0) {
      return { body: failureBody(), source: "supabase:buycar:insufficient-funds" };
    }
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

  if (paymentType === "p") {
    await updatePlayerRecord(supabase, caller.playerId, { points: newPointsBalance });
  } else {
    await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
  }

  return {
    body: buildCarPurchaseResponseBody({
      moneyBalance: newMoneyBalance,
      pointsBalance: newPointsBalance,
      gameCarId: createdCar.game_car_id,
    }),
    source: "supabase:buycar",
  };
}

async function handleUpdateDefaultCar(context) {
  const { supabase, params } = context;
  const gameCarId = Number(params.get("acid") || params.get("cid") || 0);
  const requestedPublicId = Number(params.get("aid") || 0);

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

  const tournamentSession = getComputerTournamentSessionForPlayer(caller.playerId);
  if (
    tournamentSession
    && (!requestedPublicId || Number(caller.publicId || 0) === requestedPublicId)
  ) {
    tournamentSession.lastRequestedCarId = gameCarId;
    tournamentSession.activeCarId = gameCarId;
    bindComputerTournamentSession(tournamentSession);
  }

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
    const pointPrice = toFiniteNumber(activeTestDrive.pointPrice, NaN);
    if (!Number.isFinite(pointPrice) || pointPrice < 0) {
      return { body: `"s", -4`, source: "buytestdrivecar:invalid-points-price" };
    }
    const newPointsBalance = toFiniteNumber(player.points, 0) - pointPrice;
    if (newPointsBalance < 0) {
      return { body: `"s", -4`, source: "buytestdrivecar:insufficient-points" };
    }

    await updatePlayerRecord(supabase, caller.playerId, { points: newPointsBalance });

    clearActiveTestDriveCar(caller.playerId);
    await clearCarTestDriveState(supabase, activeTestDrive.gameCarId);
    return {
      body: `"s", 1, "m", ${newPointsBalance}`,
      source: "buytestdrivecar:points",
    };
  }

  const moneyPrice = toFiniteNumber(activeTestDrive.moneyPrice, NaN);
  if (!Number.isFinite(moneyPrice) || moneyPrice < 0) {
    return { body: `"s", -4`, source: "buytestdrivecar:invalid-money-price" };
  }
  const newMoneyBalance = toFiniteNumber(player.money, 0) - moneyPrice;
  if (newMoneyBalance < 0) {
    return { body: `"s", -4`, source: "buytestdrivecar:insufficient-money" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
  clearActiveTestDriveCar(caller.playerId);
  await clearCarTestDriveState(supabase, activeTestDrive.gameCarId);
  return {
    body: `"s", 2, "m", ${newMoneyBalance}`,
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
  { i: "1001", pi: "0", n: "Toreno Showroom", cl: "55AACC", l: "100" },
  { i: "1002", pi: "0", n: "Newburge Showroom", cl: "55CC55", l: "200" },
  { i: "1003", pi: "0", n: "Creek Side Showroom", cl: "CCAA55", l: "300" },
  { i: "1004", pi: "0", n: "Vista Heights Showroom", cl: "CC5555", l: "400" },
  { i: "1005", pi: "0", n: "Diamond Point Showroom", cl: "CC55CC", l: "500" },
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
  const catalogCarId = toFiniteNumber(state.catalogCarId, 0);
  activeTestDriveCarsByPlayerId.set(Number(state.playerId), {
    ...state,
    playerId: Number(state.playerId),
    gameCarId: Number(state.gameCarId),
    catalogCarId,
    invitationId: Number(state.invitationId),
    moneyPrice: toFiniteNumber(state.moneyPrice, getCatalogCarPrice(catalogCarId)),
    pointPrice: toFiniteNumber(state.pointPrice, getCatalogCarPointPrice(catalogCarId)),
    hoursRemaining: toFiniteNumber(state.hoursRemaining, 0),
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
    const catalogCarId = toFiniteNumber(persistedCar.catalog_car_id, 0);
    return {
      playerId: Number(playerId),
      gameCarId: Number(persistedCar.game_car_id),
      catalogCarId,
      invitationId: Number(persistedCar.test_drive_invitation_id),
      moneyPrice: toFiniteNumber(persistedCar.test_drive_money_price, getCatalogCarPrice(catalogCarId)),
      pointPrice: toFiniteNumber(persistedCar.test_drive_point_price, getCatalogCarPointPrice(catalogCarId)),
      hoursRemaining: toFiniteNumber(persistedCar.test_drive_hours_remaining, 0),
      expired: Number(persistedCar.test_drive_expired || 0) === 1,
    };
  }

  return getActiveTestDriveCar(playerId);
}

function buildTestDriveLoginState(playerId, cars = []) {
  const persistedCar = findTestDriveCarInGarage(cars);
  if (persistedCar) {
    const catalogCarId = toFiniteNumber(persistedCar.catalog_car_id, 0);
    return {
      gameCarId: Number(persistedCar.game_car_id),
      invitationId: Number(persistedCar.test_drive_invitation_id),
      moneyPrice: toFiniteNumber(persistedCar.test_drive_money_price, getCatalogCarPrice(catalogCarId)),
      pointPrice: toFiniteNumber(persistedCar.test_drive_point_price, getCatalogCarPointPrice(catalogCarId)),
      hoursRemaining: toFiniteNumber(persistedCar.test_drive_hours_remaining, 0),
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
const TEMP_USE_LEGACY_CAPTURED_TIMING_FOR_TESTING = false;

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

function generateTimingArray(catalogCarId, engineTypeId = null) {
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
  const profile = getCapturedTimingCurveProfile({
    ...spec,
    eo: getEffectiveEngineString(spec.eo, engineTypeId ?? getEngineTypeIdForCatalogCar(catalogCarId)),
  });
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
function getCarRedLine(catalogCarId, engineTypeId = null) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }
  return getRedLine(getEffectiveEngineString(spec.eo, engineTypeId), spec.tt);
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
function buildN2Fields(catalogCarId, gearRatioOverrides = null, engineTypeId = null) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const hp = getShowroomSpecHorsepower(spec, catalogCarId);
  const weight = getShowroomSpecWeight(spec, catalogCarId);
  const effectiveEngineStr = getEffectiveEngineString(spec.eo, engineTypeId);
  const engineStr = effectiveEngineStr.toLowerCase();
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
  const sl = getRedLine(effectiveEngineStr, spec.tt);
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
    engineStr: effectiveEngineStr, drivetrainStr,
    transmissionStr, bodyTypeStr: spec.ct,
  });
  const ratios = raceSpec.gearbox.forwardRatios;
  const f = Number(gearRatioOverrides?.g1 ?? ratios[0] ?? 3.587);
  const g = Number(gearRatioOverrides?.g2 ?? ratios[1] ?? 2.022);
  const h = Number(gearRatioOverrides?.g3 ?? ratios[2] ?? 1.384);
  const i = Number(gearRatioOverrides?.g4 ?? ratios[3] ?? 1.000);
  const j = Number(gearRatioOverrides?.g5 ?? ratios[4] ?? 0.861);
  const l = Number(gearRatioOverrides?.fg ?? raceSpec.gearbox.finalDrive);

  return { x, y, z, r, aa, sl, a, n, o, f, g, h, i, j, l };
}

function getDefaultGearRatiosForCar(car) {
  const catalogCarId = String(car?.catalog_car_id || "");
  const engineTypeId = getEngineTypeIdForCar(car);
  const defaultRatios = {
    g1: "3.587",
    g2: "2.022",
    g3: "1.384",
    g4: "1",
    g5: "0.861",
    g6: "0",
    fg: "4.058",
  };

  if (!catalogCarId || !hasShowroomCarSpec(catalogCarId)) {
    return defaultRatios;
  }

  const n2 = buildN2Fields(catalogCarId, null, engineTypeId);
  return {
    g1: String(n2.f ?? defaultRatios.g1),
    g2: String(n2.g ?? defaultRatios.g2),
    g3: String(n2.h ?? defaultRatios.g3),
    g4: String(n2.i ?? defaultRatios.g4),
    g5: String(n2.j ?? defaultRatios.g5),
    g6: "0",
    fg: String(n2.l ?? defaultRatios.fg),
  };
}

function getPersistedGearRatios(car) {
  const defaultRatios = getDefaultGearRatiosForCar(car);
  const carrier = findTuneCarrierPartEntry(car?.parts_xml || "", GEAR_TUNE_SLOT_IDS);
  const attrs = carrier?.attrs || {};

  return {
    g1: attrs.g1 || defaultRatios.g1,
    g2: attrs.g2 || defaultRatios.g2,
    g3: attrs.g3 || defaultRatios.g3,
    g4: attrs.g4 || defaultRatios.g4,
    g5: attrs.g5 || defaultRatios.g5,
    g6: attrs.g6 || defaultRatios.g6,
    fg: attrs.fg || defaultRatios.fg,
  };
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
  const engineTypeId = getEngineTypeIdForCar(car);
  const boostType = getBoostTypeForCar(car);
  let nosSize = 0;
  let compressionLevel = 0;

  if (xml) {
    const hasBottles = /<p[^>]*\b(?:ci|pi)=["']203["'][^>]*\/>/.test(xml);
    const hasJets = /<p[^>]*\b(?:ci|pi)=["']204["'][^>]*\/>/.test(xml);
    if (hasBottles && hasJets) nosSize = 100;

    const pistonMatch = xml.match(/<p[^>]*\b(?:ci|pi)=["']190["'][^>]*\b(?:di|pdi)=["'](\d+)["'][^>]*\/>/i);
    compressionLevel = pistonMatch ? Number(pistonMatch[1]) : 0;
  }

  return { boostType, nosSize, compressionLevel, engineTypeId };
}

function getDriveableBoostField(boostType) {
  const numericBoost = Number(boostType);
  // The legacy Flash practice client expects `b` to stay numeric. String
  // flags like "T" / "S" bubble into NaN client-side and break launch state.
  return Number.isFinite(numericBoost) ? numericBoost : 0;
}

function buildDriveableEngineXml({ catalogCarId, gearRatios = null, engineTypeId = null }) {
  const spec = getShowroomCarSpec(catalogCarId);
  if (!spec) {
    throw new Error(`Missing showroom spec for catalog car ${catalogCarId}`);
  }

  const n2 = buildN2Fields(catalogCarId, gearRatios, engineTypeId);
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
        // Child <p /> nodes under a showroom car are parsed like installed visual parts.
        // Serializing the swatch list here causes the Flash client to render extra paint
        // layers directly on the car preview, which shows up as dark blotches.
        renderShowroomCarBody(cid, {
          colorCode: primarySwatch.colorCode,
          paintIndex: primarySwatch.paintId,
        }) +
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
      const balance = s === 1 ? toFiniteNumber(player?.points, 0) : toFiniteNumber(player?.money, 0);
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
    source: "generated:listclassified",
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
    source: `generated:viewshowroom:lid=${locationId}`,
  };
}

async function handleGetStarterShowroom(context) {
  return {
    body: wrapSuccessData(buildShowroomXml(100, true)),
    source: "generated:getstartershowroom",
  };
}

async function handleUploadRequest(context) {
  // The client uploads decals/avatars to an external CDN. In local mode we
  // just tell it the upload is accepted.
  return { body: `"s", 1`, source: "generated:uploadrequest" };
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
  const salePrice = toFiniteNumber(params.get("pr") || params.get("price"), 0);

  if (gameCarId) {
    // Verify the car belongs to this player before crediting money
    const car = await getCarById(supabase, gameCarId);
    if (car && Number(car.player_id) === caller.playerId) {
      const player = await getPlayerById(supabase, caller.playerId);
      const newBalance = toFiniteNumber(player?.money, 0) + salePrice;
      const currentPointsBalance = toFiniteNumber(player?.points, 0);
      await updatePlayerMoney(supabase, caller.playerId, newBalance);
      await deleteCar(supabase, gameCarId);
      return {
        body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='0'/>", "d", "<r s='1' b='${currentPointsBalance}'/>"`,
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

  const ratios = getPersistedGearRatios(car);

  const gearRatios =
    `<g p='2500' pp='25'>` +
    `<r g1='${ratios.g1}' g2='${ratios.g2}' g3='${ratios.g3}' g4='${ratios.g4}' g5='${ratios.g5}' g6='${ratios.g6}' fg='${ratios.fg}'/>` +
    `</g>`;
  return {
    body: wrapSuccessData(gearRatios),
    source: "generated:getgearinfo",
  };
}

async function resolveOwnedCarContext(context, sourceLabel) {
  const { supabase, params } = context;
  if (!supabase) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:no-supabase` };
  }

  const caller = await resolveCallerSession(context, sourceLabel);
  if (!caller?.ok) {
    return { ok: false, body: caller?.body || failureBody(), source: caller?.source || `${sourceLabel}:bad-session` };
  }

  const accountCarId = params.get("acid") || "";
  const car = accountCarId ? await getCarById(supabase, accountCarId) : null;
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { ok: false, body: failureBody(), source: `${sourceLabel}:no-car` };
  }

  return { ok: true, caller, car, accountCarId };
}

async function persistCarTuneAttrs({ supabase, accountCarId, car, attrs, preferredSlotIds }) {
  const nextPartsXml = saveDynoTuneAttrsToPartsXml(car.parts_xml || "", attrs, preferredSlotIds);
  if (!nextPartsXml) {
    return null;
  }

  await saveCarPartsXml(supabase, accountCarId, nextPartsXml);
  return nextPartsXml;
}

async function handleChangeBoost(context) {
  const { supabase, params } = context;
  const resolved = await resolveOwnedCarContext(context, "supabase:changeboost");
  if (!resolved?.ok) {
    return resolved;
  }

  const requestedBoost = Number(params.get("bs") || 0);
  if (!Number.isFinite(requestedBoost) || requestedBoost < 0 || requestedBoost > DEFAULT_DYNO_PURCHASE_STATE.maxPsi) {
    return { body: `"s", "-2"`, source: "supabase:changeboost:invalid" };
  }

  const hasController = Boolean(
    findInstalledPartEntryBySlots(resolved.car.parts_xml || "", BOOST_CONTROLLER_SLOT_IDS)
    || findTuneCarrierPartEntry(resolved.car.parts_xml || ""),
  );
  if (!hasController) {
    return { body: `"s", "-1"`, source: "supabase:changeboost:no-controller" };
  }

  try {
    const nextPartsXml = await persistCarTuneAttrs({
      supabase,
      accountCarId: resolved.accountCarId,
      car: resolved.car,
      attrs: { bs: String(requestedBoost), mp: String(DEFAULT_DYNO_PURCHASE_STATE.maxPsi) },
      preferredSlotIds: BOOST_CONTROLLER_SLOT_IDS,
    });
    if (!nextPartsXml) {
      return { body: `"s", "-4"`, source: "supabase:changeboost:no-carrier" };
    }
  } catch (error) {
    return { body: `"s", "-3"`, source: "supabase:changeboost:save-failed" };
  }

  return { body: `"s", 1`, source: "supabase:changeboost" };
}

async function handleChangeAirFuel(context) {
  const { supabase, params } = context;
  const resolved = await resolveOwnedCarContext(context, "supabase:changeairfuel");
  if (!resolved?.ok) {
    return resolved;
  }

  const requestedAf = Number(params.get("af") || 0);
  if (!Number.isFinite(requestedAf) || requestedAf < 0 || requestedAf > 100) {
    return { body: `"s", "-2"`, source: "supabase:changeairfuel:invalid" };
  }

  const hasController = Boolean(
    findInstalledPartEntryBySlots(resolved.car.parts_xml || "", AFR_CONTROLLER_SLOT_IDS)
    || findTuneCarrierPartEntry(resolved.car.parts_xml || ""),
  );
  if (!hasController) {
    return { body: `"s", "-1"`, source: "supabase:changeairfuel:no-controller" };
  }

  try {
    const nextPartsXml = await persistCarTuneAttrs({
      supabase,
      accountCarId: resolved.accountCarId,
      car: resolved.car,
      attrs: { cs: String(requestedAf) },
      preferredSlotIds: AFR_CONTROLLER_SLOT_IDS,
    });
    if (!nextPartsXml) {
      return { body: `"s", "-4"`, source: "supabase:changeairfuel:no-carrier" };
    }
  } catch (error) {
    return { body: `"s", "-3"`, source: "supabase:changeairfuel:save-failed" };
  }

  return { body: `"s", 1`, source: "supabase:changeairfuel" };
}

async function handleChangeShiftLightRpm(context) {
  const { supabase, params } = context;
  const resolved = await resolveOwnedCarContext(context, "supabase:changeshiftlightrpm");
  if (!resolved?.ok) {
    return resolved;
  }

  const dynoState = getPersistedDynoState(resolved.car);
  const requestedRpm = Number(params.get("slr") || 0);
  if (!Number.isFinite(requestedRpm) || requestedRpm < 1000 || requestedRpm > Math.max(dynoState.redLine, 12000)) {
    return { body: `"s", "-2"`, source: "supabase:changeshiftlightrpm:invalid" };
  }

  try {
    const nextPartsXml = await persistCarTuneAttrs({
      supabase,
      accountCarId: resolved.accountCarId,
      car: resolved.car,
      attrs: { slr: String(Math.round(requestedRpm)), rl: String(dynoState.redLine) },
      preferredSlotIds: SHIFT_LIGHT_SLOT_IDS,
    });
    if (!nextPartsXml) {
      return { body: `"s", "-1"`, source: "supabase:changeshiftlightrpm:no-indicator" };
    }
  } catch (error) {
    return { body: `"s", "-3"`, source: "supabase:changeshiftlightrpm:save-failed" };
  }

  return {
    body: `"s", 1, "r", ${Math.round(requestedRpm)}`,
    source: "supabase:changeshiftlightrpm",
  };
}

async function handleBuyGears(context) {
  const { supabase, params } = context;
  const resolved = await resolveOwnedCarContext(context, "supabase:buygears");
  if (!resolved?.ok) {
    return resolved;
  }

  const player = await getPlayerById(supabase, resolved.caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buygears:no-player" };
  }

  const gearPrice = 2500;
  const newBalance = toFiniteNumber(player.money, 0) - gearPrice;
  if (newBalance < 0) {
    return { body: `"s", "-2"`, source: "supabase:buygears:insufficient-funds" };
  }

  const submittedRatios = {
    g1: params.get("g1") || "",
    g2: params.get("g2") || "",
    g3: params.get("g3") || "",
    g4: params.get("g4") || "",
    g5: params.get("g5") || "",
    g6: params.get("g6") || "0",
    fg: params.get("fg") || "",
  };

  if ([submittedRatios.g1, submittedRatios.g2, submittedRatios.g3, submittedRatios.g4, submittedRatios.g5, submittedRatios.fg].some((value) => value === "")) {
    return { body: `"s", "-4"`, source: "supabase:buygears:incomplete" };
  }

  const numericRatios = Object.fromEntries(
    Object.entries(submittedRatios).map(([key, value]) => [key, Number(value)]),
  );

  if (Object.values(numericRatios).some((value) => !Number.isFinite(value) || value < 0)) {
    return { body: `"s", "-3"`, source: "supabase:buygears:invalid" };
  }

  if (Object.values(numericRatios).some((value) => value > 10)) {
    return { body: `"s", "-6"`, source: "supabase:buygears:max-value" };
  }

  if (numericRatios.g1 < 2.5) {
    return { body: `"s", "-9"`, source: "supabase:buygears:first-too-low" };
  }

  const orderedForwardRatios = [numericRatios.g1, numericRatios.g2, numericRatios.g3, numericRatios.g4, numericRatios.g5];
  if (numericRatios.g6 > 0) {
    orderedForwardRatios.push(numericRatios.g6);
  }
  for (let index = 0; index < orderedForwardRatios.length - 1; index += 1) {
    if (orderedForwardRatios[index] <= orderedForwardRatios[index + 1]) {
      return { body: `"s", "-5"`, source: "supabase:buygears:wrong-order" };
    }
  }

  const defaultRatios = getDefaultGearRatiosForCar(resolved.car);
  const defaultHasSixth = Number(defaultRatios.g6) > 0;
  if (!defaultHasSixth && numericRatios.g6 > 0) {
    return { body: `"s", "-7"`, source: "supabase:buygears:no-sixth-gear" };
  }

  try {
    const nextPartsXml = await persistCarTuneAttrs({
      supabase,
      accountCarId: resolved.accountCarId,
      car: resolved.car,
      attrs: {
        g1: submittedRatios.g1,
        g2: submittedRatios.g2,
        g3: submittedRatios.g3,
        g4: submittedRatios.g4,
        g5: submittedRatios.g5,
        g6: defaultHasSixth ? submittedRatios.g6 : "0",
        fg: submittedRatios.fg,
      },
      preferredSlotIds: GEAR_TUNE_SLOT_IDS,
    });
    if (!nextPartsXml) {
      return { body: `"s", "-1"`, source: "supabase:buygears:no-engine" };
    }

    await updatePlayerMoney(supabase, resolved.caller.playerId, newBalance);
  } catch (error) {
    return { body: `"s", "-8"`, source: "supabase:buygears:save-failed" };
  }

  return { body: `"s", 2, "b", ${newBalance}`, source: "supabase:buygears" };
}

async function handlePractice(context) {
  const { supabase, logger, params } = context;
  const accountCarId = params.get("acid") || "";
  let car = null;
  let caller = null;

  if (!accountCarId) {
    return {
      body: failureBody(),
      source: "generated:practice:missing-car",
    };
  }

  if (supabase) {
    caller = await resolveCallerSessionWithPublicIdFallback(context, "supabase:practice");
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

  const tournamentSession = caller?.ok ? getComputerTournamentSessionForPlayer(Number(caller.playerId)) : null;
  const isTournamentPractice = !!tournamentSession
    && Number(accountCarId) === Number(tournamentSession.lastRequestedCarId || tournamentSession.activeCarId || 0);
  const enginePayload = buildDriveableEnginePayloadForCar(car);
  if (!enginePayload) {
    return {
      body: failureBody(),
      source: "generated:practice:unsupported-car",
    };
  }
  const { boostType, nosSize, engineTypeId } = getCarBuildFlags(car);
  const body = `"s", 1, "d", "${enginePayload.engineXml}", "t", [${enginePayload.timing.join(', ')}]`;

  logger?.info("Practice response", {
    carId: accountCarId,
    catalogCarId: String(car?.catalog_car_id || ""),
    engineTypeId,
    boostType,
    nosSize,
    bodyLength: body.length,
    isTournamentPractice,
  });

  return {
    body,
    source: isTournamentPractice ? "generated:practice:tournament" : "generated:practice",
  };
}

async function handlePracticeLifecycleAck(context, actionName) {
  const { supabase, params } = context;
  let caller = null;

  if (supabase) {
    caller = await resolveCallerSessionWithPublicIdFallback(context, `supabase:${actionName}`);
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

  if (actionName === "endpractice" && caller?.ok) {
    const tournamentSession = getComputerTournamentSessionForPlayer(Number(caller.playerId));
    const accountCarId = params.get("acid") || params.get("cid") || "";
    const raceTime = Number(params.get("et") || params.get("t") || 0);

    if (
      tournamentSession
      && Number(accountCarId) === Number(tournamentSession.lastRequestedCarId || tournamentSession.activeCarId || 0)
      && raceTime > 0
    ) {
      if (!tournamentSession.qualifyingTime) {
        tournamentSession.qualifyingTime = raceTime;
        tournamentSession.qualifyingComplete = true;
      } else {
        tournamentSession.currentRaceTime = raceTime;
      }
      bindComputerTournamentSession(tournamentSession);
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
const computerTournamentSessionsByPlayerId = new Map();
const COMPUTER_TOURNAMENT_ROUNDS_TO_WIN = 5;
const COMPUTER_TOURNAMENT_CAR_POOLS = {
  1: [1, 3, 4, 8, 10, 14, 18, 28],
  2: [11, 15, 16, 17, 19, 20, 21, 22],
  3: [41, 42, 50, 55, 57, 58, 67, 76],
};

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

function computeComputerTournamentBracketTime(horsepower, weight) {
  return Math.round(Math.pow(Number(weight || 0) / Math.max(Number(horsepower || 1), 1), 1 / 3) * 5.825 * 1000) / 1000;
}

function buildComputerTournamentSessionKey(playerId) {
  return `player:${Number(playerId || 0)}`;
}

function isLegacyDialTournamentKey(tournamentKey) {
  return /^\d{1,4}$/.test(String(tournamentKey || "").trim());
}

function bindComputerTournamentSession(session) {
  if (!session?.sessionKey) {
    return session;
  }

  computerTournamentSessions.set(session.sessionKey, session);

  if (Number.isFinite(Number(session.playerId)) && Number(session.playerId) > 0) {
    computerTournamentSessionsByPlayerId.set(Number(session.playerId), session);
  }

  return session;
}

function clearComputerTournamentSession(session) {
  const sessionKey = String(session?.sessionKey || "");
  const playerId = Number(session?.playerId || 0);

  if (sessionKey) {
    computerTournamentSessions.delete(sessionKey);
  }
  if (playerId > 0) {
    computerTournamentSessionsByPlayerId.delete(playerId);
  }
}

function getBoundComputerTournamentSession({ tournamentKey, playerId }) {
  const normalizedTournamentKey = String(tournamentKey || "").trim();
  const legacyDialKey = isLegacyDialTournamentKey(normalizedTournamentKey);

  if (normalizedTournamentKey && !legacyDialKey && computerTournamentSessions.has(normalizedTournamentKey)) {
    return computerTournamentSessions.get(normalizedTournamentKey);
  }

  const numericPlayerId = Number(playerId || 0);
  if (numericPlayerId > 0) {
    const playerSession = getComputerTournamentSessionForPlayer(numericPlayerId);
    if (playerSession) {
      return playerSession;
    }

    const playerSessionKey = buildComputerTournamentSessionKey(numericPlayerId);
    if (computerTournamentSessions.has(playerSessionKey)) {
      return computerTournamentSessions.get(playerSessionKey);
    }
  }

  if (normalizedTournamentKey && computerTournamentSessions.has(normalizedTournamentKey)) {
    return computerTournamentSessions.get(normalizedTournamentKey);
  }

  return null;
}

function resolveComputerTournamentOpponentIndex(session, requestedOpponentId) {
  const fallbackIndex = Number(session?.wins || 0) % 32;
  const tournament = getComputerTournamentDefinition(session?.tournamentId);
  const numericRequestedId = Number(requestedOpponentId || 0);

  if (!Number.isFinite(numericRequestedId) || numericRequestedId <= 0) {
    return fallbackIndex;
  }

  const parsePrefixedId = (baseId) => {
    if (numericRequestedId < baseId) {
      return null;
    }

    const rawId = numericRequestedId - baseId;
    const requestedTournamentId = Math.floor(rawId / 100);
    const opponentIndex = rawId % 100;
    if (requestedTournamentId !== Number(tournament.id)) {
      return null;
    }
    if (opponentIndex < 0 || opponentIndex >= 32) {
      return null;
    }
    return opponentIndex;
  };

  for (const baseId of [1000, 2000, 6000]) {
    const parsedIndex = parsePrefixedId(baseId);
    if (parsedIndex !== null) {
      return parsedIndex;
    }
  }

  const looseIndex = numericRequestedId % 100;
  if (looseIndex >= 0 && looseIndex < 32) {
    return looseIndex;
  }

  return fallbackIndex;
}

function getComputerTournamentOpponentProfile(session, requestedOpponentId) {
  const tournament = getComputerTournamentDefinition(session?.tournamentId);
  const opponentIndex = resolveComputerTournamentOpponentIndex(session, requestedOpponentId);
  const seedBase = Number(tournament.id) * 300 + opponentIndex * 19;
  const horsepower = Math.round(interpolate(tournament.minHp, tournament.maxHp, seededFraction(seedBase + 1)));
  const weight = Math.round(interpolate(tournament.minWeight, tournament.maxWeight, seededFraction(seedBase + 2)));
  const reactionTime = interpolate(tournament.minRt, tournament.maxRt, seededFraction(seedBase + 3));
  const elapsedTime = interpolate(tournament.minEt, tournament.maxEt, seededFraction(seedBase + 4));
  const trapSpeed = interpolate(tournament.minTrap, tournament.maxTrap, seededFraction(seedBase + 5));
  const bracketTime = computeComputerTournamentBracketTime(horsepower, weight);
  const competitorId = 1000 + Number(tournament.id) * 100 + opponentIndex;
  const competitorCarId = 2000 + Number(tournament.id) * 100 + opponentIndex;
  const virtualCarId = 6000 + Number(tournament.id) * 100 + opponentIndex;
  const username = `${tournament.type} ${String(opponentIndex + 1).padStart(2, "0")}`;

  const raceSpec = buildCarRaceSpec({
    horsepower,
    weightLbs: weight,
    drivetrainStr: Number(tournament.id) >= 3 ? "RWD" : "FWD",
    transmissionStr: Number(tournament.id) >= 2 ? "6-speed manual" : "5-speed manual",
    bodyTypeStr: "Coupe",
    estimatedEt: elapsedTime,
  });

  return {
    opponentIndex,
    purse: Number(tournament.purse || 0) * (Number(session?.wins || 0) + 1),
    competitorId,
    competitorCarId,
    virtualCarId,
    username,
    horsepower,
    weight,
    reactionTime,
    elapsedTime,
    trapSpeed,
    bracketTime,
    pp: simulateRun(raceSpec).join(","),
  };
}

function buildLegacyRaceChatUsersXml(roomPlayers = []) {
  const usersXml = roomPlayers
    .filter((player) => Number(player?.playerId || 0) > 0 && String(player?.username || "").length > 0)
    .map((player) => {
      const clientRole = Number(player?.clientRole || 0);
      let tf = "7D7D7D";
      if (clientRole === 1) tf = "FF0000";
      else if (clientRole === 2) tf = "66CCFF";
      else if (clientRole === 8) tf = "0000FF";
      else if (clientRole === 6) tf = "00AA00";

      return (
        `<u i='${Number(player.playerId)}' un='${escapeXml(player.username)}' ` +
        `ti='${Number(player.teamId || 0)}' tid='${Number(player.teamId || 0)}' ` +
        `tf='${tf}' ms='${Number(player.clientRole || 5)}' iv='0'/>`
      );
    })
    .join("");

  return `<ul>${usersXml}</ul>`;
}

async function handleListRaceChatUsers(context) {
  const { services } = context;
  const caller = await resolveCallerSession(context, "generated:listracechatusers");
  if (!caller?.ok) {
    return caller;
  }

  const tcpServer = services?.tcpServer;
  if (!tcpServer?.connections || !tcpServer?.rooms) {
    return {
      body: wrapSuccessData("<ul></ul>"),
      source: "generated:listracechatusers:no-tcp",
    };
  }

  const activeConn = [...tcpServer.connections.values()].find(
    (candidate) => Number(candidate?.playerId || 0) === Number(caller.playerId),
  );
  const roomId = Number(activeConn?.roomId || 0);
  const roomPlayers = roomId > 0 ? tcpServer.rooms.get(roomId) || [] : [];

  return {
    body: wrapSuccessData(buildLegacyRaceChatUsersXml(roomPlayers)),
    source: roomId > 0 ? `generated:listracechatusers:room=${roomId}` : "generated:listracechatusers:no-room",
  };
}

function buildComputerTournamentVirtualCar(gameCarId) {
  const numericId = Number(gameCarId || 0);
  if (numericId < 6000 || numericId >= 7000) {
    return null;
  }

  const tournamentId = Math.floor((numericId - 6000) / 100);
  const opponentIndex = (numericId - 6000) % 100;
  const carPool = COMPUTER_TOURNAMENT_CAR_POOLS[tournamentId] || [1];
  const catalogCarId = carPool[opponentIndex % carPool.length] || carPool[0] || 1;
  const tournament = getComputerTournamentDefinition(tournamentId);
  const fallbackCatalogCar = FULL_CAR_CATALOG.find((entry) => Number(entry.id) === Number(catalogCarId)) || FULL_CAR_CATALOG[0] || { id: 1 };

  return {
    game_car_id: numericId,
    account_car_id: numericId,
    catalog_car_id: Number(fallbackCatalogCar.id || catalogCarId || 1),
    selected: 0,
    plate_name: "",
    locked: 0,
    color_code: "FFFFFF",
    image_index: 0,
    wheel_xml: getDefaultWheelXmlForCar(Number(fallbackCatalogCar.id || catalogCarId || 1)),
    parts_xml: getDefaultPartsXmlForCar(Number(fallbackCatalogCar.id || catalogCarId || 1)),
    horsepower: 0,
    weight: 0,
    transmission_type: Number(tournamentId) >= 2 ? "6-speed manual" : "5-speed manual",
    drivetrain: Number(tournamentId) >= 3 ? "RWD" : "FWD",
    engine_type_id: 1,
    test_drive_active: 0,
    test_drive_expired: 0,
    test_drive_invitation_id: 0,
    test_drive_name: tournament?.name || "Computer Tournament",
    test_drive_money_price: 0,
    test_drive_point_price: 0,
    test_drive_hours_remaining: 0,
  };
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
  const competitorCarId = 2000 + Number(tournament.id) * 100 + index;
  const racerNumber = 100 + index;
  const username = `${tournament.type} ${String(index + 1).padStart(2, "0")}`;

  return (
    `<r id='${competitorId}' i='${competitorCarId}' caid='${competitorCarId}' n='${escapeXml(username)}' u='${escapeXml(username)}' ` +
    `bt='${formatMetric(totalTime)}' rt='${formatMetric(reactionTime)}' et='${formatMetric(elapsedTime)}' ts='${formatMetric(trapSpeed, 2)}' ` +
    `total='${formatMetric(totalTime)}' racerNum='${racerNumber}' type='C' hp='${horsepower}' w='${weight}'/>`
  );
}

function buildComputerTournamentFieldXml(tournamentId) {
  const tournament = getComputerTournamentDefinition(tournamentId);
  const competitorsXml = Array.from({ length: 32 }, (_, index) =>
    buildComputerTournamentCompetitorNode(tournament, index)
  ).join("");
  return `<n2>${competitorsXml}</n2>`;
}

function buildComputerTournamentQualifySeedXml(session) {
  const publicId = Number(session?.publicId || session?.playerId || 0);
  const activeCarId = Number(session?.activeCarId || 0);
  if (publicId <= 0 || activeCarId <= 0) {
    return "";
  }

  const bracketTime = Number(session?.bracketTime || 0);
  const formattedBracketTime = Number.isFinite(bracketTime) && bracketTime > 0
    ? formatMetric(bracketTime)
    : "0";

  // Match native RN queue seed shape used by the TCP flow.
  // Keep lane-2 neutral (0) so ctct does not hijack tournament opponent state
  // before the dedicated ctrt callback provides the real opponent.
  return (
    `<q><r i='${publicId}' icid='${activeCarId}' ` +
    `ci='0' cicid='0' bt='${formattedBracketTime}' b='0'/></q>`
  );
}

function buildComputerTournamentOpponentXml(session, requestedOpponentId) {
  const opponent = getComputerTournamentOpponentProfile(session, requestedOpponentId);
  const bracketRefId = Number(requestedOpponentId || 0) > 0
    ? Number(requestedOpponentId)
    : Number(opponent.competitorCarId || opponent.competitorId || 0);
  const baseBracketTime = Number(session?.bracketTime || 0);
  const bkDiff = Number.isFinite(baseBracketTime) && baseBracketTime > 0
    ? Number(formatMetric(baseBracketTime - opponent.bracketTime))
    : 0;

  return {
    ...opponent,
    bkDiff,
    xml:
      `<r id='${bracketRefId}' i='${opponent.virtualCarId}' cid='${bracketRefId}' ` +
      `caid='${opponent.competitorCarId}' cacid='${opponent.virtualCarId}' ` +
      `n='${escapeXml(opponent.username)}' u='${escapeXml(opponent.username)}' ` +
      `bt='${formatMetric(opponent.bracketTime)}' rt='${formatMetric(opponent.reactionTime)}' ` +
      `et='${formatMetric(opponent.elapsedTime)}' ts='${formatMetric(opponent.trapSpeed, 2)}' p='${opponent.purse}' ` +
      `pp='${opponent.pp}' hp='${opponent.horsepower}' w='${opponent.weight}' type='C'/>`,
  };
}

function buildComputerTournamentSyntheticUser(session, publicId) {
  const numericPublicId = Number(publicId || 0);
  if (!session || numericPublicId <= 0) {
    return null;
  }

  const tournament = getComputerTournamentDefinition(session.tournamentId || 1);
  const tournamentId = Number(tournament.id || session.tournamentId || 1);
  const tournamentDialKey = Number(session?.tournamentDialKey || session?.lastTournamentCode || 0);
  const accountCarBase = 2000 + tournamentId * 100;
  const competitorBase = 1000 + tournamentId * 100;
  const accountCarIndex = numericPublicId - accountCarBase;
  const competitorIndex = numericPublicId - competitorBase;
  const isTournamentKeyUser = tournamentDialKey > 0 && numericPublicId === tournamentDialKey;
  const isBracketAccountCarUser = accountCarIndex >= 0 && accountCarIndex < 32;
  const isBracketCompetitorUser = competitorIndex >= 0 && competitorIndex < 32;

  if (!isTournamentKeyUser && !isBracketAccountCarUser && !isBracketCompetitorUser) {
    return null;
  }

  const displayNumber = isTournamentKeyUser
    ? String(numericPublicId).padStart(2, "0")
    : String((isBracketAccountCarUser ? accountCarIndex : competitorIndex) + 1).padStart(2, "0");
  return {
    id: numericPublicId,
    username: `${tournament.type || "tourneyA"} ${displayNumber}`,
    client_role: 5,
    score: 0,
    title_id: 0,
    team_id: 0,
    team_name: "",
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
  const username = String(
    params.get("st") || params.get("u") || params.get("un") || params.get("username") || "",
  ).replace(/[\r\n\t]+/g, " ").trim();

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
  const { supabase, params, logger } = context;
  const supportId = Number(params.get("sid") || 0);
  const callId = Number(params.get("i") || 0);
  const offenderUsername = String(params.get("offun") || "").trim();
  const playerName = String(params.get("pn") || "").trim();
  const notes1 = String(params.get("n1") || "").trim();
  const notes2 = String(params.get("n2") || "").trim();
  const email = String(params.get("em") || "").trim();
  const ticketNumber = String(Date.now()).slice(-8);
  const subject = offenderUsername || playerName || email || "support";
  const detail = notes1 || notes2 || `Support request ${supportId}`;
  const message = `Submitted ${subject}: ${detail}`.slice(0, 240);
  let source = `generated:getsupport:sid=${supportId}`;

  if (supabase) {
    try {
      let callerPlayer = null;
      const aid = Number(params.get("aid") || 0);
      const sk = String(params.get("sk") || "");
      if (aid > 0 && sk && sk !== "undefined") {
        const caller = await resolveCallerSession(context, "supabase:getsupport");
        if (caller?.ok) {
          callerPlayer = caller.player;
        }
      }

      const offenderPlayer = offenderUsername ? await getPlayerByUsername(supabase, offenderUsername) : null;
      const requesterUsername = playerName || callerPlayer?.username || "";
      const { error } = await supabase.from("game_support_tickets").insert({
        ticket_number: ticketNumber,
        support_id: supportId,
        requester_player_id: callerPlayer?.id || null,
        requester_username: requesterUsername,
        requester_email: email,
        offender_player_id: offenderPlayer?.id || null,
        offender_username: offenderUsername || offenderPlayer?.username || "",
        subject,
        detail_primary: notes1,
        detail_secondary: notes2,
        status: "open",
        resolution: "",
      });

      if (error) {
        throw error;
      }

      source = `supabase:getsupport:sid=${supportId}`;
    } catch (error) {
      logger?.warn("GetSupport persistence unavailable", {
        error: error?.message || String(error || ""),
        supportId,
      });
      source = `generated:getsupport:sid=${supportId}:fallback`;
    }
  }

  return {
    body: `"s", 1, "m", "${escapeXml(message)}", "i", ${callId}, "t", "${ticketNumber}"`,
    source,
  };
}

async function handleGetMisconductCount(context) {
  const { supabase, params, logger } = context;
  const offenderAccountId = Number(params.get("oid") || params.get("id") || 0);
  let openReports = 0;
  let totalBanned = 0;

  if (supabase && offenderAccountId > 0) {
    try {
      const [{ count: openCount, error: openError }, { count: bannedCount, error: bannedError }] = await Promise.all([
        supabase
          .from("game_support_tickets")
          .select("id", { count: "exact", head: true })
          .eq("offender_player_id", offenderAccountId)
          .eq("status", "open"),
        supabase
          .from("game_support_tickets")
          .select("id", { count: "exact", head: true })
          .eq("offender_player_id", offenderAccountId)
          .eq("resolution", "banned"),
      ]);

      if (openError) throw openError;
      if (bannedError) throw bannedError;

      openReports = Number(openCount || 0);
      totalBanned = Number(bannedCount || 0);
    } catch (error) {
      logger?.warn("GetMisconductCount persistence unavailable", {
        error: error?.message || String(error || ""),
        offenderAccountId,
      });
    }
  }

  return {
    body: `"id", ${offenderAccountId}, "r", ${openReports}, "b", ${totalBanned}`,
    source: supabase ? "supabase:getmisconductcount" : "generated:getmisconductcount",
  };
}

async function handleGetDescription(context) {
  const partId = Number(context.params.get("id") || 0);
  const partType = String(context.params.get("pt") || "").trim().toLowerCase();
  const catalog = partType === "w" ? getWheelsTiresCatalogById() : getPartsCatalogById();
  const attrs = catalog.get(partId) || null;
  const asNumber = (value) => {
    const numeric = Number(value || 0);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const parts = [];
  if (attrs) {
    const name = decodeXmlEntities(attrs.n || "");
    const brand = decodeXmlEntities(attrs.bn || "");
    const family = decodeXmlEntities(attrs.mn || "");
    const hp = asNumber(attrs.hp);
    const tq = asNumber(attrs.tq);
    const wt = asNumber(attrs.wt);
    const money = asNumber(attrs.p);
    const points = asNumber(attrs.pp);

    if (name) parts.push(name);
    if (brand || family) {
      parts.push([brand, family].filter(Boolean).join(" "));
    }
    const stats = [];
    if (hp) stats.push(`+${hp} HP`);
    if (tq) stats.push(`+${tq} TQ`);
    if (wt) stats.push(`${wt > 0 ? "+" : ""}${wt} WT`);
    if (money) stats.push(`$${money}`);
    if (points) stats.push(`${points} pts`);
    if (stats.length) {
      parts.push(stats.join(" | "));
    }
  }

  return {
    body: wrapSuccessData(
      `<d>${escapeXml(parts.join(" - ") || `No description available for ${partType || "part"} ${partId}.`)}</d>`,
    ),
    source: attrs ? `generated:getdescription:id=${partId}` : `generated:getdescription:id=${partId}:fallback`,
  };
}

async function handleGetBuddies(context) {
  const targetId = Number(context.params.get("tid") || context.params.get("id") || 0);
  return {
    body: wrapSuccessData(`<buddies></buddies>`),
    source: `generated:getbuddies:tid=${targetId || 0}`,
  };
}

async function handleGetLocations() {
  return {
    body: `"s", 1, "d", "${STATIC_LOCATIONS_ACTION_XML}"`,
    source: "generated:getlocations",
  };
}

async function handleGetInfo(context) {
  const { supabase, params, logger } = context;
  if (!supabase) {
    return {
      body: `"s", 1, "d", "<ini></ini>"`,
      source: "generated:getinfo:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:getinfo");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getinfo:bad-session" };
  }

  const [playerRecord, cars] = await Promise.all([
    getPlayerById(supabase, caller.playerId),
    listCarsForPlayer(supabase, caller.playerId),
  ]);

  if (!playerRecord) {
    return { body: failureBody(), source: "supabase:getinfo:no-player" };
  }

  const player = await recoverPlayerLoginBalances(supabase, playerRecord, logger);
  const sessionKey = params.get("sk") || "";
  const infoXml = extractInfoXmlFromLoginBody(buildLoginBody(player, cars || [], null, sessionKey, logger));
  return {
    body: `"s", 1, "d", "${infoXml}"`,
    source: "supabase:getinfo",
  };
}

async function handleGetHumanTournaments(context) {
  const { services } = context;
  const tcpServer = services?.tcpServer;
  const liveEvent = typeof tcpServer?.getLiveTournamentEvent === "function"
    ? tcpServer.getLiveTournamentEvent()
    : null;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const event = {
    id: Number(liveEvent?.id || 9001),
    scheduleId: Number(liveEvent?.scheduleId || 4),
    startsAt: Number(liveEvent?.startsAt || nowSeconds),
    qualifyingEndsAt: Number(liveEvent?.qualifyingEndsAt || nowSeconds + 1800),
    purse: Number(liveEvent?.purse || 5000),
    entryType: String(liveEvent?.entryType || "f"),
    entryCost: Number(liveEvent?.entryCost || 0),
    bracketDialIn: Number(liveEvent?.bracketDialIn || 0),
    status: Number(liveEvent?.status || 2),
    maxPlayers: Number(liveEvent?.maxPlayers || 32),
  };

  const entryRequirements = "Free to enter. Everyone welcome. Any car may be used to race.";
  const description = "Live tournament qualifying is open. Race for a bracket spot or spectate the current event.";
  const xml =
    `<n2 ut='${nowSeconds}'>` +
    `<e i='${event.id}' it='${event.scheduleId}' b='${event.bracketDialIn}' s='${event.status}' ` +
    `d='${event.startsAt}' de='${event.qualifyingEndsAt}' ct='${event.entryType}' c='${event.entryCost}' ` +
    `mp='${event.maxPlayers}' pp='${event.purse}'>` +
    `<er><![CDATA[${entryRequirements}]]></er>` +
    `<de><![CDATA[${description}]]></de>` +
    `</e>` +
    `</n2>`;

  logTournamentPayload(context.logger, "gethumantournaments", xml, {
    eventId: event.id,
    scheduleId: event.scheduleId,
    status: event.status,
  });

  return {
    body: wrapSuccessData(xml),
    source: "generated:gethumantournaments",
  };
}

async function handleJoinHumanTournament(context) {
  const { supabase, params, services, logger } = context;
  if (!supabase) {
    return {
      body: `"s", 0, "b", 0, "d", "Tournament service unavailable."`,
      source: "generated:joinhumantournament:no-supabase",
    };
  }

  const caller = await resolveCallerSession(context, "supabase:joinhumantournament");
  if (!caller?.ok) {
    return {
      body: `"s", 0, "b", 0, "d", "Your session has expired."`,
      source: caller?.source || "supabase:joinhumantournament:bad-session",
    };
  }

  const tcpServer = services?.tcpServer;
  const liveEvent = typeof tcpServer?.getLiveTournamentEvent === "function"
    ? tcpServer.getLiveTournamentEvent()
    : null;
  const requestedTournamentId = Number(params.get("tid") || 0);
  const eventId = Number(liveEvent?.id || 9001);
  if (requestedTournamentId && requestedTournamentId !== eventId) {
    const balance = toFiniteNumber(caller.player.money, 0);
    return {
      body: `"s", 0, "b", ${balance}, "d", "This tournament is no longer available."`,
      source: "supabase:joinhumantournament:invalid-event",
    };
  }

  const gameCarId = Number(params.get("acid") || 0);
  const car = await getCarById(supabase, gameCarId);
  if (!car || Number(car.player_id) !== caller.playerId) {
    const balance = toFiniteNumber(caller.player.money, 0);
    return {
      body: `"s", 0, "b", ${balance}, "d", "That car is not available for entry."`,
      source: "supabase:joinhumantournament:invalid-car",
    };
  }

  const paymentType = String(params.get("pt") || liveEvent?.entryType || "m").trim().toLowerCase();
  const chargePoints = paymentType === "p";
  const entryCost = Math.max(0, Number(liveEvent?.entryCost || 0));
  const currentMoney = toFiniteNumber(caller.player.money, 0);
  const currentPoints = toFiniteNumber(caller.player.points, 0);
  const currentBalance = chargePoints ? currentPoints : currentMoney;
  const statusCode = chargePoints ? 1 : 2;

  if (entryCost > currentBalance) {
    return {
      body: `"s", 0, "b", ${currentBalance}, "d", "You do not have enough ${chargePoints ? "points" : "cash"} to enter."`,
      source: `supabase:joinhumantournament:insufficient-${chargePoints ? "points" : "money"}`,
    };
  }

  const newBalance = currentBalance - entryCost;
  if (chargePoints) {
    await updatePlayerRecord(supabase, caller.playerId, { points: newBalance });
  } else {
    await updatePlayerMoney(supabase, caller.playerId, newBalance);
  }
  await updatePlayerDefaultCar(supabase, caller.playerId, gameCarId);

  if (typeof tcpServer?.getLiveTournamentState === "function") {
    const liveState = tcpServer.getLiveTournamentState({
      playerId: caller.playerId,
      username: caller.player?.username || `Player ${caller.playerId}`,
    });
    if (Array.isArray(liveState?.roster) && liveState.roster.length > 0) {
      liveState.roster[0] = {
        id: Number(caller.playerId),
        username: caller.player?.username || `Player ${caller.playerId}`,
        rt: Number(liveState.roster[0]?.rt || 0.548),
        et: Number(liveState.roster[0]?.et || 14.882),
        bt: Number(params.get("bt") || liveState.roster[0]?.bt || 0),
      };
      liveState.createdAt = Date.now();
    }
  }

  const responseBody = `"s", ${statusCode}, "b", ${newBalance}, "d", ""`;
  logTournamentPayload(logger, "joinhumantournament", responseBody, {
    playerId: caller.playerId,
    tournamentId: eventId,
    gameCarId,
    paymentType,
    entryCost,
    newBalance,
  });

  return {
    body: responseBody,
    source: "supabase:joinhumantournament",
  };
}

async function handleUpdateBg(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 1`, source: "generated:updatebg:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:updatebg");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:updatebg:bad-session" };
  }

  const backgroundId = Number(params.get("bg") || 1);
  await updatePlayerRecord(supabase, caller.playerId, { backgroundId });
  return {
    body: `"s", 1`,
    source: "supabase:updatebg",
  };
}

async function handleSellCarPart(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", -1, "b", 0`, source: "generated:sellcarpart:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:sellcarpart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:sellcarpart:bad-session" };
  }

  const accountPartId = String(params.get("acpid") || "");
  if (!accountPartId) {
    return { body: `"s", -1, "b", 0`, source: "supabase:sellcarpart:missing-id" };
  }

  const cars = await listCarsForPlayer(supabase, caller.playerId);
  let targetCar = null;
  let installedPart = null;
  for (const car of cars) {
    const match = findInstalledPartByAi(car.parts_xml || "", accountPartId);
    if (match) {
      targetCar = car;
      installedPart = match;
      break;
    }
  }

  if (!targetCar || !installedPart) {
    return { body: `"s", -1, "b", 0`, source: "supabase:sellcarpart:not-found" };
  }

  const partId = Number(installedPart.attrs?.i || 0);
  const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
  const slotId = String(installedPart.attrs?.pi || installedPart.attrs?.ci || "");
  if (!catalogPart) {
    return { body: `"s", -1, "b", 0`, source: "supabase:sellcarpart:no-catalog-part" };
  }

  if (slotId && findInstalledPartBySlotId(getDefaultPartsXmlForCar(targetCar.catalog_car_id), slotId)) {
    const player = await getPlayerById(supabase, caller.playerId);
    return { body: `"s", -2, "b", ${toFiniteNumber(player?.money, 0)}`, source: "supabase:sellcarpart:stock-part" };
  }

  const sellValue = Math.max(1, Math.round(Number(catalogPart.p || 0) * 0.5));
  const player = await getPlayerById(supabase, caller.playerId);
  const newBalance = toFiniteNumber(player?.money, 0) + sellValue;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  await saveCarPartsXml(supabase, targetCar.game_car_id, removeInstalledPartByAi(targetCar.parts_xml || "", accountPartId));

  return {
    body: `"s", 1, "b", ${newBalance}`,
    source: "supabase:sellcarpart",
  };
}

async function handleGetRepairParts(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 1, "d", "<parts/>"`, source: "generated:getrepairparts:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:getrepairparts");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getrepairparts:bad-session" };
  }

  const accountCarId = Number(params.get("acid") || 0);
  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: `"s", 0, "d", "<parts/>"`, source: "supabase:getrepairparts:no-car" };
  }

  return {
    body: `"s", 1, "d", "${buildRepairPartsXml(car)}"`,
    source: "supabase:getrepairparts",
  };
}

async function handleRepairParts(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return { body: `"s", 0`, source: "generated:repairparts:no-supabase" };
  }

  const caller = await resolveCallerSession(context, "supabase:repairparts");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:repairparts:bad-session" };
  }

  const accountCarId = Number(params.get("acid") || 0);
  const repairIds = String(params.get("aepids") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: `"s", 0`, source: "supabase:repairparts:no-car" };
  }

  const repairXml = buildRepairPartsXml(car);
  const repairEntries = collectInstalledPartEntries(repairXml)
    .filter((entry) => repairIds.includes(String(entry?.attrs?.i || "")));
  const totalCost = repairEntries.reduce((sum, entry) => sum + Number(entry?.attrs?.p || 0), 0);
  const player = await getPlayerById(supabase, caller.playerId);
  const currentMoney = toFiniteNumber(player?.money, 0);
  if (totalCost > currentMoney) {
    return { body: `"s", -1`, source: "supabase:repairparts:insufficient-funds" };
  }

  const newBalance = currentMoney - totalCost;
  await updatePlayerMoney(supabase, caller.playerId, newBalance);
  return {
    body: `"s", 1, "b", ${newBalance}`,
    source: "supabase:repairparts",
  };
}

async function handleCompletePollQuestion(context) {
  const { logger, params, services } = context;
  const caller = await resolveCallerSession(context, "supabase:completepollquestion");
  if (!caller?.ok) {
    return caller;
  }

  const surveyId = Number(
    params.get("sid") || params.get("ssid") || params.get("surveyid") || params.get("surveyId"),
  );
  const answerId = Number(params.get("said") || params.get("oid") || params.get("answerid") || params.get("answerId"));
  const questionId = Number(params.get("sqid") || params.get("qid") || params.get("questionid") || params.get("questionId"));
  const pollState = services?.homePollState;

  if (!pollState) {
    logger.warn("Home poll submission ignored because poll state is unavailable", {
      playerId: caller.playerId,
      publicId: caller.publicId,
      surveyId: Number.isFinite(surveyId) && surveyId > 0 ? surveyId : null,
      answerId: Number.isFinite(answerId) && answerId > 0 ? answerId : null,
      questionId: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
    });

    return {
      body: `"s", -1`,
      source: "generated:completepollquestion:missing-state",
    };
  }

  const submission = pollState.submitAnswer({
    playerId: caller.playerId,
    surveyId,
    questionId,
    answerId,
  });

  logger.info("Home poll submission processed", {
    playerId: caller.playerId,
    publicId: caller.publicId,
    surveyId: Number.isFinite(surveyId) && surveyId > 0 ? surveyId : null,
    answerId: Number.isFinite(answerId) && answerId > 0 ? answerId : null,
    questionId: Number.isFinite(questionId) && questionId > 0 ? questionId : null,
    ok: submission.ok,
    code: submission.code,
    reason: submission.reason,
  });

  return {
    body: `"s", ${submission.code}`,
    source: `generated:completepollquestion:${submission.reason}`,
  };
}

function buildInactiveElectionScheduleXml() {
  const now = Math.floor(Date.now() / 1000);
  const day = 24 * 60 * 60;
  const mk = (offsetDays) => String(now + offsetDays * day);
  return (
    `<e>` +
    `<q>1</q>` +
    `<nomdates>Check back later</nomdates>` +
    `<eliminationdates>Check back later</eliminationdates>` +
    `<finalvotedates>Check back later</finalvotedates>` +
    `<currentdate>${mk(0)}</currentdate>` +
    `<promobeg>${mk(-7)}</promobeg>` +
    `<promoend>${mk(-6)}</promoend>` +
    `<nomclosedbeg>${mk(-5)}</nomclosedbeg>` +
    `<nomclosedend>${mk(-4)}</nomclosedend>` +
    `<nomannouncebeg>${mk(-3)}</nomannouncebeg>` +
    `<nomannounceend>${mk(-2)}</nomannounceend>` +
    `<nombeg>${mk(-1)}</nombeg>` +
    `<nomend>${mk(0)}</nomend>` +
    `<voting>` +
    `<1>` +
    `<interviewbeg>${mk(1)}</interviewbeg><interviewend>${mk(2)}</interviewend>` +
    `<votingbeg>${mk(3)}</votingbeg><votingend>${mk(4)}</votingend>` +
    `<votingclosedbeg>${mk(5)}</votingclosedbeg><votingclosedend>${mk(6)}</votingclosedend>` +
    `<votingresults>${mk(7)}</votingresults>` +
    `</1>` +
    `<2>` +
    `<interviewbeg>${mk(8)}</interviewbeg><interviewend>${mk(9)}</interviewend>` +
    `<votingbeg>${mk(10)}</votingbeg><votingend>${mk(11)}</votingend>` +
    `<votingclosedbeg>${mk(12)}</votingclosedbeg><votingclosedend>${mk(13)}</votingclosedend>` +
    `<votingresults>${mk(14)}</votingresults>` +
    `</2>` +
    `<3>` +
    `<interviewbeg>${mk(15)}</interviewbeg><interviewend>${mk(16)}</interviewend>` +
    `<votingbeg>${mk(17)}</votingbeg><votingend>${mk(18)}</votingend>` +
    `<votingclosedbeg>${mk(19)}</votingclosedbeg><votingclosedend>${mk(20)}</votingclosedend>` +
    `<votingresults>${mk(21)}</votingresults>` +
    `</3>` +
    `</voting>` +
    `</e>`
  );
}

async function handleGetElectionPhase(context) {
  const requestedId = Number(context.params.get("i") || 1) || 1;
  return {
    body: `"s", 0, "phase", 0, "timeRemainingInPhase", 0, "i", ${requestedId}`,
    source: "generated:getelectionphase:inactive",
  };
}

async function handleGetElectionSchedule() {
  return {
    body: wrapSuccessData(buildInactiveElectionScheduleXml()),
    source: "generated:getelectionschedule:inactive",
  };
}

async function handleGetNominateCount() {
  return {
    body: `"c", 0`,
    source: "generated:getnominatecount:inactive",
  };
}

async function handleNominate() {
  return {
    body: `"s", 0, "e", "No active election."`,
    source: "generated:nominate:inactive",
  };
}

async function handleGetElectionResult() {
  return {
    body: wrapSuccessData(`<r s='0'><e>No active election.</e></r>`),
    source: "generated:getelectionresult:inactive",
  };
}

async function handleElectionVote() {
  return {
    body: `"s", 0, "e", "No active election."`,
    source: "generated:electionvote:inactive",
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

  const [teams, players, members] = await Promise.all([
    listTeamsByIds(supabase, teamIds),
    listPlayersForTeams(supabase, teamIds),
    listTeamMembersForTeams(supabase, teamIds),
  ]);

  if (teams.length === 0) {
    return {
      body: wrapSuccessData("<teams></teams>"),
      source: "supabase:teaminfo:not-found",
    };
  }

  const playersByTeamId = groupPlayersByTeamId(players);
  const membersByTeamId = new Map();
  for (const member of members) {
    const teamId = Number(member.team_id || 0);
    if (!membersByTeamId.has(teamId)) {
      membersByTeamId.set(teamId, []);
    }
    membersByTeamId.get(teamId).push(member);
  }

  return {
    body: wrapSuccessData(renderTeamsWithMetadata(teams, playersByTeamId, membersByTeamId, services)),
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
  getonecar: handleGetOneCar,
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
  buygears: handleBuyGears,
  buydyno: handleBuyDyno,
  changeboost: handleChangeBoost,
  changeairfuel: handleChangeAirFuel,
  changeshiftlightrpm: handleChangeShiftLightRpm,
  loaddynograph: async () => {
    return {
      body: `"s", 1, "d", "<dyno/>"`,
      source: "generated:loaddynograph",
    };
  },
  savedynograph: async () => {
    return {
      body: `"s", 1`,
      source: "generated:savedynograph",
    };
  },
  buypart: handleBuyPart,
  buyenginepart: handleBuyEnginePart,
  buyengine: handleBuyEngine,
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
  setnondeletes: async () => ({ body: `"s", 1`, source: "generated:setnondeletes" }),
  setdeletes: async () => ({ body: `"s", 1`, source: "generated:setdeletes" }),
  // Repair
  getrepairparts: handleGetRepairParts,
  repairparts: handleRepairParts,
  // Garage / parts bin
  getcarpartsbin: handleGetCarPartsBinImpl,
  getpartsbin: handleGetPartsBinImpl,
  sellcarpart: handleSellCarPart,
  sellenginepart: handleSellEnginePart,
  sellengine: handleSellEngine,
  installpart: handleInstallPartImpl,
  uninstallpart: handleUninstallPartImpl,
  installenginepart: handleInstallEnginePart,
  uninstallenginepart: handleUninstallEnginePart,
  swapengine: handleSwapEngine,
  egep: handleEngineGetAllParts,
  esst: handleEngineSwapStart,
  esfi: handleEngineSwapFinish,
  // Account / profile
  updatebg: handleUpdateBg,
  addastopbuddy: async () => ({ body: `"s", 1`, source: "generated:addastopbuddy" }),
  removeastopbuddy: async () => ({ body: `"s", 1`, source: "generated:removeastopbuddy" }),
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
  getinfo: handleGetInfo,
  getlocations: handleGetLocations,
  getinstalledenginepartbyaccountcar: handleGetInstalledEnginePartByAccountCar,
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
  teamtrans: handleTeamTransactions,
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
  getelectionphase: handleGetElectionPhase,
  getelectionschedule: handleGetElectionSchedule,
  getnominatecount: handleGetNominateCount,
  nominate: handleNominate,
  getelectionresult: handleGetElectionResult,
  electionvote: handleElectionVote,
  racersearch: handleGetRacerSearch,
  getmisconductcount: handleGetMisconductCount,
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
  gethumantournaments: handleGetHumanTournaments,
  joinhumantournament: handleJoinHumanTournament,
  listracechatusers: handleListRaceChatUsers,
  leaveracechat: async () => ({ body: `"s", 1`, source: "generated:leaveracechat" }),
  // --- Uploads ---
  uploadrequest: handleUploadRequest,
  // --- Race ---
  practice: handlePractice,
  endpractice: async (context) => handlePracticeLifecycleAck(context, "endpractice"),
  leavepractice: async (context) => handlePracticeLifecycleAck(context, "leavepractice"),
  exitpractice: async (context) => handlePracticeLifecycleAck(context, "exitpractice"),
  practiceend: async (context) => handlePracticeLifecycleAck(context, "practiceend"),
  // --- Computer Tournaments (CPU) (10.0.03 source of truth) ---
  // CPU Tournament action contracts (decoded from encrypted payload)
  // - ctgr: fetches computer tournament field xml
  //   Params: ctid or tid -> tournamentId (default 1)
  //   Response: wrapSuccessData(xml)
  //   Source: generated:ctgr:tournament=${tournamentId}
  // - ctjt: join computer tournament, returns tournament key
  //   Params: ctid -> tournamentId (default 1)
  //   Response: "s", 1, "k", "<tournamentKey>"
  //   Source: generated:ctjt:tournament=${tournamentId}
  // - ctct: save computer tournament qualifying pass
  //   Params: k (tournamentKey), bt (bracketTime), acid (activeCarId)
  //   Response: "s", 1, "d", "<q>...</q>" (neutral self-paired race seed)
  //   Source: generated:ctct
  // - ctrt: return computer tournament opponent
  //   Params: k (tournamentKey), caid (requestedOpponentId)
  //   Response: "s", 1, "d", "<opponent.xml>", "b", bkDiff
  //   Source: generated:ctrt
  // - ctst: save computer tournament race result
  //   Params: k (tournamentKey), w (win flag), b (payout)
  //   Response: "s", 1, "d", "<n2 w='X' b='Y'/>"
  //   Source: generated:ctst
  ctgr: async (context) => {
    const { params, logger } = context;
    const tournamentId = Number(params.get("ctid") || params.get("tid") || 1);
    const xml = buildComputerTournamentFieldXml(tournamentId);

    logger.info("ctgr called - returning computer tournament racers", {
      tournamentId,
      racerCount: 32,
    });

    return {
      body: wrapSuccessData(xml),
      source: `generated:ctgr:tournament=${tournamentId}`,
    };
  },
  ctjt: async (context) => {
    const { params, logger } = context;
    const tournamentId = Number(params.get("ctid") || 1);
    const caller = await resolveCallerSession(context, "generated:ctjt");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:ctjt:bad-session",
      };
    }
    const tournamentKey = randomUUID();
    const digest = createHash("sha1")
      .update(`${caller.playerId}:${tournamentId}:cpu`, "utf8")
      .digest("hex");
    const tournamentDialKey = String((parseInt(digest.slice(0, 8), 16) % 32) + 1);
    const defaultCarId = Number(caller?.player?.default_car_game_id || 0) || null;
    const session = {
      sessionKey: tournamentKey,
      tournamentDialKey,
      tournamentId,
      createdAt: Date.now(),
      bracketTime: null,
      qualifyingComplete: false,
      qualifyingTime: null,
      currentRound: 0,
      currentRaceTime: null,
      currentOpponentIndex: null,
      wins: 0,
      playerId: caller.playerId,
      publicId: caller.publicId,
      activeCarId: defaultCarId,
      lastRequestedCarId: Number(defaultCarId || 0),
      lastTournamentCode: tournamentDialKey,
      lastQualifyCarsFetchAt: 0,
    };
    bindComputerTournamentSession(session);

    logger.info("ctjt called - joined computer tournament", {
      tournamentId,
      tournamentKey,
      tournamentDialKey,
      playerId: session.playerId,
    });

    return {
      body: `"s", 1`,
      source: `generated:ctjt:tournament=${tournamentId}`,
    };
  },
  ctct: async (context) => {
    const { params, logger, supabase } = context;
    const tournamentKey = params.get("k") || "";
    const legacyDialKey = isLegacyDialTournamentKey(tournamentKey);
    const bracketTime = Number(params.get("bt") || 0);
    const activeCarId = Number(params.get("acid") || 0) || null;
    const caller = await resolveCallerSessionWithPublicIdFallback(context, "generated:ctct");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:ctct:bad-session",
      };
    }
    const session = getBoundComputerTournamentSession({
      tournamentKey,
      playerId: caller.playerId,
    }) || {
      sessionKey: legacyDialKey
        ? buildComputerTournamentSessionKey(caller.playerId)
        : (tournamentKey || buildComputerTournamentSessionKey(caller.playerId)),
      tournamentDialKey: legacyDialKey ? tournamentKey : "",
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
      currentRound: 0,
      playerId: caller.playerId,
      publicId: caller.publicId,
      activeCarId: null,
      lastRequestedCarId: 0,
      lastTournamentCode: "",
      lastQualifyCarsFetchAt: 0,
    };

    session.bracketTime = bracketTime;
    session.qualifyingComplete = true;
    session.activeCarId = activeCarId;
    session.lastRequestedCarId = Number(activeCarId || 0);
    session.lastTournamentCode = tournamentKey || session.lastTournamentCode || session.tournamentDialKey || "";
    if (!session.sessionKey) {
      session.sessionKey = tournamentKey || buildComputerTournamentSessionKey(session.playerId);
    }
    bindComputerTournamentSession(session);

    const qualifyingCar = supabase && activeCarId > 0
      ? await getCarById(supabase, activeCarId)
      : null;
    const enginePayload = qualifyingCar && Number(qualifyingCar.player_id || 0) === Number(caller.playerId)
      ? buildDriveableEnginePayloadForCar(qualifyingCar)
      : null;
    const responseBody = enginePayload
      ? `"s", 1, "d", "${enginePayload.engineXml}", "t", [${enginePayload.timing.join(", ")}]`
      : `"s", 1`;

    logger.info("ctct called - saved computer tournament qualifying pass", {
      tournamentKey: session.sessionKey,
      bracketTime,
      activeCarId,
      playerId: session.playerId,
      publicId: session.publicId,
      includesEngineTiming: Boolean(enginePayload),
    });
    logTournamentPayload(logger, "ctct", responseBody, {
      tournamentKey: session.sessionKey,
      bracketTime,
      activeCarId,
      playerId: session.playerId,
      publicId: session.publicId,
      includesEngineTiming: Boolean(enginePayload),
    });

    return {
      body: responseBody,
      source: enginePayload ? "generated:ctct:with-engine-timing" : "generated:ctct",
    };
  },
  ctrt: async (context) => {
    const { params, logger } = context;
    const caller = await resolveCallerSessionWithPublicIdFallback(context, "generated:ctrt");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:ctrt:bad-session",
      };
    }
    const requestedOpponentId = Number(params.get("caid") || 0) || null;
    const session = getBoundComputerTournamentSession({
      tournamentKey: params.get("k") || "",
      playerId: caller.playerId,
    }) || {
      sessionKey: buildComputerTournamentSessionKey(caller.playerId),
      tournamentDialKey: params.get("k") || "",
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
      currentRound: 0,
      playerId: caller.playerId,
      publicId: caller.publicId,
      activeCarId: null,
    };
    bindComputerTournamentSession(session);
    const opponent = buildComputerTournamentOpponentXml(session, requestedOpponentId);
    session.currentOpponentIndex = opponent.opponentIndex;
    bindComputerTournamentSession(session);

    const responseBody = `"s", 1, "d", "${opponent.xml}", "b", ${opponent.bkDiff}`;

    logger.info("ctrt called - returning computer tournament opponent", {
      tournamentKey: session.sessionKey,
      tournamentId: session.tournamentId,
      wins: session.wins,
      purse: opponent.purse,
      bkDiff: opponent.bkDiff,
      requestedOpponentId,
      opponentIndex: opponent.opponentIndex,
      opponentCompetitorId: opponent.competitorId,
      opponentCompetitorCarId: opponent.competitorCarId,
      opponentVirtualCarId: opponent.virtualCarId,
    });
    logTournamentPayload(logger, "ctrt", responseBody, {
      tournamentKey: session.sessionKey,
      tournamentId: session.tournamentId,
      wins: session.wins,
      purse: opponent.purse,
      bkDiff: opponent.bkDiff,
      requestedOpponentId,
      opponentIndex: opponent.opponentIndex,
      opponentCompetitorId: opponent.competitorId,
      opponentCompetitorCarId: opponent.competitorCarId,
      opponentVirtualCarId: opponent.virtualCarId,
      activeCarId: session.activeCarId,
      playerPublicId: session.publicId,
    });

    return {
      body: responseBody,
      source: "generated:ctrt",
    };
  },
  ctst: async (context) => {
    const { params, logger, supabase } = context;
    const caller = await resolveCallerSessionWithPublicIdFallback(context, "generated:ctst");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:ctst:bad-session",
      };
    }
    const tournamentKey = params.get("k") || "";
    const session = getBoundComputerTournamentSession({
      tournamentKey,
      playerId: caller.playerId,
    }) || {
      sessionKey: tournamentKey || buildComputerTournamentSessionKey(caller.playerId),
      tournamentDialKey: tournamentKey,
      tournamentId: 1,
      createdAt: Date.now(),
      wins: 0,
      currentRound: 0,
      playerId: caller.playerId,
      publicId: caller.publicId,
      activeCarId: null,
    };
    const rawWinState = Number(params.get("w") || 1) ? 1 : 0;
    const payout = Number(params.get("b") || getComputerTournamentDefinition(session.tournamentId).purse || 0);
    let responseWinState = rawWinState;
    let newMoneyBalance = null;

    if (rawWinState) {
      session.wins = Number(session.wins || 0) + 1;
      if (session.wins >= COMPUTER_TOURNAMENT_ROUNDS_TO_WIN) {
        responseWinState = 2;
      } else {
        responseWinState = 1;
      }
    }

    if (payout > 0 && supabase) {
      const player = await getPlayerById(supabase, caller.playerId);
      if (player) {
        newMoneyBalance = toFiniteNumber(player.money, 0) + payout;
        await updatePlayerMoney(supabase, caller.playerId, newMoneyBalance);
      }
    }

    if (responseWinState === 1) {
      bindComputerTournamentSession(session);
    } else {
      clearComputerTournamentSession(session);
    }

    logger.info("ctst called - saved computer tournament race result", {
      tournamentKey: session.sessionKey,
      winState: responseWinState,
      payout,
      wins: session.wins,
      newMoneyBalance,
      clearedTournamentSession: responseWinState !== 1,
    });

    const balanceSegment = newMoneyBalance === null ? "" : `, "b", ${newMoneyBalance}`;
    return {
      body: `"s", 1, "d", "<n2 w='${responseWinState}' b='${payout}'/>"${balanceSegment}`,
      source: "generated:ctst",
    };
  },
  leaveroom: async (context) => {
    // Leave current race room
    const { services, supabase } = context;
    const raceRoomRegistry = services?.raceRoomRegistry;
    const tcpServer = services?.tcpServer;

    if (!raceRoomRegistry && !tcpServer?.removePlayerFromRooms) {
      return { body: wrapSuccessData("<leave s='0'/>"), source: "leaveroom:no-registry" };
    }

    // Get player info from session
    const caller = await resolveCallerSession(context, "leaveroom");
    if (!caller?.ok) {
      return { body: wrapSuccessData("<leave s='0'/>"), source: "leaveroom:bad-session" };
    }

    const removedLiveRooms = tcpServer?.removePlayerFromRooms
      ? tcpServer.removePlayerFromRooms(caller.playerId, { clearConnections: true })
      : [];
    const removedRegistryRooms = raceRoomRegistry?.removePlayerFromAllRooms
      ? raceRoomRegistry.removePlayerFromAllRooms(caller.playerId)
      : [];
    const removedFrom = [...new Set([...removedLiveRooms, ...removedRegistryRooms])];

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
