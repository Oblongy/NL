/**
 * api-routes.js — JSON REST API for the custom Tauri client.
 *
 * Exposes /api/* endpoints that wrap existing game-actions.js handlers.
 * No existing files are modified — this file is mounted additively in index.js.
 *
 * Auth: HMAC-SHA256 JWT (custom client only). Flash client session keys unchanged.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { handleGameAction } from "./game-actions.js";

// ---------------------------------------------------------------------------
// JWT helpers (no external library — pure Node.js crypto)
// ---------------------------------------------------------------------------

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

/**
 * Sign a JWT payload with HMAC-SHA256.
 * @param {object} payload
 * @param {string} secret
 * @param {number} ttlSeconds
 * @returns {string} signed JWT
 */
export function signJwt(payload, secret, ttlSeconds = 86400) {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + ttlSeconds };
  const body = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${body}`;
  const sig = base64urlEncode(
    createHmac("sha256", secret).update(signingInput).digest()
  );
  return `${signingInput}.${sig}`;
}

/**
 * Verify a JWT. Throws on invalid signature or expiry.
 * @param {string} token
 * @param {string} secret
 * @returns {object} decoded payload
 */
export function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed-jwt");

  const [header, body, sig] = parts;
  const signingInput = `${header}.${body}`;
  const expected = base64urlEncode(
    createHmac("sha256", secret).update(signingInput).digest()
  );

  // Constant-time comparison
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(sig);
  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error("invalid-signature");
  }

  let claims;
  try {
    claims = JSON.parse(base64urlDecode(body).toString("utf8"));
  } catch {
    throw new Error("malformed-payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error("token-expired");

  return claims;
}

// ---------------------------------------------------------------------------
// Body / query parsing helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("invalid-json");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body, "utf8");
}

// ---------------------------------------------------------------------------
// JWT auth middleware
// ---------------------------------------------------------------------------

function extractJwt(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  // Also accept ?token= query param (used by WS upgrade)
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("token") || null;
}

function requireAuth(req, res, jwtSecret) {
  const token = extractJwt(req);
  if (!token) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return null;
  }
  try {
    return verifyJwt(token, jwtSecret);
  } catch {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return null;
  }
}

// ---------------------------------------------------------------------------
// XML response parsers
// ---------------------------------------------------------------------------

/**
 * Parse the key-value tuple body returned by game-actions.
 * Format: `"key", value, "key2", value2, ...`
 * Returns a plain object.
 */
function parseTupleBody(body) {
  const result = {};
  // Match "key", value pairs — value can be number, string, or quoted string
  const re = /"([^"]+)",\s*(?:"([^"]*)"|([-\d.]+))/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    result[m[1]] = m[2] !== undefined ? m[2] : Number(m[3]);
  }
  return result;
}

/**
 * Extract the XML data payload from a tuple body.
 * Looks for `"d", "<xml...>"` pattern.
 */
function extractXmlData(body) {
  const m = String(body || "").match(/"d",\s*"([\s\S]*)"/);
  return m ? m[1].replace(/\\"/g, '"') : null;
}

/**
 * Parse garage XML into a structured car array.
 * The garage XML contains <c ...> elements with car attributes.
 */
function parseGarageXml(xmlData) {
  if (!xmlData) return [];
  const cars = [];
  const carRe = /<c\b([^>]*)\/?>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let m;
  while ((m = carRe.exec(xmlData)) !== null) {
    const attrStr = m[1] || m[2] || "";
    const inner = m[3] || "";
    const attrs = parseXmlAttrs(attrStr);
    cars.push({
      gameCarId: Number(attrs.i || attrs.id || 0),
      catalogCarId: Number(attrs.ci || attrs.cid || 0),
      name: attrs.n || attrs.name || "",
      selected: attrs.sel === "1" || attrs.selected === "1",
      paintIndex: Number(attrs.pi || attrs.paint || 0),
      partsXml: inner.trim() || "",
      engineState: {
        condition: Number(attrs.ec || 100),
        engineTypeId: Number(attrs.et || 0),
      },
    });
  }
  return cars;
}

/**
 * Parse XML attributes string into a plain object.
 */
function parseXmlAttrs(attrStr) {
  const attrs = {};
  const re = /(\w+)=['"]([^'"]*)['"]/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Parse car catalog XML into a structured array.
 */
function parseCarCatalogXml(xmlData) {
  if (!xmlData) return [];
  const cars = [];
  const re = /<c\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(xmlData)) !== null) {
    const attrs = parseXmlAttrs(m[1]);
    cars.push({
      id: Number(attrs.i || 0),
      name: attrs.n || "",
      price: Number(attrs.p || 0),
      class: attrs.cl || attrs.c || "",
      catalogCarId: Number(attrs.i || 0),
    });
  }
  return cars;
}

/**
 * Parse parts catalog XML into a structured array.
 */
function parsePartsCatalogXml(xmlData) {
  if (!xmlData) return [];
  const parts = [];
  const re = /<p\b([^>]*)\/>/g;
  let m;
  while ((m = re.exec(xmlData)) !== null) {
    const attrs = parseXmlAttrs(m[1]);
    parts.push({
      id: Number(attrs.i || 0),
      name: attrs.n || "",
      slotId: attrs.pi || attrs.ci || "",
      price: Number(attrs.p || 0),
      pointPrice: Number(attrs.pp || 0),
      type: attrs.t || "",
      grade: attrs.g || "",
      brand: attrs.bn || "",
      hp: Number(attrs.hp || 0),
      tq: Number(attrs.tq || 0),
      weight: Number(attrs.wt || 0),
    });
  }
  return parts;
}

/**
 * Parse the partsXml from an install/uninstall response.
 * The response body contains the updated parts XML.
 */
function parsePartsXmlFromResponse(body) {
  // Try to extract from "d", "<parts>..." pattern
  const xmlData = extractXmlData(body);
  if (xmlData) return xmlData;
  // Fallback: return the raw body if it looks like XML
  if (String(body || "").trim().startsWith("<")) return body;
  return "";
}

/**
 * Check if a tuple body indicates success (s=1).
 */
function isSuccess(body) {
  const tuple = parseTupleBody(String(body || ""));
  return Number(tuple.s || 0) === 1;
}

/**
 * Extract error code from a failure body.
 */
function extractError(body) {
  const tuple = parseTupleBody(String(body || ""));
  const s = Number(tuple.s || 0);
  if (s === -3) return "insufficient-funds";
  if (s === -2) return "already-exists";
  if (s === -4) return "not-found";
  if (s === -18) return "missing-credentials";
  if (s < 0) return `game-error-${Math.abs(s)}`;
  return "unknown-error";
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleLogin(req, res, { supabase, logger, services, jwtSecret }) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid-json" });
  }

  const { username, password } = body;
  if (!username) return sendJson(res, 400, { ok: false, error: "missing-field", field: "username" });
  if (!password) return sendJson(res, 400, { ok: false, error: "missing-field", field: "password" });

  const params = new URLSearchParams({ u: username, p: password });
  const result = await handleGameAction({
    action: "login",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  if (!result || !isSuccess(result.body)) {
    return sendJson(res, 401, { ok: false, error: "invalid-credentials" });
  }

  // Extract player info from the login body
  const tuple = parseTupleBody(result.body);
  const playerId = Number(tuple.aid || tuple.id || 0);
  const sessionKey = String(tuple.sk || tuple.s || "");
  const money = Number(tuple.b || tuple.money || 0);
  const defaultCarId = Number(tuple.cid || tuple.ci || 0);

  // Also try to extract from XML data
  const xmlData = extractXmlData(result.body);
  let parsedUsername = username;
  if (xmlData) {
    const unMatch = xmlData.match(/un=['"]([^'"]+)['"]/);
    if (unMatch) parsedUsername = unMatch[1];
  }

  const jwt = signJwt(
    { sub: playerId, username: parsedUsername, sk: sessionKey },
    jwtSecret,
    86400
  );

  return sendJson(res, 200, {
    ok: true,
    jwt,
    playerId,
    username: parsedUsername,
    defaultCarId,
    money,
    sessionKey,
  });
}

async function handleGetGarage(req, res, { supabase, logger, services, jwtSecret }) {
  const claims = requireAuth(req, res, jwtSecret);
  if (!claims) return;

  const params = new URLSearchParams({ sk: claims.sk || "", aid: String(claims.sub || "") });
  const result = await handleGameAction({
    action: "getgarage",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  const xmlData = extractXmlData(result?.body || "");
  const cars = parseGarageXml(xmlData);

  return sendJson(res, 200, { ok: true, cars });
}

async function handleGetCatalogCars(req, res, { supabase, logger, services, jwtSecret }) {
  const claims = requireAuth(req, res, jwtSecret);
  if (!claims) return;

  const params = new URLSearchParams({ sk: claims.sk || "" });
  const result = await handleGameAction({
    action: "getcars",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  const xmlData = extractXmlData(result?.body || "") || result?.body || "";
  const cars = parseCarCatalogXml(xmlData);

  return sendJson(res, 200, { ok: true, cars });
}

async function handleGetCatalogParts(req, res, { supabase, logger, services, jwtSecret }) {
  const claims = requireAuth(req, res, jwtSecret);
  if (!claims) return;

  const params = new URLSearchParams({ sk: claims.sk || "" });
  const result = await handleGameAction({
    action: "getpartsbin",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  const xmlData = extractXmlData(result?.body || "") || result?.body || "";
  const parts = parsePartsCatalogXml(xmlData);

  return sendJson(res, 200, { ok: true, parts });
}

async function handleInstallPart(req, res, { supabase, logger, services, jwtSecret }) {
  const claims = requireAuth(req, res, jwtSecret);
  if (!claims) return;

  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid-json" });
  }

  const { carId, partId } = body;
  if (!carId) return sendJson(res, 400, { ok: false, error: "missing-field", field: "carId" });
  if (!partId) return sendJson(res, 400, { ok: false, error: "missing-field", field: "partId" });

  const params = new URLSearchParams({
    sk: claims.sk || "",
    acid: String(carId),
    pid: String(partId),
  });

  const result = await handleGameAction({
    action: "installpart",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  if (!result || !isSuccess(result.body)) {
    return sendJson(res, 400, { ok: false, error: extractError(result?.body || "") });
  }

  const partsXml = parsePartsXmlFromResponse(result.body);
  return sendJson(res, 200, { ok: true, partsXml });
}

async function handleUninstallPart(req, res, { supabase, logger, services, jwtSecret }) {
  const claims = requireAuth(req, res, jwtSecret);
  if (!claims) return;

  let body;
  try {
    body = await parseJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid-json" });
  }

  const { carId, installId } = body;
  if (!carId) return sendJson(res, 400, { ok: false, error: "missing-field", field: "carId" });
  if (!installId) return sendJson(res, 400, { ok: false, error: "missing-field", field: "installId" });

  const params = new URLSearchParams({
    sk: claims.sk || "",
    acid: String(carId),
    ai: String(installId),
  });

  const result = await handleGameAction({
    action: "uninstallpart",
    params,
    rawQuery: params.toString(),
    decodedQuery: params.toString(),
    supabase,
    logger,
    services,
  });

  if (!result || !isSuccess(result.body)) {
    return sendJson(res, 400, { ok: false, error: extractError(result?.body || "") });
  }

  const partsXml = parsePartsXmlFromResponse(result.body);
  return sendJson(res, 200, { ok: true, partsXml });
}

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

function handleOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Length": "0",
  });
  res.end();
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the JSON API router.
 *
 * Returns an async middleware function `(req, res, next) => void`.
 * Call `next()` for paths that don't match /api/* so the existing
 * http-server handler can take over.
 *
 * @param {{ supabase, logger, services, jwtSecret: string }} opts
 * @returns {Function}
 */
export function createApiRouter({ supabase, logger, services, jwtSecret }) {
  if (!jwtSecret) {
    throw new Error("createApiRouter: jwtSecret is required");
  }

  const ctx = { supabase, logger, services, jwtSecret };

  return async function apiRouter(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method?.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS" && path.startsWith("/api/")) {
      return handleOptions(res);
    }

    try {
      if (method === "POST" && path === "/api/login") {
        return await handleLogin(req, res, ctx);
      }
      if (method === "GET" && path === "/api/garage") {
        return await handleGetGarage(req, res, ctx);
      }
      if (method === "GET" && path === "/api/catalog/cars") {
        return await handleGetCatalogCars(req, res, ctx);
      }
      if (method === "GET" && path === "/api/catalog/parts") {
        return await handleGetCatalogParts(req, res, ctx);
      }
      if (method === "POST" && path === "/api/parts/install") {
        return await handleInstallPart(req, res, ctx);
      }
      if (method === "POST" && path === "/api/parts/uninstall") {
        return await handleUninstallPart(req, res, ctx);
      }
    } catch (err) {
      logger?.error("API route error", { path, error: err.message });
      return sendJson(res, 500, { ok: false, error: "internal-error" });
    }

    // Not an /api/* route — pass to next handler
    if (typeof next === "function") next();
  };
}
