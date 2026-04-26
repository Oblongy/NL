import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodeGameCodeQuery, encryptPayload } from "./nitto-cipher.js";
import { handleGameAction } from "./game-actions.js";
import { getMostRecentActiveSession, getSessionPlayerId } from "./session.js";
import {
  getCarById,
  getPlayerById,
  listCarsForPlayer,
  saveCarPartsXml,
  updatePlayerDefaultCar,
} from "./user-service.js";
import { PARTS_CATALOG_XML } from "./parts-catalog.js";
import { httpRequestsTotal } from "./metrics.js";
import {
  buildTuningStudioCatalog,
  buildTuningStudioPreview,
} from "./tuning-studio.js";
import {
  getCustomGraphicSlotIdForField,
  rememberRecentDecalUpload,
} from "./upload-state.js";
import { FULL_CAR_CATALOG } from "./car-catalog.js";

function buildStaticFileRoute(relativePath, contentType, encoding = "utf8") {
  const assetUrl = new URL(relativePath, import.meta.url);
  if (!existsSync(assetUrl)) {
    return null;
  }

  return {
    body: readFileSync(assetUrl, encoding),
    contentType,
    source: `local:${relativePath.replace(/^\.\//, "")}`,
  };
}

function buildLocalStaticRoutes() {
  const routes = new Map();
  const oneClientRoute = buildStaticFileRoute("./oneclient.html", "text/html; charset=latin1", "latin1");
  const registerRoute = buildStaticFileRoute("./register.html", "text/html; charset=utf-8");
  const tuningStudioRoute = buildStaticFileRoute("./tuning-studio.html", "text/html; charset=utf-8");
  const gameStylesRoute = buildStaticFileRoute("./gameStyles.css", "text/css; charset=latin1", "latin1");
  const newsStylesRoute = buildStaticFileRoute("./newsStyles.css", "text/css; charset=latin1", "latin1");

  if (oneClientRoute) {
    routes.set("/", oneClientRoute);
    routes.set("/oneclient.html", oneClientRoute);
  }

  if (registerRoute) {
    routes.set("/register.html", registerRoute);
    routes.set("/register", registerRoute);
  }

  if (tuningStudioRoute) {
    routes.set("/tuning-studio", tuningStudioRoute);
    routes.set("/tuning-studio.html", tuningStudioRoute);
  }

  routes.set("/parts-catalog.xml", {
    body: PARTS_CATALOG_XML,
    contentType: "application/xml; charset=utf-8",
    source: "generated:parts-catalog.xml",
  });

  if (gameStylesRoute) {
    routes.set("/gameStyles.css", gameStylesRoute);
  }

  if (newsStylesRoute) {
    routes.set("/newsStyles.css", newsStylesRoute);
  }

  return routes;
}

const LOCAL_STATIC_ROUTES = buildLocalStaticRoutes();

const pendingUploadsByRemote = new Map();
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB
const CAR_NAME_BY_ID = new Map(FULL_CAR_CATALOG.map(([id, name]) => [String(id), String(name || `Car ${id}`)]));

// Cleanup stale uploads every 10 minutes.
// `unref()` keeps this housekeeping timer from pinning short-lived processes
// like smoke tests that import the HTTP helpers directly.
const pendingUploadCleanupTimer = setInterval(() => {
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  let cleaned = 0;
  
  for (const [remote, upload] of pendingUploadsByRemote.entries()) {
    if (upload.timestamp && now - upload.timestamp > staleThreshold) {
      pendingUploadsByRemote.delete(remote);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[${new Date().toISOString()}] [info] Cleaned up stale uploads: ${cleaned}`);
  }
}, 10 * 60 * 1000);
pendingUploadCleanupTimer.unref?.();

function sendText(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=latin1",
    "Content-Length": Buffer.byteLength(body, "latin1"),
    ...headers,
  });
  res.end(body, "latin1");
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    ...headers,
  });
  res.end(body, "utf8");
}

function isLoopbackAddress(remoteAddress) {
  const normalized = String(remoteAddress || "").trim();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function notFound(res, path) {
  sendText(res, 404, `not found: ${path}\n`);
}

function sendBinary(res, statusCode, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/octet-stream",
    "Content-Length": buffer.length,
    ...headers,
  });
  res.end(buffer);
}

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

const TOURNAMENT_KEY_DIGIT_BITMAPS = Object.freeze({
  0: ["111","101","101","101","111"],
  1: ["010","110","010","010","111"],
  2: ["111","001","111","100","111"],
  3: ["111","001","111","001","111"],
  4: ["101","101","111","001","001"],
  5: ["111","100","111","001","111"],
  6: ["111","100","111","101","111"],
  7: ["111","001","001","001","001"],
  8: ["111","101","111","101","111"],
  9: ["111","101","111","001","111"],
});

export function createTournamentKeyCode(aid, rid, tournamentType = "") {
  // Mirror the CPU tournament dial-key shape used by the game action flow.
  // The Flash client closes the tournament UI when the generated image shows
  // a different key than the one returned by ctjt/ctct.
  if (!tournamentType || tournamentType === "cpu") {
    const digest = createHash("sha1")
      .update(`${aid}:1:cpu`, "utf8")
      .digest("hex");
    const numeric = parseInt(digest.slice(0, 8), 16);
    return String((numeric % 32) + 1);
  }

  const digest = createHash("sha1")
    .update(`${aid}:${rid}:${tournamentType}`, "utf8")
    .digest("hex");
  const numeric = parseInt(digest.slice(0, 8), 16);
  return String((numeric % 32) + 1);
}

function writePngChunk(type, data) {
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(data.length, 0);
  const chunkType = Buffer.from(type, "ascii");
  const crcBuffer = Buffer.concat([chunkType, data]);
  const crcValue = crc32(crcBuffer);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcValue >>> 0, 0);
  return Buffer.concat([chunkLength, chunkType, data, crc]);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function renderTournamentKeyImage(code) {
  const width = 48;
  const height = 24;
  const scale = 3;
  const digitWidth = 3 * scale;
  const digitHeight = 5 * scale;
  const gap = scale;
  const marginX = 4;
  const marginY = 4;
  const formattedCode = String(code || "0000").padStart(4, "0").slice(-4);
  const pixels = Buffer.alloc((width * 4 + 1) * height, 0);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    pixels[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      const shade = y < height / 2 ? 235 : 220;
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = 255;
    }
  }

  for (let digitIndex = 0; digitIndex < formattedCode.length; digitIndex += 1) {
    const glyph = TOURNAMENT_KEY_DIGIT_BITMAPS[formattedCode[digitIndex]] || TOURNAMENT_KEY_DIGIT_BITMAPS[0];
    const startX = marginX + digitIndex * (digitWidth + gap);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") {
          continue;
        }
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const x = startX + col * scale + sx;
            const y = marginY + row * scale + sy;
            if (x < 0 || x >= width || y < 0 || y >= height) {
              continue;
            }
            const offset = y * (width * 4 + 1) + 1 + x * 4;
            pixels[offset] = 25;
            pixels[offset + 1] = 25;
            pixels[offset + 2] = 25;
            pixels[offset + 3] = 255;
          }
        }
      }
    }
  }

  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    writePngChunk("IHDR", ihdr),
    writePngChunk("IDAT", deflateSync(pixels)),
    writePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function avatarPathForPlayerId(playerId) {
  return resolve(process.cwd(), "../cache/avatars/0/0/0", `${playerId}.jpg`);
}

function teamAvatarPathForTeamId(teamId) {
  return resolve(process.cwd(), "../cache/teamavatars/0/0/0", `${teamId}.jpg`);
}

function userDecalPath(filename) {
  // Sanitize filename to prevent path traversal
  const sanitized = String(filename).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!sanitized || sanitized !== filename) {
    throw new Error('Invalid filename');
  }
  return resolve(process.cwd(), "../cache/car/userDecals", sanitized);
}

function normalizeUserGraphicExt(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/^\./, "");
  return ["jpg", "jpeg", "png", "gif"].includes(normalized) ? normalized : "png";
}

function getContentTypeForUserDecal(filename) {
  const normalizedExt = normalizeUserGraphicExt(extname(String(filename || "")));
  switch (normalizedExt) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "png":
    default:
      return "image/png";
  }
}

export function getUserGraphicUploadResponseAttrs(slotKey, decalId, extension, fieldName = "") {
  const inferredSlotKey = String(slotKey || "").trim() || getCustomGraphicSlotIdForField(fieldName);
  const normalizedSlot = String(inferredSlotKey || "").trim().toLowerCase();
  const normalizedExt = normalizeUserGraphicExt(extension);
  switch (normalizedSlot) {
    case "hood":
    case "h":
    case "160":
      return { h: decalId, hx: normalizedExt };
    case "side":
    case "s":
    case "161":
      return { si: decalId, sx: normalizedExt };
    case "front":
    case "f":
    case "162":
      return { f: decalId, fx: normalizedExt };
    case "back":
    case "rear":
    case "b":
    case "163":
      return { b: decalId, bx: normalizedExt };
    default:
      return { i: decalId, fx: normalizedExt };
  }
}

function serveCompatAsset(res, pathname) {
  let filePath = null;
  let contentType = "application/octet-stream";

  const avatarMatch = pathname.match(/^\/avatars\/0\/0\/0\/(\d+)\.jpg$/i);
  if (avatarMatch) {
    filePath = avatarPathForPlayerId(avatarMatch[1]);
    contentType = "image/jpeg";
  }

  const teamAvatarMatch = pathname.match(/^\/teamavatars\/0\/0\/0\/(\d+)\.jpg$/i);
  if (!filePath && teamAvatarMatch) {
    filePath = teamAvatarPathForTeamId(teamAvatarMatch[1]);
    contentType = "image/jpeg";
  }

  const userDecalMatch = pathname.match(/^\/cache\/car\/userDecals\/([^/]+)$/i);
  if (!filePath && userDecalMatch) {
    filePath = userDecalPath(userDecalMatch[1]);
    contentType = getContentTypeForUserDecal(userDecalMatch[1]);
  }

  if (!filePath && /^\/newuserform\.swf$/i.test(pathname)) {
    filePath = resolve(process.cwd(), "../cache/misc/newuserform.swf");
    contentType = "application/x-shockwave-flash";
  }

  // Serve cached SWFs from the local cache folder.
  const cacheSwfMatch = pathname.match(/^\/cache\/(car\/(?!userDecals)[^?#]+\.swf|brands\/[^?#]+\.swf|badges\/[^?#]+\.swf|misc\/[^?#]+\.swf)$/i);
  if (!filePath && cacheSwfMatch) {
    const safePath = cacheSwfMatch[1].replace(/\.\./g, "");
    filePath = resolve(process.cwd(), "../cache", safePath);
    contentType = "application/x-shockwave-flash";
  }

  if (!filePath || !existsSync(filePath)) {
    return false;
  }

  sendBinary(res, 200, readFileSync(filePath), {
    "Content-Type": contentType,
  });
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function resolveCompatSessionInfo(supabase, sessionKey) {
  if (!supabase || !sessionKey) {
    return null;
  }

  const playerId = await getSessionPlayerId({ supabase, sessionKey });
  if (!playerId) {
    return null;
  }

  const player = await getPlayerById(supabase, playerId);
  if (!player) {
    return null;
  }

  let selectedCar = null;
  if (player.default_car_game_id) {
    selectedCar = await getCarById(supabase, player.default_car_game_id);
  }

  if (!selectedCar) {
    const cars = await listCarsForPlayer(supabase, playerId);
    selectedCar = cars.find((car) => car.selected) || cars[0] || null;
  }

  return {
    playerId: Number(player.id || 0),
    username: String(player.username || ""),
    defaultCarGameId: Number(selectedCar?.game_car_id || player.default_car_game_id || 0),
  };
}

async function resolveStudioSessionGarage(supabase, sessionKey) {
  const sessionInfo = await resolveCompatSessionInfo(supabase, sessionKey);
  if (!sessionInfo) {
    return null;
  }

  const cars = await listCarsForPlayer(supabase, sessionInfo.playerId);
  return {
    player: sessionInfo,
    cars: cars.map((car) => ({
      gameCarId: Number(car.game_car_id || 0),
      accountCarId: Number(car.account_car_id || 0),
      catalogCarId: String(car.catalog_car_id || ""),
      name: CAR_NAME_BY_ID.get(String(car.catalog_car_id || "")) || `Car ${car.catalog_car_id || "?"}`,
      selected: Boolean(car.selected),
      paintIndex: Number(car.paint_index || 0),
      imageIndex: Number(car.image_index || 0),
      partsLength: String(car.parts_xml || "").length,
    })),
  };
}

async function resolveLatestStudioSessionGarage(supabase) {
  const latestSession = await getMostRecentActiveSession({ supabase });
  if (!latestSession?.session_key) {
    return null;
  }

  const sessionGarage = await resolveStudioSessionGarage(supabase, latestSession.session_key);
  if (!sessionGarage) {
    return null;
  }

  return {
    sessionKey: String(latestSession.session_key || ""),
    ...sessionGarage,
  };
}

async function applyTuningStudioBuild(supabase, payload = {}) {
  const sessionKey = String(payload.sessionKey || payload.sk || "").trim();
  if (!supabase || !sessionKey) {
    throw new Error("Missing session key.");
  }

  const sessionGarage = await resolveStudioSessionGarage(supabase, sessionKey);
  if (!sessionGarage?.player?.playerId) {
    throw new Error("Session could not be resolved.");
  }

  const targetGameCarId = Number(payload.targetGameCarId || payload.gameCarId || sessionGarage.player.defaultCarGameId || 0);
  if (!Number.isFinite(targetGameCarId) || targetGameCarId <= 0) {
    throw new Error("Target game car id is required.");
  }

  const targetCar = await getCarById(supabase, targetGameCarId);
  if (!targetCar || Number(targetCar.player_id || 0) !== Number(sessionGarage.player.playerId)) {
    throw new Error("Target car does not belong to the active session.");
  }

  const preview = buildTuningStudioPreview(payload);
  if (String(preview.catalogCarId || payload.catalogCarId || "") && String(targetCar.catalog_car_id || "") !== String(payload.catalogCarId || "")) {
    throw new Error("Selected studio car does not match the chosen garage car.");
  }

  const savedCar = await saveCarPartsXml(supabase, targetGameCarId, preview.xml.partsXml);
  if (!savedCar) {
    throw new Error("Failed to save parts XML.");
  }

  if (payload.selectCar !== false) {
    await updatePlayerDefaultCar(supabase, sessionGarage.player.playerId, targetGameCarId);
  }

  return {
    ok: true,
    appliedAt: new Date().toISOString(),
    player: sessionGarage.player,
    targetCar: {
      gameCarId: Number(savedCar.game_car_id || targetGameCarId),
      catalogCarId: String(savedCar.catalog_car_id || ""),
      name: CAR_NAME_BY_ID.get(String(savedCar.catalog_car_id || "")) || `Car ${savedCar.catalog_car_id || "?"}`,
      selected: true,
      partsLength: String(savedCar.parts_xml || "").length,
    },
    preview,
  };
}

async function loadAdminUserInfo(supabase, playerId) {
  if (!supabase || !playerId) {
    return null;
  }

  const [player, carsResult, openReportsResult, bannedReportsResult, recentTicketsResult] = await Promise.all([
    getPlayerById(supabase, playerId),
    listCarsForPlayer(supabase, playerId),
    supabase
      .from("game_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("offender_player_id", Number(playerId))
      .eq("status", "open"),
    supabase
      .from("game_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("offender_player_id", Number(playerId))
      .eq("resolution", "banned"),
    supabase
      .from("game_support_tickets")
      .select("ticket_number, support_id, requester_username, offender_username, subject, status, resolution, created_at")
      .or(`offender_player_id.eq.${Number(playerId)},requester_player_id.eq.${Number(playerId)}`)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (!player) {
    return null;
  }

  return {
    player,
    cars: Array.isArray(carsResult) ? carsResult : [],
    openReports: Number(openReportsResult.count || 0),
    bannedReports: Number(bannedReportsResult.count || 0),
    tickets: Array.isArray(recentTicketsResult.data) ? recentTicketsResult.data : [],
  };
}

function renderAdminUserInfoPage(info) {
  const { player, cars, openReports, bannedReports, tickets } = info;
  const rows = tickets.length > 0
    ? tickets.map((ticket) => `
        <tr>
          <td>${escapeHtml(ticket.ticket_number)}</td>
          <td>${escapeHtml(ticket.requester_username || "")}</td>
          <td>${escapeHtml(ticket.offender_username || "")}</td>
          <td>${escapeHtml(ticket.subject || "")}</td>
          <td>${escapeHtml(ticket.status || "")}</td>
          <td>${escapeHtml(ticket.resolution || "")}</td>
          <td>${escapeHtml(ticket.created_at || "")}</td>
        </tr>`).join("")
    : `<tr><td colspan="7">No support tickets found.</td></tr>`;

  const carRows = cars.length > 0
    ? cars.map((car) => `
        <tr>
          <td>${escapeHtml(String(car.game_car_id || 0))}</td>
          <td>${escapeHtml(String(car.catalog_car_id || 0))}</td>
          <td>${car.selected ? "yes" : "no"}</td>
          <td>${escapeHtml(String(car.paint_index || 0))}</td>
          <td>${escapeHtml(String((car.parts_xml || "").length))}</td>
        </tr>`).join("")
    : `<tr><td colspan="5">No cars found.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Local Admin User Info</title>
  <style>
    body{font-family:Segoe UI,Arial,sans-serif;background:#111827;color:#e5e7eb;margin:0;padding:24px}
    h1,h2{margin:0 0 12px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:0 0 24px}
    .card{background:#1f2937;border:1px solid #374151;border-radius:10px;padding:14px}
    table{width:100%;border-collapse:collapse;background:#111827}
    th,td{border:1px solid #374151;padding:8px;text-align:left;vertical-align:top}
    th{background:#1f2937}
    .muted{color:#9ca3af}
  </style>
</head>
<body>
  <h1>Local Admin User Info</h1>
  <div class="grid">
    <div class="card"><strong>Player ID</strong><div>${escapeHtml(String(player.id || 0))}</div></div>
    <div class="card"><strong>Username</strong><div>${escapeHtml(player.username || "")}</div></div>
    <div class="card"><strong>Role</strong><div>${escapeHtml(String(player.client_role || player.role || ""))}</div></div>
    <div class="card"><strong>Money</strong><div>${escapeHtml(String(player.money || 0))}</div></div>
    <div class="card"><strong>Open Reports</strong><div>${escapeHtml(String(openReports))}</div></div>
    <div class="card"><strong>Ban Count</strong><div>${escapeHtml(String(bannedReports))}</div></div>
  </div>
  <h2>Cars</h2>
  <table>
    <thead><tr><th>Game Car ID</th><th>Catalog Car ID</th><th>Selected</th><th>Paint</th><th>Parts XML Len</th></tr></thead>
    <tbody>${carRows}</tbody>
  </table>
  <h2 style="margin-top:24px">Support Tickets</h2>
  <table>
    <thead><tr><th>Ticket</th><th>Requester</th><th>Offender</th><th>Subject</th><th>Status</th><th>Resolution</th><th>Created</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted" style="margin-top:16px">This local page replaces the old external moderator lookup page for the current backend.</p>
</body>
</html>`;
}

export function createHttpServer({ config, logger, supabase, services = {}, fixtureStore = null }) {
  return createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
      const bodyBytes = await readBody(req);
      const remoteAddress = req.socket.remoteAddress || "";

      logger.info("HTTP request", {
        method: req.method,
        path: requestUrl.pathname,
        bytes: bodyBytes.length,
      });

      httpRequestsTotal.inc({ method: req.method, path: requestUrl.pathname.split("?")[0] });

      // Prometheus-compatible metrics endpoint
      if (requestUrl.pathname === "/metrics") {
        const body = collectMetrics();
        res.writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        });
        res.end(body, "utf8");
        return;
      }

      const debugRaceMatch = requestUrl.pathname.match(/^\/debug\/races(?:\/([^/]+))?$/i);
      if (debugRaceMatch) {
        if (!isLoopbackAddress(remoteAddress)) {
          sendJson(res, 403, {
            ok: false,
            error: "debug-endpoints-localhost-only",
          });
          return;
        }

        const tcpServer = services.tcpServer;
        if (!tcpServer || typeof tcpServer.getRaceDebugSummary !== "function") {
          sendJson(res, 503, {
            ok: false,
            error: "race-debug-unavailable",
          });
          return;
        }

        const raceId = debugRaceMatch[1] ? decodeURIComponent(debugRaceMatch[1]) : "";
        if (raceId) {
          const details = tcpServer.getRaceDebugDetails(raceId);
          if (!details) {
            sendJson(res, 404, {
              ok: false,
              error: "race-debug-not-found",
              raceId,
            });
            return;
          }

          sendJson(res, 200, {
            ok: true,
            generatedAt: Date.now(),
            ...details,
          });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          ...tcpServer.getRaceDebugSummary(),
        });
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("status.aspx")) {
        sendText(res, 200, "1");
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("generatetournamentkey.aspx")) {
        const aid = String(requestUrl.searchParams.get("aid") || "0");
        const rid = String(requestUrl.searchParams.get("rid") || "0");
        const tournamentType = String(requestUrl.searchParams.get("t") || "");
        const code = createTournamentKeyCode(aid, rid, tournamentType);
        const image = renderTournamentKeyImage(code);

        logger.info("Serving tournament key image", {
          aid,
          rid,
          tournamentType: tournamentType || "cpu",
          code,
        });

        sendBinary(res, 200, image, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "X-Nitto-Source": "generated:generateTournamentKey.aspx",
        });
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("upload.aspx")) {
        // Skip empty preflight requests from Flash
        if (bodyBytes.length === 0) {
          sendText(res, 200, `<r s='1'/>`);
          return;
        }

        // --- File size limit ---
        if (bodyBytes.length > MAX_UPLOAD_BYTES) {
          logger.warn("Upload rejected (too large)", { bytes: bodyBytes.length, max: MAX_UPLOAD_BYTES });
          uploadsTotal.inc({ type: "unknown", result: "rejected_size" });
          sendText(res, 413, `<r s='0'/>`);
          return;
        }

        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(.+)$/);

        logger.info("Upload received", {
          bytes: bodyBytes.length,
          contentType,
          hasBoundary: !!boundaryMatch,
          remoteAddress,
          pendingUpload: pendingUploadsByRemote.get(remoteAddress) || null,
        });
        
        if (boundaryMatch) {
          const boundary = boundaryMatch[1];
          const bodyStr = bodyBytes.toString("binary");
          const parts = bodyStr.split("--" + boundary);
          
          for (const part of parts) {
            const headerEnd = part.indexOf("\r\n\r\n");
            if (headerEnd === -1) continue;
            const headers = part.substring(0, headerEnd);
            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (!nameMatch || !filenameMatch) continue;
            
            const fieldName = nameMatch[1];
            const fileData = Buffer.from(part.substring(headerEnd + 4, part.length - 2), "binary");
            const pendingUpload = pendingUploadsByRemote.get(remoteAddress);
            
            // Sanitize decalId to prevent path traversal
            const rawDecalId = Date.now() % 100000;
            const decalId = String(rawDecalId).replace(/[^0-9]/g, '');
            
            const requestExt = normalizeUserGraphicExt(requestUrl.searchParams.get("ext") || extname(filenameMatch[1] || ""));
            let targetPath = userDecalPath(`${decalId}.${requestExt}`);
            let responseBody = `<r s='1' i='${decalId}'/>`;

            if (pendingUpload?.type === "avatars" && pendingUpload.targetId) {
              // Validate targetId is numeric
              const sanitizedId = Number(pendingUpload.targetId);
              if (!Number.isFinite(sanitizedId) || sanitizedId <= 0) {
                logger.error("Invalid avatar target ID", { targetId: pendingUpload.targetId });
                sendText(res, 400, `<r s='0'/>`);
                return;
              }
              targetPath = avatarPathForPlayerId(sanitizedId);
              responseBody = `<r s='1' i='${sanitizedId}'/>`;
            } else if (pendingUpload?.type === "teamavatars" && pendingUpload.targetId) {
              // Validate targetId is numeric
              const sanitizedId = Number(pendingUpload.targetId);
              if (!Number.isFinite(sanitizedId) || sanitizedId <= 0) {
                logger.error("Invalid team avatar target ID", { targetId: pendingUpload.targetId });
                sendText(res, 400, `<r s='0'/>`);
                return;
              }
              targetPath = teamAvatarPathForTeamId(sanitizedId);
              responseBody = `<r s='1' i='${sanitizedId}'/>`;
            }

            try {
              ensureParentDir(targetPath);
              writeFileSync(targetPath, fileData);
              if (!pendingUpload || pendingUpload.type === "userDecals") {
                rememberRecentDecalUpload({
                  remoteAddress,
                  fieldName,
                  targetPath,
                });
              }
              logger.info("Saved upload file", {
                fieldName,
                bytes: fileData.length,
                type: pendingUpload?.type || "userDecals",
                extension: requestExt,
                targetPath,
              });
            } catch (err) {
              logger.error("Failed to save upload", { error: err.message, targetPath });
            }

            if (!pendingUpload || pendingUpload.type === "userDecals") {
              const attrs = getUserGraphicUploadResponseAttrs(
                requestUrl.searchParams.get("slot"),
                decalId,
                requestExt,
                fieldName,
              );
              const serializedAttrs = Object.entries(attrs).map(([key, value]) => `${key}='${value}'`).join(" ");
              responseBody = `<r s='1' i='${decalId}' ${serializedAttrs}/>`;
              logger.info("User decal upload response", {
                remoteAddress,
                fieldName,
                decalId,
                responseBody,
              });
            }

            pendingUploadsByRemote.delete(remoteAddress);
            
            sendText(res, 200, responseBody);
            return;
          }
        }
        
        sendText(res, 200, `<r s='1' id='1'/>`);
        return;
      }

      if (requestUrl.pathname === "/healthz") {
        sendText(res, 200, "ok");
        return;
      }

      if (requestUrl.pathname === "/content.htm") {
        sendText(res, 200, `"s", 1, "d", "<n2 />"`, {
          "X-Nitto-Source": "generated:content.htm",
        });
        return;
      }

      if (requestUrl.pathname === "/compat/session-info") {
        const sessionKey = String(requestUrl.searchParams.get("sk") || "");
        const sessionInfo = await resolveCompatSessionInfo(supabase, sessionKey);
        if (!sessionInfo) {
          sendJson(res, 404, { ok: false, error: "session-not-found" });
          return;
        }

        sendJson(res, 200, { ok: true, ...sessionInfo });
        return;
      }

      if (requestUrl.pathname === "/api/tuning-studio/catalog") {
        sendJson(res, 200, buildTuningStudioCatalog(), {
          "X-Nitto-Source": "generated:tuning-studio:catalog",
        });
        return;
      }

      if (requestUrl.pathname === "/api/tuning-studio/session") {
        const sessionKey = String(requestUrl.searchParams.get("sk") || "");
        if (!sessionKey) {
          sendJson(res, 400, { ok: false, error: "missing-session-key" });
          return;
        }

        const sessionGarage = await resolveStudioSessionGarage(supabase, sessionKey);
        if (!sessionGarage) {
          sendJson(res, 404, { ok: false, error: "session-not-found" });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          ...sessionGarage,
        }, {
          "X-Nitto-Source": "generated:tuning-studio:session",
        });
        return;
      }

      if (requestUrl.pathname === "/api/tuning-studio/session/current") {
        const sessionGarage = await resolveLatestStudioSessionGarage(supabase);
        if (!sessionGarage) {
          sendJson(res, 404, { ok: false, error: "session-not-found" });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          ...sessionGarage,
        }, {
          "X-Nitto-Source": "generated:tuning-studio:session:current",
        });
        return;
      }

      if (requestUrl.pathname === "/api/tuning-studio/preview") {
        if (req.method !== "POST") {
          sendText(res, 405, "method not allowed\n", { Allow: "POST" });
          return;
        }

        let payload;
        try {
          payload = bodyBytes.length ? JSON.parse(bodyBytes.toString("utf8")) : {};
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: "invalid-json",
          });
          return;
        }

        try {
          const preview = buildTuningStudioPreview(payload);
          sendJson(res, 200, preview, {
            "X-Nitto-Source": "generated:tuning-studio:preview",
          });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (requestUrl.pathname === "/api/tuning-studio/apply") {
        if (req.method !== "POST") {
          sendText(res, 405, "method not allowed\n", { Allow: "POST" });
          return;
        }

        let payload;
        try {
          payload = bodyBytes.length ? JSON.parse(bodyBytes.toString("utf8")) : {};
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: "invalid-json",
          });
          return;
        }

        try {
          const applied = await applyTuningStudioBuild(supabase, payload);
          sendJson(res, 200, applied, {
            "X-Nitto-Source": "generated:tuning-studio:apply",
          });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (/^\/(?:admin\/)?userinfo\.aspx$/i.test(requestUrl.pathname)) {
        const playerId = Number(requestUrl.searchParams.get("aid") || 0);
        const info = await loadAdminUserInfo(supabase, playerId);
        if (!info) {
          sendText(res, 404, "admin user not found\n");
          return;
        }
        const body = renderAdminUserInfoPage(info);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(body, "utf8"),
          "X-Nitto-Source": "generated:userInfo.aspx",
        });
        res.end(body, "utf8");
        return;
      }

      if (requestUrl.pathname !== "/gameCode1_00.aspx") {
        if (serveCompatAsset(res, requestUrl.pathname)) {
          return;
        }

        const localStaticRoute = LOCAL_STATIC_ROUTES.get(requestUrl.pathname);
        if (localStaticRoute) {
          logger.info("Serving static route from local asset", {
            path: requestUrl.pathname,
            source: localStaticRoute.source,
          });
          sendText(res, 200, localStaticRoute.body, {
            "Content-Type": localStaticRoute.contentType,
            "X-Nitto-Source": localStaticRoute.source,
          });
          return;
        }

        notFound(res, requestUrl.pathname);
        return;
      }

      const rawQuery = req.url.includes("?") ? req.url.split("?", 2)[1] : "";
      if (!rawQuery) {
        sendText(res, 400, "missing query\n");
        return;
      }

      let decoded;
      try {
        decoded = decodeGameCodeQuery(rawQuery);
      } catch (error) {
        // Check if this is a plain text request (for web registration)
        const plainParams = new URLSearchParams(rawQuery);
        const action = plainParams.get("action");
        
        if (action === "createaccount") {
          // Handle plain text account creation from web form
          const { body, source } = await handleGameAction({
            action: "createaccount",
            params: plainParams,
            rawQuery,
            decodedQuery: rawQuery,
            config,
            supabase,
            logger,
            services,
          });
          
          logger.info("Game action served (plain)", {
            action: "createaccount",
            source,
          });
          
          sendText(res, 200, body, {
            "X-Nitto-Source": source,
            "X-Nitto-Action": "createaccount",
          });
          return;
        }
        
        logger.error("Could not decode game query", String(error));
        sendText(res, 400, `"s", 0`);
        return;
      }

      logger.info("Decoded action", { action: decoded.action, decodedQuery: decoded.decoded });

      const { body, source } = await handleGameAction({
        action: decoded.action,
        params: decoded.params,
        rawQuery,
        decodedQuery: decoded.decoded,
        remoteAddress,
        config,
        supabase,
        logger,
        services,
      });

      if (decoded.action === "uploadrequest") {
        pendingUploadsByRemote.set(remoteAddress, {
          type: String(decoded.params.get("t") || "").toLowerCase(),
          targetId: Number(decoded.params.get("id") || 0),
          filename: String(decoded.params.get("fn") || ""),
          sessionKey: String(decoded.params.get("sk") || ""),
          timestamp: Date.now(),
        });
      }

      if (decoded.action === "buydyno") {
        logger.info("Dyno buy response body", {
          source,
          decodedQuery: decoded.decoded,
          body,
        });
      }

      logger.info("Game action served", {
        action: decoded.action || "<unknown>",
        source,
        decodedQuery: decoded.decoded,
      });

      // Encrypt the response using the same seed from the request
      const encryptedBody = encryptPayload(body, decoded.seed);

      sendText(res, 200, encryptedBody, {
        "X-Nitto-Source": source,
        "X-Nitto-Action": decoded.action || "<unknown>",
        "X-Nitto-Seed": String(decoded.seed),
      });
    } catch (error) {
      logger.error("Unhandled request error", error instanceof Error ? error.stack : String(error));
      sendText(res, 500, `"s", 0`);
    }
  });
}
