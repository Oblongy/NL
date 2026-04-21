import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { decodeGameCodeQuery, encryptPayload } from "./nitto-cipher.js";
import { handleGameAction } from "./game-actions.js";
import { getSessionPlayerId } from "./session.js";
import { getCarById, getPlayerById, listCarsForPlayer } from "./user-service.js";
import { PARTS_CATALOG_XML } from "./parts-catalog.js";
import { httpRequestsTotal } from "./metrics.js";
import { rememberRecentDecalUpload } from "./upload-state.js";

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
    "/parts-catalog.xml",
    {
      body: PARTS_CATALOG_XML,
      contentType: "application/xml; charset=utf-8",
      source: "generated:parts-catalog.xml",
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

const pendingUploadsByRemote = new Map();
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB

// Cleanup stale uploads every 10 minutes
setInterval(() => {
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

function createTournamentKeyCode(aid, rid, tournamentType = "") {
  const digest = createHash("sha1")
    .update(`${aid}:${rid}:${tournamentType}`, "utf8")
    .digest("hex");
  const numeric = parseInt(digest.slice(0, 8), 16);
  return String((numeric % 9000) + 1000);
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

function getUserGraphicUploadResponseAttrs(slotKey, decalId, extension) {
  const normalizedSlot = String(slotKey || "").trim().toLowerCase();
  const normalizedExt = normalizeUserGraphicExt(extension);
  switch (normalizedSlot) {
    case "hood":
    case "h":
    case "160":
      return { h: decalId, hx: normalizedExt };
    case "side":
    case "s":
    case "161":
      return { s: decalId, sx: normalizedExt };
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

            if (requestUrl.pathname.toLowerCase().endsWith("usergraphicupload.aspx")) {
              const attrs = getUserGraphicUploadResponseAttrs(requestUrl.searchParams.get("slot"), decalId, requestExt);
              const serializedAttrs = Object.entries(attrs).map(([key, value]) => `${key}='${value}'`).join(" ");
              responseBody = `<r s='1' ${serializedAttrs}/>`;
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
        remoteAddress,
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
