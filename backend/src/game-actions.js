import { buildLoginBody } from "./login-payload.js";
import { FULL_CAR_CATALOG } from "./car-catalog.js";
import { PARTS_CATALOG_XML } from "./parts-catalog.js";
import { randomUUID } from "node:crypto";
import { simulateQuarterMile, generateCarStatsXml } from "./drag-physics.js";
import {
  escapeXml,
  failureBody,
  renderOwnedGarageCarsWrapper,
  renderRacerCars,
  renderTeams,
  renderTwoRacerCars,
  renderUserSummaries,
  renderUserSummary,
  wrapSuccessData,
} from "./game-xml.js";
import { hashGamePassword, normalizeUsername, verifyGamePassword } from "./player-identity.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { createLoginSession, getSessionPlayerId, validateOrCreateSession } from "./session.js";
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
  updatePlayerLocation,
  updatePlayerMoney,
  getCarById,
} from "./user-service.js";

const DEFAULT_STARTER_CATALOG_CAR_ID = 1; // Acura Integra GSR
const DEFAULT_STOCK_WHEEL_XML = "<ws><w wid='1' id='1001' ws='17'/></ws>";
const DEFAULT_STOCK_PARTS_XML = "";
const DEFAULT_ENGINE_RESPONSE_BODY = `"s", 1, "d", "<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='2600' v='1.65' a='6800' n='7600' o='7800' s='0.815' b='0' p='0.15' c='11' e='0' d='T' f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='100' m='100' t='100' u='28' w='0.34' x='41.2' y='128' z='170' aa='4' ab='16' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' at='100' au='100' av='0' aw='100' ax='0'/>", "t", [91, 91, 91, 91, 91, 91, 91, 91, 91, 93, 95, 98, 102, 106, 109, 112, 115, 117, 119, 121, 122, 123, 124, 125, 126, 126, 127, 127, 128, 128, 128, 128, 128, 127, 127, 127, 126, 126, 125, 125, 124, 123, 122, 121, 120, 119, 118, 117, 116, 115, 113, 112, 110, 108, 106, 104, 101, 98, 98, 96, 95, 93, 91, 89, 87, 85, 83, 81, 79, 77, 75, 73, 71, 69, 67, 65, 63, 61, 59, 57, 55, 53, 51, 49, 47, 45, 43, 41, 39, 37, 35, 33, 31, 29, 27, 25, 23, 21, 19, 17, 15, 13]`;

const PART_ENTRY_REGEX = /<p\b([^>]*)\/>/g;
const PART_ATTR_REGEX = /(\w+)='([^']*)'/g;

let partsCatalogById = null;
let nextEmailId = 1;
const inboxByPlayerId = new Map();

function parseXmlAttributes(rawAttributes) {
  const attrs = {};
  let match;
  while ((match = PART_ATTR_REGEX.exec(rawAttributes)) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

function getPartsCatalogById() {
  if (partsCatalogById) {
    return partsCatalogById;
  }

  partsCatalogById = new Map();
  let match;
  while ((match = PART_ENTRY_REGEX.exec(PARTS_CATALOG_XML)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    const id = Number(attrs.i || 0);
    if (id > 0) {
      partsCatalogById.set(id, attrs);
    }
  }
  PART_ENTRY_REGEX.lastIndex = 0;
  return partsCatalogById;
}

function parseInstalledParts(partsXml) {
  if (!partsXml) {
    return [];
  }

  const installed = [];
  let match;
  while ((match = PART_ENTRY_REGEX.exec(partsXml)) !== null) {
    installed.push(parseXmlAttributes(match[1]));
  }
  PART_ENTRY_REGEX.lastIndex = 0;
  return installed;
}

function buildPartDescriptionNode(partId) {
  const part = getPartsCatalogById().get(Number(partId));
  if (!part) {
    return "<n2><d>Part information unavailable.</d></n2>";
  }

  const brand = part.bn || part.b || "Unknown";
  const name = part.n || "Unknown Part";
  const location = Number(part.l || 100);
  const price = Number(part.p || 0);
  const stats = [];

  const hp = Number(part.hp || 0);
  const tq = Number(part.tq || 0);
  const wt = Number(part.wt || 0);
  if (hp) stats.push(`${hp > 0 ? "+" : ""}${hp} hp`);
  if (tq) stats.push(`${tq > 0 ? "+" : ""}${tq} tq`);
  if (wt) stats.push(`${wt > 0 ? "+" : ""}${wt} lb`);

  const statSuffix = stats.length > 0 ? ` Stats: ${stats.join(", ")}.` : "";
  const sentence = `${name} upgrade from ${brand} available in ${location}${price ? ` for ${price}` : ""}.${statSuffix}`;

  return `<n2><d>${escapeXml(sentence)}</d></n2>`;
}

function buildCarPartsBinNode(partsXml) {
  const installed = parseInstalledParts(partsXml);
  const catalog = getPartsCatalogById();

  const items = installed
    .map((installedPart) => {
      const partId = Number(installedPart.i || 0);
      const catalogPart = catalog.get(partId);
      if (!catalogPart) {
        return null;
      }

      const merged = { ...catalogPart, ...installedPart };
      return `<p i='${merged.i}' pi='${merged.pi || 0}' t='${escapeXml(merged.t || "")}' n='${escapeXml(merged.n || "")}' p='${merged.p || 0}' pp='${merged.pp || 0}' g='${escapeXml(merged.g || "C")}' di='${merged.di || 0}' pdi='${merged.pdi || 0}' b='${escapeXml(merged.b || "generic")}' bn='${escapeXml(merged.bn || "Generic")}' mn='${escapeXml(merged.mn || "")}' l='${merged.l || 100}' mo='${merged.mo || 0}' hp='${merged.hp || 0}' tq='${merged.tq || 0}' wt='${merged.wt || 0}' cc='${merged.cc || 0}'/>`;
    })
    .filter(Boolean)
    .join("");

  return `<pb>${items}</pb>`;
}

function getInboxForPlayer(playerId) {
  const numericPlayerId = Number(playerId || 0);
  if (!inboxByPlayerId.has(numericPlayerId)) {
    inboxByPlayerId.set(numericPlayerId, []);
  }
  return inboxByPlayerId.get(numericPlayerId);
}

function formatLegacyEmailTimestamp(date = new Date()) {
  return date.toLocaleString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function buildEmailListNode(messages) {
  const items = messages
    .map(
      (message) =>
        `<e i='${message.id}' f='${escapeXml(message.fromUsername)}' s='${escapeXml(message.subject)}' d='${escapeXml(message.sentAt)}' n='${message.read ? 0 : 1}'/>`,
    )
    .join("");
  return `<inbox>${items}</inbox>`;
}

function buildEmailDetailNode(message) {
  if (!message) {
    return "<email></email>";
  }

  return `<email><e i='${message.id}' f='${escapeXml(message.fromUsername)}' t='${escapeXml(message.toUsername)}' s='${escapeXml(message.subject)}' d='${escapeXml(message.sentAt)}' b='${escapeXml(message.body)}'/></email>`;
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
    return { body: failureBody(), source: "supabase:login:missing-credentials" };
  }

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
    wheelXml: DEFAULT_STOCK_WHEEL_XML,
    partsXml: DEFAULT_STOCK_PARTS_XML,
  });
  const sessionKey = await createLoginSession({ supabase, playerId: player.id });
  return {
    body: buildLoginBody(player, cars, null, sessionKey, logger),
    source: "supabase:login",
  };
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
  const { supabase } = context;
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

  return {
    body: wrapSuccessData(renderOwnedGarageCarsWrapper(cars, { ownerPublicId: caller.publicId })),
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
  }

  return {
    body: DEFAULT_ENGINE_RESPONSE_BODY,
    source: "fixture:getonecarengine:default",
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
    return { body: failureBody(), source: "supabase:buydyno:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  // Response format: "s", 1, "d1", "ESCAPED_XML", "d", "ESCAPED_XML"
  // The XML must be escaped because it's being embedded as a string value in the response
  const gearRatios = "<g p='2500' pp='25'><r g1='3.587' g2='2.022' g3='1.384' g4='1' g5='0.861' g6='0' fg='4.058'/></g>";
  const transactionInfo = `<r s='2' b='${newBalance}' ai='0'/>`;
  
  return {
    body: `"s", 1, "d1", "${escapeXml(transactionInfo)}", "d", "${escapeXml(gearRatios)}"`,
    source: "supabase:buydyno",
  };
}

async function handleBuyPart(context) {
  const { supabase, params } = context;
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

  // For custom panel graphics (pt=p), price from catalog if not provided
  let price = partPrice;
  if (price === 0 && partType === "p" && partId) {
    const panelPrices = { 6001: 190, 6002: 135, 6003: 130, 6004: 110 };
    price = panelPrices[partId] || 0;
  }

  const newBalance = Number(player.money) - price;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buypart:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  // Custom panel graphic: rename uploaded file and save to parts_xml
  if (partType === "p" && decalId && accountCarId) {
    const { data: car } = await supabase
      .from("game_cars")
      .select("parts_xml, game_car_id")
      .eq("game_car_id", accountCarId)
      .maybeSingle();

    if (car) {
      // ci from fixture: 6001=side(161), 6002=back(163), 6003=front(162), 6004=hood(160)
      const partCiMap = { 6001: 161, 6002: 163, 6003: 162, 6004: 160 };
      const ci = partCiMap[partId] || 161;

      // Rename uploaded jpg to the path Flash expects: cache/car/userDecals/{ci}_{di}.swf
      try {
        const { readdirSync, renameSync, mkdirSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const decalDir = resolve(process.cwd(), "../cache/car/userDecals");
        mkdirSync(decalDir, { recursive: true });
        const files = readdirSync(decalDir).filter(f => f.endsWith(".jpg")).sort().reverse();
        if (files.length > 0) {
          renameSync(resolve(decalDir, files[0]), resolve(decalDir, `${ci}_${decalId}.swf`));
        }
      } catch (err) {
        context.logger?.error("Failed to rename decal", { error: err.message });
      }

      let partsXml = car.parts_xml || "";
      partsXml = partsXml.replace(new RegExp(`<p[^>]*\\bci='${ci}'[^>]*/>`,"g"), "");
      partsXml += `<p i='${partId}' ci='${ci}' n='Custom Graphic' in='1' cc='0' pdi='${decalId}' di='${decalId}' pt='c' ps=''/>`;
      await supabase.from("game_cars").update({ parts_xml: partsXml }).eq("game_car_id", accountCarId);
    }
  }

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${accountCarId}'/>", "d", "<r s='1' b='0'></r>"`,
    source: "supabase:buypart",
  };
}

async function handleBuyEnginePart(context) {
  const { supabase, params } = context;
  const accountCarId = params.get("acid") || "";
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

  const newBalance = Number(player.money) - partPrice;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buyenginepart:insufficient-funds" };
  }

  await updatePlayerMoney(supabase, caller.playerId, newBalance);

  return {
    body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='${accountCarId}'/>", "d", "<r s='1' b='0'></r>"`,
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

  const player = await getPlayerById(supabase, caller.playerId);
  if (!player) {
    return { body: failureBody(), source: "supabase:buycar:no-player" };
  }

  const purchasePrice = parseShowroomPurchasePrice(params);
  const newBalance = Number(player.money) - purchasePrice;
  if (newBalance < 0) {
    return { body: failureBody(), source: "supabase:buycar:insufficient-funds" };
  }

  const existingCars = await listCarsForPlayer(supabase, caller.playerId);
  const createdCar = await createOwnedCar(supabase, {
    playerId: caller.playerId,
    catalogCarId,
    selected: existingCars.length === 0,
    paintIndex: 4,
    plateName: "",
    colorCode: "C0C0C0",
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

  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:checktestdrive");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:checktestdrive:bad-session",
      };
    }
  }

  // Response format: "s", -2 (no test drive available)
  return {
    body: `"s", -2`,
    source: "checktestdrive:none",
  };
}

// ---------------------------------------------------------------------------
// Stub / generated handlers — actions the Python server handled that are not
// in our fixture data. Returning "s", 0 for any of these causes the game to
// emit "error 003" on the client. All stubs return "s", 1 (OK) with minimal
// valid XML so the client can move on.
// ---------------------------------------------------------------------------

const DEALER_CATEGORIES = [
  { i: "100", pi: "0", n: "Toreno Showroom",       cl: "55AACC", l: "100" },
  { i: "200", pi: "0", n: "Newburge Showroom",     cl: "55CC55", l: "200" },
  { i: "300", pi: "0", n: "Creek Side Showroom",   cl: "CCAA55", l: "300" },
  { i: "400", pi: "0", n: "Vista Heights Showroom",cl: "CC5555", l: "400" },
  { i: "500", pi: "0", n: "Diamond Point Showroom",cl: "CC55CC", l: "500" },
];

function buildShowroomXml(locationId, starterOnly = false, focusCarId = "") {
  const currentLocationId = Number(locationId || 100);
  const eligible = starterOnly
    ? FULL_CAR_CATALOG.filter(([, , price]) => Number(price) <= 30000)
    : FULL_CAR_CATALOG.filter(([, , , carLocationId]) => Number(carLocationId) <= currentLocationId);

  const desiredCarId = String(focusCarId || "").trim();
  const eligibleIds = new Set(eligible.map(([cid]) => String(cid)));
  const defaultCarId = desiredCarId && eligibleIds.has(desiredCarId) ? desiredCarId : eligible[0]?.[0] || "0";

  const carNodes = eligible
    .map(([cid, name, price, carLocationId]) => {
      const escapedName = escapeXml(name);
      const carLid = String(carLocationId);
      const catId = Number(carLocationId) || 100;
      const defaultWheelXml = "<ws><w wid='1' id='1001' ws='17'/></ws>";
      const defaultPaintXml = "<ps><p cd='C0C0C0'/></ps>";
      const selected = String(cid) === String(defaultCarId) ? "1" : "0";
      return (
        `<c ai='0' id='${cid}' i='${cid}' ci='${cid}' sel='${selected}' pi='4' pn='' lk='0' ae='0' cc='C0C0C0' ii='0' ` +
        `n='${escapedName}' c='${escapedName}' p='${price}' pr='${price}' l='${carLid}' lid='${carLid}' cid='${catId}' ` +
        `eo='2.0L I4' dt='FWD' np='4' ct='Coupe' et='15.00 sec 1/4' tt='140 mph top speed' sw='2800' st='7.0' y='2005' ` +
        `wid='${catId}' ws='17'>${defaultWheelXml}${defaultPaintXml}</c>`
      );
    })
    .join("");

  return `<cars i='0' dc='${defaultCarId}' l='${currentLocationId}'>${carNodes}</cars>`;
}

function getCatalogCarLocationId(catalogCarId) {
  const needle = String(catalogCarId || "").trim();
  if (!needle) return 0;

  const entry = FULL_CAR_CATALOG.find(([cid]) => String(cid) === needle);
  return entry ? Number(entry[3] || 0) : 0;
}

async function handleMoveLocation(context) {
  const { supabase, params } = context;
  const locationId = Number(params.get("lid") || params.get("l") || params.get("id") || 0);

  if (!supabase || !locationId) {
    return { body: `"s", 1`, source: "stub:movelocation" };
  }

  const caller = await resolveCallerSession(context, "supabase:movelocation");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:movelocation:bad-session",
    };
  }

  await updatePlayerLocation(supabase, caller.playerId, locationId);
  return { body: `"s", 1`, source: `supabase:movelocation:${locationId}` };
}

async function handleListClassified(context) {
  // Empty classified ads list.
  return {
    body: wrapSuccessData(`<cars i='0' dc='0'></cars>`),
    source: "stub:listclassified",
  };
}

async function handleViewShowroom(context) {
  const { params, supabase, logger } = context;
  const focusCarId = params.get("cid") || params.get("carid") || params.get("skipToCar") || "";
  let locationId = Number(params.get("lid") || params.get("l") || 0);

  // If the caller is trying to jump to a specific car (banner route), derive
  // the dealer location from the canonical car catalog when lid is omitted.
  if (!locationId && focusCarId) {
    locationId = getCatalogCarLocationId(focusCarId);
  }

  // If no lid provided, use the player's current location from their profile
  if (!locationId && supabase) {
    const caller = await resolveCallerSession(context, "supabase:viewshowroom");
    if (caller?.ok) {
      const player = await getPlayerById(supabase, caller.playerId);
      locationId = Number(player?.location_id || 100);
    }
  }

  if (!locationId) locationId = 100;

  const xml = buildShowroomXml(locationId, false, focusCarId);
  logger?.info("buildShowroomXml", {
    locationId,
    focusCarId: focusCarId || null,
    xmlLength: xml.length,
    xmlPreview: xml.substring(0, 400),
  });
  return {
    body: wrapSuccessData(xml),
    source: `stub:viewshowroom:lid=${locationId}:focus=${focusCarId || "none"}`,
  };
}

async function handleGetStarterShowroom(context) {
  const { logger, params } = context;
  const focusCarId = params?.get("cid") || params?.get("carid") || params?.get("skipToCar") || "";
  const xml = buildShowroomXml(100, true, focusCarId);
  logger?.info("buildStarterShowroomXml", {
    locationId: 100,
    focusCarId: focusCarId || null,
    xmlLength: xml.length,
    xmlPreview: xml.substring(0, 400),
  });
  return {
    body: wrapSuccessData(xml),
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
      return {
        body: `"s", 1, "d1", "<r s='2' b='${newBalance}' ai='0'/>", "d", "<r s='1' b='0"></r>"`,
        source: "supabase:sellcar",
      };
    }
  }

  return { body: `"s", 1`, source: "stub:sellcar" };
}

async function handleGetCarCategories(context) {
  const { logger } = context;
  const catNodes = DEALER_CATEGORIES
    .map((c) => `<c i='${c.i}' pi='${c.pi}' n='${escapeXml(c.n)}' cl='${c.cl}' l='${c.l}'/>`)
    .join("");
  logger?.info("buildCarCategoriesXml", {
    count: DEALER_CATEGORIES.length,
    xmlPreview: `<cats>${catNodes}</cats>`,
  });
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
  const { logger, params, supabase } = context;
  
  // Get the car ID from the request
  const carId = params.get("acid");
  
  // Practice / time trial response with car performance data
  // CRITICAL FIX: Flash expects n2.firstChild to be an <r> element with attributes
  // The self-closing <n2 .../> causes "TypeError: r has no properties" in Flash
  // because n2.firstChild returns null when there are no child elements.
  // 
  // Structure: <n2 ...><r g1='...' g2='...' .../></n2>
  // - n2 attributes: race/track metadata
  // - r child element: gear ratios and additional race data
  
  let carStats;
  let timing;
  let catalogCarId = 1; // Default to Integra
  let partsXml = '';
  
  try {
    // Try to get car from database
    if (supabase && carId) {
      const car = await getCarById(supabase, parseInt(carId));
      if (car) {
        catalogCarId = car.catalog_car_id;
        partsXml = car.parts_xml || '';
      }
    }
    
    // Run physics simulation
    const simulation = simulateQuarterMile(catalogCarId, partsXml);
    
    // Generate car stats XML
    carStats = generateCarStatsXml(catalogCarId, partsXml, carId);
    timing = simulation.timingArray;
    
    if (logger) {
      logger.info("Practice physics simulation", {
        carId,
        catalogCarId,
        et: simulation.elapsedTime,
        trapSpeed: simulation.trapSpeed,
        hp: simulation.performance.hp,
        weight: simulation.performance.weight
      });
    }
  } catch (error) {
    // Fallback to default values if physics fails
    if (logger) {
      logger.warn("Physics simulation failed, using defaults", { error: error.message });
    }
    
    carStats = 
      "<n2 es='1' sl='7200' sg='0' rc='0' tmp='0' r='3257' v='2.3136531365313653' " +
      "a='6800' n='7600' o='7800' s='1.208' b='0' p='0.15' c='11' e='0' d='T' " +
      "f='3.587' g='2.022' h='1.384' i='1' j='0.861' k='0' l='4.058' q='300' " +
      "m='72.25' t='100' u='28' w='0.4711' x='65.43' y='518.21' z='94.22' " +
      `aa='4' ab='${carId}' ac='9' ad='0' ae='100' af='100' ag='100' ah='100' ai='100' ` +
      "aj='0' ak='0' al='0' am='0' an='0' ao='100' ap='0' aq='0' ar='1' as='0' " +
      "at='100' au='100' av='0' aw='100' ax='0'>" +
      "<r g1='2.5' g2='1.8' g3='1.3' g4='1.0' g5='0.8' g6='0.7'/>" +
      "</n2>";
    
    timing = [266,266,266,266,266,266,266,266,266,365,376,388,399,410,421,432,443,455,466,477,488,499,510,522,533,544,555,566,577,589,598,600,603,605,608,610,612,615,617,619,622,624,627,629,631,634,636,638,641,643,646,648,650,653,655,657,660,662,662,655,647,639,632,624,616,608,601,593,585,578,570,562,554,547,539,531,523,515,506,498,490,481,473,465,457,448,440,432,423,415,407,398,390,382,374,365,357,349,340,332];
  }
  
  // Format: "s", 1, "d", "<xml/>", "t", [array]
  // XML is embedded directly with single quotes - no escaping needed since it's wrapped in double quotes
  // Array MUST have spaces after commas to match fixture format
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
    source: "generated:practice:physics" 
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
  const partId = Number(context.params.get("id") || 0);
  return {
    body: wrapSuccessData(buildPartDescriptionNode(partId)),
    source: "generated:getdescription",
  };
}

async function handleGetCarPartsBin(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getcarpartsbin");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:getcarpartsbin:bad-session",
    };
  }

  const accountCarId = Number(params.get("acid") || 0);
  if (!accountCarId) {
    return { body: wrapSuccessData("<pb></pb>"), source: "supabase:getcarpartsbin:missing-car" };
  }

  const car = await getCarById(supabase, accountCarId);
  if (!car || Number(car.player_id) !== Number(caller.playerId)) {
    return { body: wrapSuccessData("<pb></pb>"), source: "supabase:getcarpartsbin:not-found" };
  }

  return {
    body: wrapSuccessData(buildCarPartsBinNode(car.parts_xml || "")),
    source: "supabase:getcarpartsbin",
  };
}

async function handleGetUserRemarks(context) {
  const { supabase } = context;
  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getuserremarks");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getuserremarks:bad-session",
      };
    }
  }

  return {
    body: wrapSuccessData("<remarks/>"),
    source: "getuserremarks:empty",
  };
}

async function handleGetAllMyApps(context) {
  const { supabase } = context;
  if (supabase) {
    const caller = await resolveCallerSession(context, "supabase:getallmyapps");
    if (!caller?.ok) {
      return {
        body: caller?.body || failureBody(),
        source: caller?.source || "supabase:getallmyapps:bad-session",
      };
    }
  }

  return {
    body: wrapSuccessData("<apps/>"),
    source: "getallmyapps:empty",
  };
}

async function handleGetEmailList(context) {
  const { supabase } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getemaillist");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:getemaillist:bad-session",
    };
  }

  return {
    body: wrapSuccessData(buildEmailListNode(getInboxForPlayer(caller.playerId))),
    source: "supabase:getemaillist",
  };
}

async function handleSendEmail(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:sendemail");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:sendemail:bad-session",
    };
  }

  const toUsername = normalizeUsername(params.get("tu") || params.get("to") || params.get("u"));
  const subject = params.get("s") || "";
  const bodyText = params.get("b") || "";
  if (!toUsername) {
    return { body: failureBody(), source: "supabase:sendemail:missing-recipient" };
  }

  const recipient = await getPlayerByUsername(supabase, toUsername);
  if (!recipient) {
    return { body: failureBody(), source: "supabase:sendemail:missing-recipient" };
  }

  const sender = await getPlayerById(supabase, caller.playerId);
  const message = {
    id: nextEmailId++,
    fromUsername: sender?.username || "Player",
    toUsername: recipient.username,
    subject,
    body: bodyText,
    sentAt: formatLegacyEmailTimestamp(),
    read: false,
  };
  getInboxForPlayer(recipient.id).unshift(message);

  return {
    body: `"s", 1`,
    source: "supabase:sendemail",
  };
}

async function handleGetEmail(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:getemail");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:getemail:bad-session",
    };
  }

  const emailId = Number(params.get("id") || params.get("i") || 0);
  const inbox = getInboxForPlayer(caller.playerId);
  const message = inbox.find((entry) => Number(entry.id) === emailId) || null;
  if (message) {
    message.read = true;
  }

  return {
    body: wrapSuccessData(buildEmailDetailNode(message)),
    source: "supabase:getemail",
  };
}

async function handleMarkEmailRead(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:markemailread");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:markemailread:bad-session",
    };
  }

  const emailId = Number(params.get("id") || params.get("i") || 0);
  const message = getInboxForPlayer(caller.playerId).find((entry) => Number(entry.id) === emailId);
  if (message) {
    message.read = true;
  }

  return {
    body: `"s", 1`,
    source: "supabase:markemailread",
  };
}

async function handleDeleteEmail(context) {
  const { supabase, params } = context;
  if (!supabase) {
    return null;
  }

  const caller = await resolveCallerSession(context, "supabase:deleteemail");
  if (!caller?.ok) {
    return {
      body: caller?.body || failureBody(),
      source: caller?.source || "supabase:deleteemail:bad-session",
    };
  }

  const emailId = Number(params.get("id") || params.get("i") || 0);
  const inbox = getInboxForPlayer(caller.playerId);
  const index = inbox.findIndex((entry) => Number(entry.id) === emailId);
  if (index >= 0) {
    inbox.splice(index, 1);
  }

  return {
    body: `"s", 1`,
    source: "supabase:deleteemail",
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
  sellcar: handleSellCar,
  // --- Parts & Engine ---
  getallparts: handleGetAllParts,
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
  // --- Showroom / Dealership ---
  buycar: handleBuyCar,
  buyshowroomcar: handleBuyCar,
  buystartercar: handleBuyCar,
  buydealercar: handleBuyCar,
  buytestdrivecar: handleBuyCar,
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
  getremarks: handleGetRemarks,
  getuserremarks: handleGetUserRemarks,
  getallmyapps: handleGetAllMyApps,
  getblackcardprogress: handleGetBlackCardProgress,
  getemaillist: handleGetEmailList,
  sendemail: handleSendEmail,
  getemail: handleGetEmail,
  markemailread: handleMarkEmailRead,
  deleteemail: handleDeleteEmail,
  checktestdrive: handleCheckTestDrive,
  teaminfo: handleTeamInfo,
  getteaminfo: handleTeamInfo,
  getleaderboardmenu: handleGetLeaderboardMenu,
  getleaderboard: handleGetLeaderboard,
  getnews: handleGetNews,
  getspotlightracers: handleGetSpotlightRacers,
  racersearch: handleGetRacerSearch,
  getdescription: handleGetDescription,
  getcarpartsbin: handleGetCarPartsBin,
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
  // --- Race Rooms / Rivals ---
  ctgr: async (context) => {
    // Get categories/race rooms list
    const { services, logger } = context;
    const raceRoomRegistry = services?.raceRoomRegistry;
    
    logger.info("ctgr called - getting race room list");
    
    // Get all active rooms
    const rooms = raceRoomRegistry ? raceRoomRegistry.list() : [];
    
    // If no rooms exist, create default rooms for each strip type
    if (rooms.length === 0 && raceRoomRegistry) {
      logger.info("Creating default race rooms");
      // Create default rooms for each strip
      const defaultRooms = [
        { id: 1, name: "Team Rivals Strip", type: "team", maxPlayers: 8 },
        { id: 2, name: "Tournament Strip", type: "tournament", maxPlayers: 32 },
        { id: 3, name: "Bracket King of the Hill Strip", type: "bracket_koth", maxPlayers: 16 },
        { id: 4, name: "H2H King of the Hill Strip", type: "h2h_koth", maxPlayers: 8 },
      ];
      
      for (const room of defaultRooms) {
        raceRoomRegistry.upsert(room.id, {
          name: room.name,
          type: room.type,
          maxPlayers: room.maxPlayers,
          players: [],
          status: "waiting",
        });
      }
    }
    
    // Build room XML
    const roomList = raceRoomRegistry ? raceRoomRegistry.list() : [];
    const roomsXml = roomList.map(room => {
      const playerCount = room.players?.length || 0;
      return `<room id='${room.roomId}' name='${escapeXml(room.name)}' type='${room.type}' players='${playerCount}' max='${room.maxPlayers}' status='${room.status}'/>`;
    }).join('');
    
    logger.info("ctgr response", { roomCount: roomList.length, roomsXml });
    
    return {
      body: wrapSuccessData(`<rooms>${roomsXml}</rooms>`),
      source: "generated:ctgr",
    };
  },
  ctjt: async (context) => {
    // Join category/tournament room
    const { params, services, supabase } = context;
    const categoryId = params.get("ctid") || "1";
    const raceRoomRegistry = services?.raceRoomRegistry;
    const tcpNotify = services?.tcpNotify;
    
    if (!raceRoomRegistry) {
      return {
        body: wrapSuccessData(`<room ctid='${categoryId}' error='no_registry'/>`),
        source: "stub:ctjt:no-registry",
      };
    }
    
    // Get the room
    const room = raceRoomRegistry.get(categoryId);
    
    if (!room) {
      return {
        body: wrapSuccessData(`<room ctid='${categoryId}' error='not_found'/>`),
        source: "stub:ctjt:not-found",
      };
    }
    
    // Get player info from session
    const caller = await resolveCallerSession(context, "ctjt");
    if (!caller?.ok) {
      return {
        body: wrapSuccessData(`<room ctid='${categoryId}' error='invalid_session'/>`),
        source: "ctjt:bad-session",
      };
    }
    
    const player = await getPlayerById(supabase, caller.playerId);
    if (!player) {
      return {
        body: wrapSuccessData(`<room ctid='${categoryId}' error='player_not_found'/>`),
        source: "ctjt:no-player",
      };
    }
    
    // Add player to room
    const result = raceRoomRegistry.addPlayer(categoryId, {
      id: player.id,
      publicId: player.public_id,
      name: player.username,
    });
    
    if (!result.success) {
      return {
        body: wrapSuccessData(`<room ctid='${categoryId}' error='${result.error}'/>`),
        source: `ctjt:${result.error}`,
      };
    }
    
    // NOTE: Do NOT send RU broadcasts - the Flash client doesn't understand that message type
    
    // Return room details with all players
    const updatedRoom = result.room;
    const playerCount = updatedRoom.players?.length || 0;
    const playersXml = (updatedRoom.players || []).map(p => 
      `<player id='${p.publicId}' name='${escapeXml(p.name)}' ready='${p.ready ? 1 : 0}'/>`
    ).join('');
    
    return {
      body: wrapSuccessData(
        `<room id='${updatedRoom.roomId}' name='${escapeXml(updatedRoom.name)}' type='${updatedRoom.type}' players='${playerCount}' max='${updatedRoom.maxPlayers}' status='${updatedRoom.status}'>${playersXml}</room>`
      ),
      source: "generated:ctjt",
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
