import { buildLoginBody } from "./login-payload.js";
import { PARTS_CATALOG_XML } from "./parts-catalog.js";
import { randomUUID } from "node:crypto";
import { normalizeOwnedPartsXmlValue } from "./parts-xml.js";
import {
  escapeXml,
  failureBody,
  renderOwnedGarageCar,
  renderOwnedGarageCarsWrapper,
  renderRacerCars,
  renderTeams,
  renderTwoRacerCars,
  renderUserSummaries,
  renderUserSummary,
  wrapSuccessData,
} from "./game-xml.js";
import { hashGamePassword, normalizeUsername, verifyGamePassword, isPlaintextPassword } from "./player-identity.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { createLoginSession, getSessionPlayerId, validateOrCreateSession } from "./session.js";
import { loginAttemptsTotal } from "./metrics.js";
import {
  getPlayerById,
  getPlayerByUsername,
  createPlayer,
  createStarterCar,
  createOwnedCar,
  ensurePlayerHasGarageCar,
  listCarsForPlayer,
  listCarsByIds,
  listPlayersByIds,
  listTeamMembersForTeams,
  listTeamsByIds,
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
} from "./user-service.js";

const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
const DEFAULT_STOCK_WHEEL_XML = "<ws><w wid='1' id='1001' ws='17'/></ws>";
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
const PART_XML_ATTR_REGEX = /(\w+)='([^']*)'/g;

let partsCatalogById = null;
const pendingTestDriveInvitationsById = new Map();
const pendingTestDriveInvitationsByPlayerId = new Map();
const activeTestDriveCarsByPlayerId = new Map();

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

function buildOwnedInstalledCatalogPartXml(catalogPart, installId, overrides = {}) {
  return normalizeOwnedPartsXmlValue(buildInstalledCatalogPartXml(catalogPart, installId, overrides));
}

function findInstalledPartBySlotId(partsXml, slotId) {
  const source = String(partsXml || "");
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(source)) !== null) {
    const attrs = parsePartXmlAttributes(match[0]);
    if (String(attrs.pi || attrs.ci || "") === String(slotId || "")) {
      PART_XML_ENTRY_REGEX.lastIndex = 0;
      return attrs;
    }
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return null;
}

function buildPartsInventoryXml(items) {
  const partsXml = items.map((item) => item.xml).join("");
  return `<n2>${partsXml}</n2>`;
}

function parseShowroomPurchaseCatalogCarId(params) {
  return Number(
    params.get("acid")
      || params.get("ci")
      || params.get("cid")
      || params.get("carid")
      || params.get("id")
      || 0,
  );
}

function parseShowroomPurchasePrice(params) {
  return Number(
    params.get("pr")
      || params.get("price")
      || params.get("cp")
      || 0,
  );
}

function getCatalogCarPrice(catalogCarId) {
  const car = FULL_CAR_CATALOG.find(([cid]) => String(cid) === String(catalogCarId));
  return car ? Number(car[2] || 0) : 0;
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

async function handleLogin(context) {
  const { supabase, params, logger } = context;
  if (!supabase) {
    return null;
  }

  const username = normalizeUsername(params.get("u"));
  const password = params.get("p") || "";

  if (!username || !password) {
    logger.warn("Login failed: missing credentials", { username: username || "(empty)" });
    loginAttemptsTotal.inc({ result: "missing_credentials" });
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
      loginAttemptsTotal.inc({ result: "invalid" });
      return { body: failureBody(), source: "supabase:login:invalid" };
    }

    logger.info("Login successful", { username, playerId: player.id, publicId: player.public_id });
    loginAttemptsTotal.inc({ result: "success" });

    // Auto-migrate legacy plaintext passwords to SHA-256 on successful login
    if (isPlaintextPassword(player.password_hash)) {
      try {
        const hashed = hashGamePassword(password);
        await supabase
          .from("game_players")
          .update({ password_hash: hashed })
          .eq("id", player.id);
        logger.info("Migrated plaintext password to SHA-256", { playerId: player.id });
      } catch (migrationErr) {
        logger.error("Password migration failed", { playerId: player.id, error: migrationErr.message });
      }
    }

    const cars = await ensurePlayerHasGarageCar(supabase, player.id, {
      catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
      wheelXml: DEFAULT_STOCK_WHEEL_XML,
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
    loginAttemptsTotal.inc({ result: "error" });
    return { body: failureBody(), source: "supabase:login:error" };
  }
}

async function handleCreateAccount(context) {
  const { supabase, params, fixtureStore } = context;
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
      partsXml: DEFAULT_STOCK_PARTS_XML,
      wheelXml: DEFAULT_STOCK_WHEEL_XML,
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
        wheelXml: DEFAULT_STOCK_WHEEL_XML,
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
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
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

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getonecarengine");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getonecarengine:bad-session",
      };
    }

    // Load car to get actual parts_xml
    const car = await getCarById(supabase, accountCarId);
    if (car) {
      // Calculate compression level from installed piston parts (slot 190)
      const partsXml = car.parts_xml || "";
      const pistonMatch = partsXml.match(/<p[^>]*\bci='190'[^>]*\bdi='(\d+)'[^>]*\/>/i);
      const compressionLevel = pistonMatch ? Number(pistonMatch[1]) : 0;

      const timing = [273,273,273,273,273,273,273,273,273,375,387,398,410,421,432,444,455,467,478,490,501,513,524,536,547,559,570,582,593,605,614,617,619,622,624,626,629,631,634,636,639,641,644,646,648,651,653,656,658,661,663,665,668,670,673,675,678,680,680,672,665,657,649,641,633,625,617,609,601,593,585,577,569,561,554,546,537,529,520,512,503,494,486,477,469,460,452,443,435,426,418,409,401,392,384,375,367,358,350,341];

      const engineXml =
        `<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.2398523985239853' ` +
        `a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='${compressionLevel}' e='0' d='T' ` +
        `f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' ` +
        `m='100' t='100' u='28' w='0.4607' x='63.98' y='506.71' z='92.13' ` +
        `aa='4' ab='${accountCarId}' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
        `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
        `at='100' au='100' av='0' aw='100' ax='0'/>`;

      return {
        body: `"s", 1, "d", "${engineXml}", "t", [${timing.join(', ')}]`,
        source: "generated:getonecarengine",
      };
    }
  }

  const timing = [273,273,273,273,273,273,273,273,273,375,387,398,410,421,432,444,455,467,478,490,501,513,524,536,547,559,570,582,593,605,614,617,619,622,624,626,629,631,634,636,639,641,644,646,648,651,653,656,658,661,663,665,668,670,673,675,678,680,680,672,665,657,649,641,633,625,617,609,601,593,585,577,569,561,554,546,537,529,520,512,503,494,486,477,469,460,452,443,435,426,418,409,401,392,384,375,367,358,350,341];

  const engineXml =
    `<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.2398523985239853' ` +
    `a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='0' e='0' d='T' ` +
    `f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' ` +
    `m='100' t='100' u='28' w='0.4607' x='63.98' y='506.71' z='92.13' ` +
    `aa='4' ab='${accountCarId}' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
    `aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' ` +
    `at='100' au='100' av='0' aw='100' ax='0'/>`;

  return {
    body: `"s", 1, "d", "${engineXml}", "t", [${timing.join(', ')}]`,
    source: "generated:getonecarengine",
  };
}

async function handleBuyDyno(context) {
  const { supabase, params } = context;

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

  const dynoPrice = 500;
  const newBalance = Number(player.money) - dynoPrice;

  if (newBalance < 0) {
    return { body: `"s", -2`, source: "supabase:buydyno:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

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

  const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
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
    const panelPrices = { 6001: 190, 6002: 135, 6003: 130, 6004: 110 };
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
      const partSlotMap = { 6001: "161", 6002: "163", 6003: "162", 6004: "160" };
      const slotId = partSlotMap[partId] || "161";

      try {
        const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const decalDir = resolve(process.cwd(), "../cache/car/userDecals");
        mkdirSync(decalDir, { recursive: true });
        const files = readdirSync(decalDir).filter((file) => file.endsWith(".jpg")).sort().reverse();
        if (files.length > 0) {
          renameSync(resolve(decalDir, files[0]), resolve(decalDir, `${slotId}_${decalId}.swf`));
        }
      } catch (err) {
        logger?.error("Failed to rename decal", { error: err.message });
      }

      const installedPartXml = `<p ai='${installId}' i='${partId}' ci='${slotId}' pt='c' n='Custom Graphic' in='1' cc='0' pdi='${decalId}' di='${decalId}' ps=''/>`;
      const partsXml = upsertInstalledPartXml(car.parts_xml || "", slotId, installedPartXml);
      const { error: updateError1 } = await supabase.from("game_cars").update({ parts_xml: partsXml }).eq("game_car_id", accountCarId);
      if (updateError1) {
        logger?.error("Failed to save custom graphic", { error: updateError1, accountCarId, partId });
      } else {
        logger?.info("Saved custom graphic to car", { accountCarId, partId, slotId, partsXmlLength: partsXml.length });
      }
    } else if (catalogPart && partSlotId) {
      const installedPartXml = buildOwnedInstalledCatalogPartXml(catalogPart, installId, {
        t: catalogPart.t || partType || "",
        ps: partPs,
      });
      const partsXml = upsertInstalledPartXml(car.parts_xml || "", partSlotId, installedPartXml);
      const { error: updateError2 } = await supabase.from("game_cars").update({ parts_xml: partsXml }).eq("game_car_id", accountCarId);
      if (updateError2) {
        logger?.error("Failed to save part", { error: updateError2, accountCarId, partId, partSlotId });
      } else {
        logger?.info("Saved part to car", { accountCarId, partId, partSlotId, partName, installId, partsXmlLength: partsXml.length });
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

  const catalogPart = partId ? getPartsCatalogById().get(partId) : null;
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
  const installedPartXml = buildOwnedInstalledCatalogPartXml(catalogPart, installId);
  const partsXml = upsertInstalledPartXml(car.parts_xml || "", slotId, installedPartXml);
  const { error: updateError } = await supabase.from("game_cars").update({ parts_xml: partsXml }).eq("game_car_id", accountCarId);
  if (updateError) {
    logger?.error("Failed to save engine part", { error: updateError, accountCarId, partId, slotId });
  } else {
    logger?.info("Saved engine part to car", { accountCarId, partId, slotId, installId, partsXmlLength: partsXml.length });
  }

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${installId}'/>", "d", "<r s='1' b='0'></r>"`,
    source: "supabase:buyenginepart",
  };
}

async function handleGetCarPartsBin(context) {
  const { supabase } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getcarpartsbin");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getcarpartsbin:bad-session" };
  }

  const inventory = await listPartsInventoryForPlayer(supabase, caller.playerId);
  const catalog = getPartsCatalogById();
  const items = [];

  for (const row of inventory) {
    const catalogPart = catalog.get(Number(row.part_catalog_id || 0));
    if (!catalogPart) {
      continue;
    }

    const quantity = Math.max(1, Number(row.quantity || 1));
    for (let index = 0; index < quantity; index += 1) {
      const syntheticId = index === 0 ? Number(row.id) : `${row.id}-${index + 1}`;
      items.push({
        id: syntheticId,
        xml: buildInstalledCatalogPartXml(catalogPart, syntheticId, {
          in: "0",
        }),
      });
    }
  }

  return {
    body: wrapSuccessData(buildPartsInventoryXml(items)),
    source: "supabase:getcarpartsbin",
  };
}

async function handleInstallPart(context) {
  const { supabase, params, logger } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:installpart");
  if (!caller?.ok) {
    return { body: caller?.body || failureBody(), source: caller?.source || "supabase:installpart:bad-session" };
  }

  const accountPartId = Number(params.get("acpid") || 0);
  const partId = Number(params.get("pid") || 0);
  const accountCarId = Number(params.get("acid") || 0);

  if (!accountPartId || !partId || !accountCarId) {
    return { body: failureBody(), source: "supabase:installpart:missing-params" };
  }

  const [inventoryItem, car] = await Promise.all([
    getPartInventoryItemById(supabase, accountPartId, caller.playerId),
    getCarById(supabase, accountCarId),
  ]);

  if (!inventoryItem || Number(inventoryItem.part_catalog_id || 0) !== partId) {
    return { body: failureBody(), source: "supabase:installpart:no-inventory-part" };
  }

  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: failureBody(), source: "supabase:installpart:no-car" };
  }

  const catalogPart = getPartsCatalogById().get(partId);
  if (!catalogPart) {
    return { body: failureBody(), source: "supabase:installpart:no-catalog-part" };
  }

  const slotId = String(catalogPart.pi || "");
  if (!slotId) {
    return { body: failureBody(), source: "supabase:installpart:no-slot" };
  }

  const existingPart = findInstalledPartBySlotId(car.parts_xml || "", slotId);
  if (Number(existingPart?.i || 0) === partId) {
    return { body: `"s", 1`, source: "supabase:installpart:already-installed" };
  }

  if (existingPart?.i) {
    await addPartInventoryItem(supabase, caller.playerId, Number(existingPart.i), 1);
  }

  const installedPartXml = buildOwnedInstalledCatalogPartXml(catalogPart, createInstalledPartId(), {
    in: "1",
  });
  const partsXml = upsertInstalledPartXml(car.parts_xml || "", slotId, installedPartXml);
  const { error: updateError } = await supabase
    .from("game_cars")
    .update({ parts_xml: partsXml })
    .eq("game_car_id", accountCarId);

  if (updateError) {
    return { body: failureBody(), source: "supabase:installpart:update-failed" };
  }

  await consumePartInventoryItem(supabase, accountPartId, caller.playerId);
  logger?.info("Installed spare part onto car", {
    playerId: caller.playerId,
    accountCarId,
    accountPartId,
    partId,
    slotId,
  });

  return {
    body: `"s", 1`,
    source: "supabase:installpart",
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
  
  const createdCar = await createOwnedCar(supabase, {
    playerId: caller.playerId,
    catalogCarId,
    selected: true,
    paintIndex: 4,
    plateName: "",
    colorCode: selectedColor,
    partsXml: DEFAULT_STOCK_PARTS_XML,
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
  });

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${createdCar.game_car_id}'/>", "d", "<r s='1' b='0'></r>"`,
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
  const { supabase } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:gettotalnewmail");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:gettotalnewmail:bad-session",
      };
    }
  }

  // Response format: "s", 1, "im", "COUNT"
  // For now, return 0 unread messages
  return {
    body: `"s", 1, "im", "0"`,
    source: "gettotalnewmail:zero",
  };
}

async function handleGetRemarks(context) {
  const { supabase } = context;

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getremarks");
    if (!caller?.ok) {
      return { body: caller?.body || failureBody(), source: caller?.source || "supabase:getremarks:bad-session" };
    }
  }

  // Response format: "s", 1, "d", "<remarks/>"
  // Empty remarks list for now
  return {
    body: wrapSuccessData("<remarks/>"),
    source: "getremarks:empty",
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
    // Get emails from database
    const { data: emails, error } = await supabase
      .from("game_mail")
      .select(`
        id,
        sender_player_id,
        subject,
        body,
        is_read,
        created_at,
        attachment_money,
        attachment_points
      `)
      .eq("recipient_player_id", caller.playerId)
      .eq("folder", folder)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) throw error;

    // Build email XML
    const emailsXml = (emails || []).map(email => {
      const readStatus = email.is_read ? "1" : "0";
      const hasAttachment = (email.attachment_money > 0 || email.attachment_points > 0) ? "1" : "0";
      return (
        `<m i='${email.id}' si='${email.sender_player_id || 0}' ` +
        `s='${escapeXml(email.subject)}' r='${readStatus}' a='${hasAttachment}' ` +
        `d='${Math.floor(new Date(email.created_at).getTime() / 1000)}'/>`
      );
    }).join("");

    // Response format: "s", 1, "d", "<emails>...</emails>", "t", <total>, "p", <page>
    return {
      body: `"s", 1, "d", "${escapeXml(`<emails>${emailsXml}</emails>`)}", "t", ${emails?.length || 0}, "p", ${page}`,
      source: "supabase:getemaillist",
    };
  } catch (error) {
    context.logger?.error("Get email list error", { error: error.message });
    return { body: failureBody(), source: "supabase:getemaillist:error" };
  }
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
  const { supabase, params } = context;
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
  const offer = player ? createTestDriveInvitation(player) : {
    invitationId: Date.now(),
    catalogCarId: DEFAULT_STARTER_CATALOG_CAR_ID,
    colorCode: "C0C0C0",
    locationId: 100,
  };
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
    partsXml: DEFAULT_STOCK_PARTS_XML,
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
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

    const { error } = await supabase
      .from("game_players")
      .update({ points: newPointsBalance })
      .eq("id", Number(caller.playerId));
    if (error) {
      throw error;
    }

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
    const { error } = await supabase
      .from("game_players")
      .update({ default_car_game_id: null })
      .eq("id", Number(caller.playerId));
    if (error) {
      throw error;
    }
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

// Full car catalog - only cars with logo SWFs in the 10.0.03 game cache (104 cars)
const FULL_CAR_CATALOG = [
  ["1","Acura Integra GSR",24000], ["6","Acura RSX Type-S",24000], ["28","Acura NSX",140000],
  ["20","Acura Integra Type R",30000], ["32","Acura RSX-S",26000],
  ["11","BMW M3",54000],
  ["7","Chevy Corvette C6",45000], ["18","Chevy Camaro",25000], ["52","Chevy Cobalt SS",20000],
  ["82","Chevy C-10",5000], ["100","Chevy Impala SS",28000], ["46","Chevy Camaro SS",32000],
  ["48","Chevy Camaro SS",42000], ["83","Chevy S-10",12000], ["34","Chevy Corvette Z06",75000],
  ["108","Chevy Camaro Z28",35000],
  ["10","Dodge Viper SRT-10",80000], ["15","Dodge Neon SRT-4",20000],
  ["59","Dodge Challenger SRT-8",38000], ["60","Dodge Charger SRT-8",35000],
  ["63","Dodge Challenger R/T",32000], ["75","Dodge Charger R/T",30000],
  ["81","Dodge Ram SRT-10",45000], ["97","Dodge Charger SRT-8",40000],
  ["109","Dodge Viper ACR-X",120000],
  ["103","Dodge Dart GTS",18000],
  ["3","Ford Mustang GT",30000], ["5","Ford GT",150000],
  ["45","Ford SVT Cobra R",55000], ["68","Ford Shelby GT500",55000],
  ["26","Ford Mustang Mach 1",35000], ["71","Ford Mustang Boss 302",42000],
  ["8","Honda Integra Type R",27000], ["9","Honda S2000",33000], ["31","Honda Civic Si",18000],
  ["37","Honda Civic Si",19000], ["44","Honda Prelude DOHC VTEC",22000], ["74","Honda CR-X Si",12000],
  ["76","Honda Civic Si",20000], ["105","Honda Civic Type R",35000], ["29","Honda Del Sol VTEC",16000],
  ["30","Honda Accord Euro R",25000],
  ["4","Infiniti G35 Coupe",32000], ["51","Infiniti G37S",38000],
  ["54","Lexus IS 300",33000], ["66","Lexus SC 300",38000],
  ["57","Mazda Furai",500000], ["19","Mazdaspeed 6 Bergenholtz",25000], ["23","Mazdaspeed 3",20000],
  ["24","Mazda RX-8",28000], ["16","Mazda RX-7",30000], ["73","Mazda RX-3",3000],
  ["107","Mazda MX-5 Miata",24000], ["36","Mazda Speed3",20000], ["86","Mazda RX-7 Spirit R",75000],
  ["2","Mitsubishi Lancer Evo VIII",35000], ["87","Mitsubishi Lancer Evo X",38000],
  ["88","Mitsubishi Eclipse GSX",25000], ["17","Mitsubishi Eclipse GT",24000],
  ["27","Mitsubishi 3000GT VR-4",40000], ["40","Mitsubishi Lancer Evo IX",35000],
  ["104","Mitsubishi Galant VR-4",28000],
  ["55","Nissan 370Z",35000], ["38","Nissan Skyline GT-R",80000], ["35","Nissan 300ZX",35000],
  ["47","Nissan Sentra SE-R",16000], ["41","Nissan 240SX",18000], ["25","Nissan 350Z",30000],
  ["21","Nissan GT-R",85000], ["39","Nissan Pulsar NX",12000], ["42","Nissan Silvia S15",25000],
  ["69","Nissan 180SX",20000], ["70","Nissan 240SX Fastback",18000], ["98","Nissan Skyline R32 GT-R",60000],
  ["101","Nissan GT-R Black Edition",110000], ["102","Nissan Leaf",30000],
  ["110","Nissan Silvia S13",18000], ["111","Nissan Sentra B15",14000], ["112","Nissan Altima SE-R",22000],
  ["79","Plymouth 'Cuda",5000], ["80","Plymouth Road Runner",4000],
  ["33","Pontiac Solstice GXP",25000], ["43","Pontiac GTO",33000], ["49","Pontiac Trans Am",28000],
  ["50","Pontiac GTO",40000], ["56","Pontiac GTO Judge",6000], ["85","Pontiac Firebird Trans Am",26000],
  ["13","Scion tC",17000], ["22","Scion xB",15000], ["95","Scion tC",18000],
  ["89","Subaru Impreza WRX STI",38000], ["92","Subaru Impreza WRX STI",36000],
  ["91","Subaru Impreza WRX STI",37000], ["12","Subaru Impreza WRX",28000],
  ["14","Toyota Supra",42000], ["61","Toyota MR2",15000],
  ["65","Toyota Celica GT-S",19000], ["99","Toyota Corolla GT-S",12000],
  ["58","VW Golf R32",32000], ["62","VW Beetle",18000], ["67","VW Golf GTI",22000],
  ["64","VW Golf GTI",24000], ["77","VW Corrado",20000], ["84","VW Jetta GLI",22000],
  ["72","Buick Grand National",30000],
  ["53","Cadillac CTS-V",60000],
  ["90","McLaren MP4-12C",230000],
  ["94","Honda Fit Sport",15000],
];

function getCatalogCarRecord(catalogCarId) {
  return FULL_CAR_CATALOG.find(([cid]) => Number(cid) === Number(catalogCarId)) || null;
}

function getCatalogCarName(catalogCarId) {
  return getCatalogCarRecord(catalogCarId)?.[1] || "Unknown";
}

function getCatalogCarPointPrice(catalogCarId) {
  const moneyPrice = getCatalogCarPrice(catalogCarId);
  if (moneyPrice <= 0) {
    return -1;
  }
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

const DEFAULT_SHOWROOM_CAR_SPEC = {
  eo: "2.0L I4",
  dt: "FWD",
  np: "4",
  ct: "Coupe",
  et: "15.00 sec 1/4",
  tt: "140 mph top speed",
  sw: "2800",
  st: "7.0",
  y: "2005",
};

const SHOWROOM_CAR_SPEC_OVERRIDES = new Map([
  ["5", { eo: "5.4L V8 SC", dt: "RWD", np: "2", ct: "Coupe", et: "11.6 sec 1/4", tt: "205 mph top speed", sw: "3480", st: "3.6", y: "2005" }],
  ["7", { eo: "6.0L V8", dt: "RWD", np: "2", ct: "Coupe", et: "12.5 sec 1/4", tt: "186 mph top speed", sw: "3210", st: "4.2", y: "2005" }],
  ["10", { eo: "8.3L V10", dt: "RWD", np: "2", ct: "Roadster", et: "11.9 sec 1/4", tt: "190 mph top speed", sw: "3410", st: "3.9", y: "2005" }],
  ["11", { eo: "3.2L I6", dt: "RWD", np: "2", ct: "Coupe", et: "13.1 sec 1/4", tt: "155 mph top speed", sw: "3415", st: "4.9", y: "2005" }],
  ["14", { eo: "3.0L I6 TT", dt: "RWD", np: "2", ct: "Coupe", et: "12.9 sec 1/4", tt: "177 mph top speed", sw: "3460", st: "4.6", y: "1998" }],
  ["21", { eo: "3.8L V6 TT", dt: "AWD", np: "2", ct: "Coupe", et: "11.8 sec 1/4", tt: "193 mph top speed", sw: "3830", st: "3.5", y: "2009" }],
  ["25", { eo: "3.5L V6", dt: "RWD", np: "2", ct: "Coupe", et: "13.5 sec 1/4", tt: "155 mph top speed", sw: "3350", st: "5.1", y: "2003" }],
  ["28", { eo: "3.2L V6", dt: "RWD", np: "2", ct: "Coupe", et: "12.9 sec 1/4", tt: "175 mph top speed", sw: "3150", st: "4.8", y: "2005" }],
  ["34", { eo: "7.0L V8", dt: "RWD", np: "2", ct: "Coupe", et: "11.7 sec 1/4", tt: "198 mph top speed", sw: "3130", st: "3.6", y: "2006" }],
  ["38", { eo: "2.6L I6 TT", dt: "AWD", np: "2", ct: "Coupe", et: "13.1 sec 1/4", tt: "156 mph top speed", sw: "3420", st: "4.9", y: "1999" }],
  ["48", { eo: "6.2L V8", dt: "RWD", np: "2", ct: "Coupe", et: "13.0 sec 1/4", tt: "155 mph top speed", sw: "3860", st: "4.6", y: "2010" }],
  ["51", { eo: "3.7L V6", dt: "RWD", np: "2", ct: "Coupe", et: "13.5 sec 1/4", tt: "155 mph top speed", sw: "3740", st: "5.0", y: "2009" }],
  ["55", { eo: "3.7L V6", dt: "RWD", np: "2", ct: "Coupe", et: "13.3 sec 1/4", tt: "155 mph top speed", sw: "3330", st: "4.7", y: "2009" }],
  ["57", { eo: "2.0L 4-Rotor", dt: "RWD", np: "1", ct: "Prototype", et: "9.8 sec 1/4", tt: "220 mph top speed", sw: "2200", st: "2.8", y: "2008" }],
  ["59", { eo: "6.1L V8", dt: "RWD", np: "2", ct: "Coupe", et: "13.1 sec 1/4", tt: "173 mph top speed", sw: "4140", st: "4.9", y: "2008" }],
  ["68", { eo: "5.4L V8 SC", dt: "RWD", np: "2", ct: "Coupe", et: "12.4 sec 1/4", tt: "180 mph top speed", sw: "3920", st: "4.3", y: "2011" }],
  ["72", { eo: "3.8L V6 T", dt: "RWD", np: "2", ct: "Coupe", et: "13.6 sec 1/4", tt: "124 mph top speed", sw: "3550", st: "5.0", y: "1987" }],
  ["86", { eo: "1.3L Twin-Rotor TT", dt: "RWD", np: "2", ct: "Coupe", et: "12.6 sec 1/4", tt: "165 mph top speed", sw: "2800", st: "4.7", y: "2002" }],
  ["87", { eo: "2.0L I4 T", dt: "AWD", np: "4", ct: "Sedan", et: "13.3 sec 1/4", tt: "152 mph top speed", sw: "3510", st: "5.0", y: "2008" }],
  ["89", { eo: "2.5L H4 T", dt: "AWD", np: "4", ct: "Sedan", et: "13.3 sec 1/4", tt: "155 mph top speed", sw: "3380", st: "4.8", y: "2008" }],
  ["90", { eo: "3.8L V8 TT", dt: "RWD", np: "2", ct: "Coupe", et: "11.0 sec 1/4", tt: "205 mph top speed", sw: "3190", st: "3.1", y: "2012" }],
  ["91", { eo: "2.5L H4 T", dt: "AWD", np: "4", ct: "Sedan", et: "13.2 sec 1/4", tt: "155 mph top speed", sw: "3380", st: "4.7", y: "2011" }],
  ["92", { eo: "2.5L H4 T", dt: "AWD", np: "4", ct: "Sedan", et: "13.1 sec 1/4", tt: "158 mph top speed", sw: "3390", st: "4.6", y: "2015" }],
  ["98", { eo: "2.6L I6 TT", dt: "AWD", np: "2", ct: "Coupe", et: "12.6 sec 1/4", tt: "156 mph top speed", sw: "3150", st: "4.6", y: "1994" }],
  ["101", { eo: "3.8L V6 TT", dt: "AWD", np: "2", ct: "Coupe", et: "11.6 sec 1/4", tt: "193 mph top speed", sw: "3840", st: "3.4", y: "2012" }],
  ["109", { eo: "8.4L V10", dt: "RWD", np: "2", ct: "Coupe", et: "11.1 sec 1/4", tt: "184 mph top speed", sw: "3350", st: "3.2", y: "2010" }],
]);

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
  return FULL_CAR_CATALOG.filter(([, , price]) => getShowroomLocationForCarPrice(price) === targetLocationId);
}

function createTestDriveInvitation(player) {
  const existingInvitation = pendingTestDriveInvitationsByPlayerId.get(Number(player?.id || 0));
  if (existingInvitation) {
    pendingTestDriveInvitationsById.delete(Number(existingInvitation.invitationId));
  }
  const showroomCars = listShowroomCatalogCarsForLocation(player?.location_id || 100);
  const [catalogCarId = DEFAULT_STARTER_CATALOG_CAR_ID] = showroomCars[0] || [];
  const invitationId = Date.now() + Math.floor(Math.random() * 1000);
  const offer = {
    invitationId,
    playerId: Number(player?.id || 0),
    catalogCarId: Number(catalogCarId) || DEFAULT_STARTER_CATALOG_CAR_ID,
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

function getShowroomCarSpec(carId) {
  return SHOWROOM_CAR_SPEC_OVERRIDES.get(String(carId || "")) || DEFAULT_SHOWROOM_CAR_SPEC;
}

function buildShowroomXml(locationId, starterOnly = false) {
  const targetLocationId = Number(locationId) || 100;

  // Filter to only cars that belong to this exact location tier
  const locationTiers = Object.entries(LOCATION_MAX_PRICE).sort((a, b) => Number(a[0]) - Number(b[0]));
  const getCarLocation = (price) => {
    for (const [lid, maxP] of locationTiers) {
      if (Number(price) <= maxP) return Number(lid);
    }
    return 500;
  };

  const eligible = FULL_CAR_CATALOG.filter(([, , price]) => {
    const numPrice = Number(price);
    if (numPrice <= 0) return false;
    if (starterOnly) return getCarLocation(numPrice) === 100;
    return getCarLocation(numPrice) === targetLocationId;
  });

  const locationToCatId = { 100: 1001, 200: 1002, 300: 1003, 400: 1004, 500: 1005 };
  const catId = locationToCatId[targetLocationId] || 1001;

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
      const primarySwatch = showroomColors[index % showroomColors.length];
      const wheelSize = String(Math.max(15, Math.min(19, 15 + (index % 5))));
      const wheelId = String(1 + (index % 8));
      const swatchNodes = showroomColors
        .map(({ paintId, colorCode }) => `<p i='${paintId}' cd='${colorCode}'/>`)
        .join("");
      const purchasePrice = Number(price) || 0;
      const pointPrice = getCatalogCarPointPrice(cid);
      return (
        `<c ai='0' id='${cid}' i='${cid}' ci='${cid}' ` +
        `sel='${index === 0 ? "1" : "0"}' pi='${catId}' pn='' ` +
        `l='${targetLocationId}' lid='${targetLocationId}' cid='${targetLocationId}' ` +
        `b='0' n='${escapedName}' c='${escapedName}' p='${purchasePrice}' pr='${purchasePrice}' pp='${pointPrice}' cp='${purchasePrice}' ` +
        `lk='0' ae='0' cc='${primarySwatch.colorCode}' g='' ii='0' ` +
        `wid='${wheelId}' ws='${wheelSize}' rh='0' ts='0' mo='0' ` +
        `cbl='0' cb='0' po='0' poc='0' led='' ` +
        `le='0' lea='999' les='0' lec='999' let='0' ` +
        `eo='${escapeXml(spec.eo)}' dt='${escapeXml(spec.dt)}' np='${escapeXml(spec.np)}' ct='${escapeXml(spec.ct)}' ` +
        `et='${escapeXml(spec.et)}' tt='${escapeXml(spec.tt)}' sw='${escapeXml(spec.sw)}' st='${escapeXml(spec.st)}' y='${escapeXml(spec.y)}'>` +
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

  if (supabase && locationId) {
    const caller = await resolveCallerSession(context, "supabase:movelocation");
    if (caller?.ok) {
      await updatePlayerLocation(supabase, caller.playerId, locationId);
      
      // Fetch updated player data to return to client
      const updatedPlayer = await getPlayerById(supabase, caller.playerId);
      if (updatedPlayer) {
        return {
          body: wrapSuccessData(renderUserSummary(updatedPlayer, { publicId: getPublicIdForPlayer(updatedPlayer) })),
          source: "supabase:movelocation",
        };
      }
    }
  }

  return { body: `"s", 1`, source: `stub:movelocation:${locationId}` };
}

function generateCarStats(carId) {
  const spec = getShowroomCarSpec(carId);
  const car = FULL_CAR_CATALOG.find(([cid]) => cid === carId);
  const price = car ? car[2] : 0;

  const stats = {
    es: 1,
    sl: 7200,
    sg: 0,
    rc: 0,
    tmp: 0,
    r: 2600,
    v: 1.65,
    a: 6800,
    n: 7600,
    o: 7800,
    s: 0.815,
    b: 0,
    p: 0.15,
    c: 11,
    e: 0,
    d: 'T',
    f: 3.23,
    g: 1.9,
    h: 1.269,
    i: 0.967,
    j: 0.738,
    k: 0,
    l: 4.4,
    q: spec.hp || 100,
    m: spec.tq || 100,
    t: 100,
    u: 28,
    w: 0.144,
    x: 41.2,
    y: spec.tq || 128,
    z: spec.hp || 170,
    aa: 4,
    ab: carId,
    ac: 9,
    ad: 0,
    ae: 100,
    af: 100,
    ag: 100,
    ah: 100,
    ai: 100,
    aj: 0,
    ak: 0,
    al: 0,
    am: 0,
    an: 0,
    ao: 100,
    ap: 0,
    aq: 0,
    ar: 1,
    as: 0,
    at: 100,
    au: 100,
    av: 0,
    aw: 100,
    ax: 0,
  };

  return `<n2 ${Object.entries(stats).map(([key, value]) => `${key}='${value}'`).join(' ')}><r g1='${stats.f}' g2='${stats.g}' g3='${stats.h}' g4='${stats.i}' g5='${stats.j}' g6='0'/></n2>`;
}

function generateTimingArray(carId) {
  const spec = getShowroomCarSpec(carId);
  const power = Number(spec.hp) || 170;
  const weight = Number(spec.sw) || 2800;
  const pwr = power / weight;

  const baseTime = 15.5;
  const time = baseTime - (pwr - 0.06) * 20;

  const baseTiming = [91,91,91,91,91,91,91,91,91,93,95,98,102,106,109,112,115,117,119,121,122,123,124,125,126,126,127,127,128,128,128,128,128,127,127,127,126,126,125,125,124,123,122,121,120,119,118,117,116,115,113,112,110,108,106,104,101,98,98,96,95,93,91,89,87,85,83,81,79,77,75,73,71,69,67,65,63,61,59,57,55,53,51,49,47,45,43,41,39,37,35,33,31,29,27,25,23,21,19,17,15,13];
  const scale = time / baseTime;

  return baseTiming.map(t => Math.round(t * scale));
}

async function handleListClassified(context) {
  // Empty classified ads list.
  return {
    body: wrapSuccessData(`<cars i='0' dc='0'></cars>`),
    source: "stub:listclassified",
  };
}

async function handleViewShowroom(context) {
  const { params, supabase } = context;
  let locationId = Number(params.get("lid") || params.get("l") || 0);

  // If no lid provided, use the player's current location from their profile
  if (!locationId && supabase) {
    const caller = await resolveCallerSession(context, "supabase:viewshowroom");
    if (caller?.ok) {
      const player = await getPlayerById(supabase, caller.playerId);
      locationId = Number(player?.location_id || 100);
    }
  }

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
    .map((c) => `<c i='${c.i}' pi='${c.pi}' c='0' p='0' n='${escapeXml(c.n)}' cl='${c.cl}' l='${c.l}'/>`)
    .join("");
  return {
    body: wrapSuccessData(`<cats>${catNodes}</cats>`),
    source: "stub:getcarcategories",
  };
}

async function handleGetGearInfo(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getgearinfo");
    // Non-fatal: fall through to default even if session check fails
    if (caller && !caller.ok) {
      return { body: caller.body || failureBody(), source: caller.source || "supabase:getgearinfo:bad-session" };
    }
  }

  // Default gear ratios for all cars
  const gearRatios = `<g p='2500' pp='25'><r g1='3.587' g2='2.022' g3='1.384' g4='1' g5='0.861' g6='0' fg='4.058'/></g>`;
  return {
    body: wrapSuccessData(gearRatios),
    source: "generated:getgearinfo",
  };
}

async function handlePractice(context) {
  const { logger, params } = context;
  
  // Get the car ID from the request
  const carId = params.get("acid");
  const carStats = generateCarStats(carId);
  const timing = generateTimingArray(carId);
  
  // Format: "s", 1, "d", "<xml/>", "t", [array]
  const body = `"s", 1, "d", "${carStats}", "t", [${timing.join(', ')}]`;
  
  if (logger) {
    logger.info("Practice response", {
      carId,
      bodyLength: body.length,
      bodyPreview: body.substring(0, 200),
      timingLength: timing.length
    });
  }
  
  return { 
    body,
    source: "generated:practice" 
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

function buildComputerTournamentOpponentXml(session) {
  const tournament = getComputerTournamentDefinition(session?.tournamentId);
  const opponentIndex = Number(session?.wins || 0) % 32;
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

async function handleGetLeaderboardMenu(context) {
  return {
    body: wrapSuccessData(`<menu tc='10' ttc='3'/>`),
    source: "generated:getleaderboardmenu",
  };
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

async function handleGetLeaderboard(context) {
  const reportType = String(context.params.get("n") || "sc").replace(/[^a-z]/gi, "") || "sc";

  return {
    body: wrapSuccessData(`<leaderboard id='${reportType}'><rows/></leaderboard>`),
    source: "stub:getleaderboard",
  };
}

async function handleGetRacerSearch(context) {
  return {
    body: wrapSuccessData(`<u></u>`),
    source: "stub:racersearch",
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

async function handleTeamInfo(context) {
  const { supabase, params } = context;
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
  getallcats: async (context) => {
    // Get all categories/parts catalog - this is a large response
    // For now, return from fixture if available
    const fixture = context.fixtureStore?.find("getallcats");
    if (fixture) {
      return { body: fixture.body, source: `fixture:${fixture.key}` };
    }
    // Fallback: return empty catalog
    return { body: `"s", 1, "d", "<n2 />"`, source: "stub:getallcats" };
  },
  updatedefaultcar: handleUpdateDefaultCar,
  getcarprice: handleGetCarPrice,
  sellcar: handleSellCar,
  // --- Parts & Engine ---
  getallparts: handleGetAllParts,
  getcarpartsbin: handleGetCarPartsBin,
  getallwheelstires: async (context) => {
    // Get all wheels and tires catalog - this is a large response
    // For now, return from fixture if available
    const fixture = context.fixtureStore?.find("getallwheelstires");
    if (fixture) {
      return { body: fixture.body, source: `fixture:${fixture.key}` };
    }
    // Fallback: return empty catalog
    return { body: `"s", 1, "d", "<p />"`, source: "stub:getallwheelstires" };
  },
  getonecarengine: handleGetOneCarEngine,
  getgearinfo: handleGetGearInfo,
  buydyno: handleBuyDyno,
  buypart: handleBuyPart,
  buyenginepart: handleBuyEnginePart,
  installpart: handleInstallPart,
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
  getblackcardprogress: handleGetBlackCardProgress,
  checktestdrive: handleCheckTestDrive,
  accepttestdrive: handleAcceptTestDrive,
  removetestdrivecar: handleRemoveTestDriveCar,
  rejecttestdrive: handleRejectTestDrive,
  teaminfo: handleTeamInfo,
  getteaminfo: handleTeamInfo,
  getleaderboardmenu: handleGetLeaderboardMenu,
  getleaderboard: handleGetLeaderboard,
  getnews: handleGetNews,
  getspotlightracers: handleGetSpotlightRacers,
  racersearch: handleGetRacerSearch,
  getdescription: handleGetDescription,
  getavatarage: handleGetAvatarAge,
  getteamavatarage: handleGetTeamAvatarAge,
  // --- Buddies ---
  getbuddies: handleGetBuddies,
  getbuddylist: handleGetBuddies,
  buddylist: handleGetBuddies,
  // --- Uploads ---
  uploadrequest: handleUploadRequest,
  // --- Race ---
  practice: handlePractice,
  // --- Computer Tournaments (10.0.03 source of truth) ---
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
      body: `"s", 1, "d", ""`,
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
      // TODO: Start race matching and create race instance
      // For now, just log that race could start
      context.logger.info("Race ready to start", { 
        roomId: room.roomId, 
        playerCount: result.room.players.length 
      });
      
      // Update room status to "starting"
      result.room.status = "starting";
      raceRoomRegistry.upsert(room.roomId, result.room);
      
      // Notify players that race is starting
      if (tcpNotify) {
        tcpNotify.broadcastToRoom(room.roomId, result.room, "race_starting");
      }
    }
    
    return {
      body: wrapSuccessData(`<ready s='1' ready='${ready ? 1 : 0}' canstart='${canStart ? 1 : 0}'/>`),
      source: "generated:setready",
    };
  },
};

export async function handleGameAction(context) {
  const { action, rawQuery, decodedQuery, fixtureStore, logger } = context;
  const handler = handlers[action];

  if (handler) {
    const result = await handler(context);
    if (result) {
      return result;
    }
  }

  const fixture = fixtureStore.find(decodedQuery, action, rawQuery);
  if (fixture) {
    return {
      body: fixture.body,
      source: `fixture:${fixture.key}`,
    };
  }

  logger.warn("No handler or fixture for action", { action, decodedQuery });
  // Return success stub so the client doesn't show error 003 for unknown actions.
  // Returning "s", 0 breaks the UI flow for many calls.
  return {
    body: `"s", 1`,
    source: "unimplemented:stub",
  };
}
