import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { decodeGameCodeQuery, encryptPayload } from "./nitto-cipher.js";
import { handleGameAction } from "./game-actions.js";
import { getSessionPlayerId } from "./session.js";
import { getCarById, getPlayerById, listCarsForPlayer } from "./user-service.js";
import { httpRequestsTotal, uploadsTotal, collectMetrics } from "./metrics.js";

const LOCAL_STATIC_ROUTES = new Map([
  [
    "/",
    {
      body: readFileSync(new URL("./oneclient.html", import.meta.url), "latin1"),
      contentType: "text/html; charset=latin1",
      source: "local:oneclient.html",
    },
  ],
  [
    "/oneclient.html",
    {
      body: readFileSync(new URL("./oneclient.html", import.meta.url), "latin1"),
      contentType: "text/html; charset=latin1",
      source: "local:oneclient.html",
    },
  ],
  [
    "/register.html",
    {
      body: readFileSync(new URL("./register.html", import.meta.url), "utf8"),
      contentType: "text/html; charset=utf-8",
      source: "local:register.html",
    },
  ],
  [
    "/register",
    {
      body: readFileSync(new URL("./register.html", import.meta.url), "utf8"),
      contentType: "text/html; charset=utf-8",
      source: "local:register.html",
    },
  ],
  [
    "/parts-catalog.html",
    {
      body: readFileSync(new URL("./parts-catalog.html", import.meta.url), "utf8"),
      contentType: "text/html; charset=utf-8",
      source: "local:parts-catalog.html",
    },
  ],
  [
    "/parts-catalog",
    {
      body: readFileSync(new URL("./parts-catalog.html", import.meta.url), "utf8"),
      contentType: "text/html; charset=utf-8",
      source: "local:parts-catalog.html",
    },
  ],
  [
    "/parts-catalog.xml",
    {
      body: readFileSync(new URL("./catalog-data/parts-catalog.xml", import.meta.url), "utf8"),
      contentType: "application/xml; charset=utf-8",
      source: "local:parts-catalog.xml",
    },
  ],
  [
    "/gameStyles.css",
    {
      body: readFileSync(new URL("./gameStyles.css", import.meta.url), "latin1"),
      contentType: "text/css; charset=latin1",
      source: "local:gameStyles.css",
    },
  ],
  [
    "/newsStyles.css",
    {
      body: readFileSync(new URL("./newsStyles.css", import.meta.url), "latin1"),
      contentType: "text/css; charset=latin1",
      source: "local:newsStyles.css",
    },
  ],
]);

const pendingUploadsBySession = new Map();

// Upload constraints
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_UPLOAD_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp"]);

// Cleanup stale uploads every 10 minutes
setInterval(() => {
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  let cleaned = 0;
  
  for (const [key, upload] of pendingUploadsBySession.entries()) {
    if (upload.timestamp && now - upload.timestamp > staleThreshold) {
      pendingUploadsBySession.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[${new Date().toISOString()}] [info] Cleaned up stale uploads: ${cleaned}`);
  }
}, 10 * 60 * 1000);

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

const TOURNAMENT_KEY_JPEG = Buffer.from(
  "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",
  "base64"
);

function createTournamentKeyCode(aid, rid, tournamentType = "") {
  const digest = createHash("sha1")
    .update(`${aid}:${rid}:${tournamentType}`, "utf8")
    .digest("hex");
  const numeric = parseInt(digest.slice(0, 8), 16);
  return String((numeric % 9000) + 1000);
}

function renderTournamentKeyJpeg(code) {
  void code;
  return TOURNAMENT_KEY_JPEG;
}

function avatarPathForPlayerId(playerId) {
  return resolve(process.cwd(), "../cache/avatars", `${playerId}.jpg`);
}

function teamAvatarPathForTeamId(teamId) {
  return resolve(process.cwd(), "../cache/teamAvatars", `${teamId}.jpg`);
}

function normalizeCompatAssetPath(pathname) {
  const normalized = String(pathname || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function resolveExistingPath(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function avatarCandidates(playerId, shardPath = "") {
  const candidates = [
    resolve(process.cwd(), "../cache/avatars", `${playerId}.jpg`),
  ];
  if (shardPath) {
    candidates.push(resolve(process.cwd(), "../cache/avatars", shardPath, `${playerId}.jpg`));
  }
  return candidates;
}

function teamAvatarCandidates(teamId, shardPath = "") {
  const candidates = [
    resolve(process.cwd(), "../cache/teamAvatars", `${teamId}.jpg`),
    resolve(process.cwd(), "../cache/teamavatars", `${teamId}.jpg`),
  ];
  if (shardPath) {
    candidates.push(
      resolve(process.cwd(), "../cache/teamAvatars", shardPath, `${teamId}.jpg`),
      resolve(process.cwd(), "../cache/teamavatars", shardPath, `${teamId}.jpg`),
    );
  }
  return candidates;
}

function userDecalPath(filename) {
  // Sanitize filename to prevent path traversal
  const sanitized = String(filename).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!sanitized || sanitized !== filename) {
    throw new Error('Invalid filename');
  }
  return resolve(process.cwd(), "../cache/car/userDecals", sanitized);
}

function serveCompatAsset(res, pathname) {
  let filePath = null;
  let contentType = "application/octet-stream";
  const normalizedPath = normalizeCompatAssetPath(pathname);

  const avatarMatch = normalizedPath.match(/^\/(?:cache\/)?avatars(?:\/(\d+)\/(\d+)\/(\d+))?\/(\d+)\.jpg$/i);
  if (avatarMatch) {
    const shardPath = [avatarMatch[1], avatarMatch[2], avatarMatch[3]].filter(Boolean).join("/");
    filePath = resolveExistingPath(avatarCandidates(avatarMatch[4], shardPath));
    contentType = "image/jpeg";
  }

  const teamAvatarMatch = normalizedPath.match(/^\/(?:cache\/)?teamavatars(?:\/(\d+)\/(\d+)\/(\d+))?\/(\d+)\.jpg$/i);
  if (!filePath && teamAvatarMatch) {
    const shardPath = [teamAvatarMatch[1], teamAvatarMatch[2], teamAvatarMatch[3]].filter(Boolean).join("/");
    filePath = resolveExistingPath(teamAvatarCandidates(teamAvatarMatch[4], shardPath));
    contentType = "image/jpeg";
  }

  const userDecalMatch = normalizedPath.match(/^\/cache\/car\/userDecals\/([^/]+)$/i);
  if (!filePath && userDecalMatch) {
    filePath = userDecalPath(userDecalMatch[1]);
    contentType = userDecalMatch[1].toLowerCase().endsWith(".swf")
      ? "application/x-shockwave-flash"
      : "application/octet-stream";
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

export function createHttpServer({ config, logger, supabase, services = {} }) {
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

      if (requestUrl.pathname.toLowerCase().endsWith("status.aspx")) {
        sendText(res, 200, "1");
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("generatetournamentkey.aspx")) {
        const aid = String(requestUrl.searchParams.get("aid") || "0");
        const rid = String(requestUrl.searchParams.get("rid") || "0");
        const tournamentType = String(requestUrl.searchParams.get("t") || "");
        const code = createTournamentKeyCode(aid, rid, tournamentType);
        const jpeg = renderTournamentKeyJpeg(code);

        logger.info("Serving tournament key image", {
          aid,
          rid,
          tournamentType: tournamentType || "cpu",
          code,
        });

        sendBinary(res, 200, jpeg, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "no-store",
          "X-Nitto-Source": "generated:generateTournamentKey.aspx",
        });
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("upload.aspx")) {
        // --- File size limit ---
        if (bodyBytes.length > MAX_UPLOAD_BYTES) {
          logger.warn("Upload rejected (too large)", { bytes: bodyBytes.length, max: MAX_UPLOAD_BYTES });
          uploadsTotal.inc({ type: "unknown", result: "rejected_size" });
          sendText(res, 413, `<r s='0'/>`);
          return;
        }

        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        
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

            // --- MIME / extension validation ---
            const uploadedFilename = filenameMatch[1].toLowerCase();
            const ext = uploadedFilename.includes(".") ? "." + uploadedFilename.split(".").pop() : "";
            if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
              logger.warn("Upload rejected (disallowed extension)", { filename: filenameMatch[1], ext });
              uploadsTotal.inc({ type: "unknown", result: "rejected_mime" });
              sendText(res, 415, `<r s='0'/>`);
              return;
            }
            
            const fieldName = nameMatch[1];
            const fileData = Buffer.from(part.substring(headerEnd + 4, part.length - 2), "binary");

            // Resolve pending upload by session key extracted from the
            // preceding uploadrequest action (falls back to IP for legacy compat).
            const sessionKeyFromHeader = requestUrl.searchParams.get("sk") || "";
            const pendingUpload =
              pendingUploadsBySession.get(sessionKeyFromHeader) ||
              pendingUploadsBySession.get(remoteAddress) ||
              null;
            
            // Sanitize decalId to prevent path traversal
            const rawDecalId = Date.now() % 100000;
            const decalId = String(rawDecalId).replace(/[^0-9]/g, '');
            
            let targetPath = userDecalPath(`${decalId}.jpg`);
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
              uploadsTotal.inc({ type: pendingUpload?.type || "userDecals", result: "success" });
              logger.info("Saved upload file", {
                fieldName,
                bytes: fileData.length,
                type: pendingUpload?.type || "userDecals",
                targetPath,
              });
            } catch (err) {
              uploadsTotal.inc({ type: pendingUpload?.type || "userDecals", result: "error" });
              logger.error("Failed to save upload", { error: err.message, targetPath });
            }

            // Remove by whichever key matched
            if (sessionKeyFromHeader && pendingUploadsBySession.has(sessionKeyFromHeader)) {
              pendingUploadsBySession.delete(sessionKeyFromHeader);
            } else {
              pendingUploadsBySession.delete(remoteAddress);
            }
            
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
        supabase,
        logger,
        services,
      });

      if (decoded.action === "uploadrequest") {
        // Key by session key to prevent collisions when multiple players
        // share the same NAT/proxy IP. Fall back to IP if no session key.
        const uploadSessionKey = String(decoded.params.get("sk") || "") || remoteAddress;
        pendingUploadsBySession.set(uploadSessionKey, {
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
