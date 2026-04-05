import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { decodeGameCodeQuery, encryptPayload } from "./nitto-cipher.js";
import { handleGameAction } from "./game-actions.js";
import { getSessionPlayerId } from "./session.js";
import { getCarById, getPlayerById, listCarsForPlayer } from "./user-service.js";

const LOCAL_STATIC_ROUTES = new Map([
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

export function createHttpServer({ config, logger, fixtureStore, supabase, services = {} }) {
  return createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || `${config.host}:${config.port}`}`);
      const bodyBytes = await readBody(req);

      logger.info("HTTP request", {
        method: req.method,
        path: requestUrl.pathname,
        bytes: bodyBytes.length,
      });

      if (requestUrl.pathname.toLowerCase().endsWith("status.aspx")) {
        sendText(res, 200, "1");
        return;
      }

      if (requestUrl.pathname.toLowerCase().endsWith("upload.aspx")) {
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
            
            const fieldName = nameMatch[1];
            const fileData = part.substring(headerEnd + 4, part.length - 2);
            const decalId = Date.now() % 100000;
            const filename = `${decalId}.jpg`;
            
            const { writeFileSync, mkdirSync } = await import("node:fs");
            const { resolve } = await import("node:path");
            const decalDir = resolve(process.cwd(), "../cache/car/userDecals");
            try {
              mkdirSync(decalDir, { recursive: true });
              writeFileSync(resolve(decalDir, filename), Buffer.from(fileData, "binary"));
              logger.info("Saved decal file", { decalId, fieldName, bytes: fileData.length });
            } catch (err) {
              logger.error("Failed to save decal", { error: err.message });
            }
            
            // Return XML with decal ID - client reads 'i' attribute
            sendText(res, 200, `<r s='1' i='${decalId}'/>`);
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

        // Fall back to decoded capture fixtures for the remaining static routes.
        const fixture = fixtureStore.find(requestUrl.pathname);
        if (fixture) {
          logger.info("Serving static route from fixture", { 
            path: requestUrl.pathname, 
            source: fixture.key 
          });
          sendText(res, 200, fixture.body, {
            "X-Nitto-Source": `fixture:${fixture.key}`,
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
            fixtureStore,
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

      const { body, source } = await handleGameAction({
        action: decoded.action,
        params: decoded.params,
        rawQuery,
        decodedQuery: decoded.decoded,
        fixtureStore,
        supabase,
        logger,
        services,
      });

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
