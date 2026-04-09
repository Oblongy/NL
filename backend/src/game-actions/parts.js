import { PARTS_CATALOG_XML } from "../parts-catalog.js";
import { normalizeOwnedPartsXmlValue } from "../parts-xml.js";
import { escapeXml, failureBody, wrapSuccessData } from "../game-xml.js";
import { resolveCallerSession } from "../game-actions-helpers.js";
import {
  getPlayerById,
  updatePlayerMoney,
  getCarById,
  listPartsInventoryForPlayer,
  getPartInventoryItemById,
  addPartInventoryItem,
  consumePartInventoryItem,
} from "../user-service.js";

/**
 * Parts management module
 * Handles parts catalog, buying, installing, and inventory
 */

const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)='([^']*)'/g;

let partsCatalogById = null;

function parsePartXmlAttributes(rawEntry) {
  const attrs = {};
  let match;
  while ((match = PART_XML_ATTR_REGEX.exec(rawEntry)) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_XML_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

export function getPartsCatalogById() {
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

export function createInstalledPartId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
}

export function upsertInstalledPartXml(partsXml, slotId, partXml, slotAttr = "pi") {
  const source = String(partsXml || "");
  const escapedSlotId = String(slotId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<p[^>]*\\b(?:${slotAttr}|ci)='${escapedSlotId}'[^>]*/>`, "g");
  const cleaned = source.replace(pattern, "");
  return `${cleaned}${partXml}`;
}

export function buildInstalledCatalogPartXml(catalogPart, installId, overrides = {}) {
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

export function buildOwnedInstalledCatalogPartXml(catalogPart, installId, overrides = {}) {
  return normalizeOwnedPartsXmlValue(buildInstalledCatalogPartXml(catalogPart, installId, overrides));
}

export function findInstalledPartBySlotId(partsXml, slotId) {
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

export function buildPartsInventoryXml(items) {
  const partsXml = items.map((item) => item.xml).join("");
  return `<n2>${partsXml}</n2>`;
}

export async function handleGetAllParts(context) {
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

export async function handleBuyPart(context) {
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

export async function handleBuyEnginePart(context) {
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

export async function handleGetCarPartsBin(context) {
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

export async function handleInstallPart(context) {
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
