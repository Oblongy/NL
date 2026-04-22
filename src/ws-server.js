/**
 * ws-server.js — WebSocket server for the custom Tauri client.
 *
 * Attaches to the existing HTTP server at path /ws.
 * Forwards lobby events and race telemetry as JSON.
 * Reads tcpServer state read-only via polling — tcp-server.js is never modified.
 *
 * Uses the built-in Node.js http upgrade mechanism + the 'ws' package.
 * If 'ws' is not installed, falls back to a no-op with a warning.
 */

import { verifyJwt } from "./api-routes.js";

// ---------------------------------------------------------------------------
// ws package — optional peer dependency
// ---------------------------------------------------------------------------

let WebSocketServer;
try {
  const wsModule = await import("ws");
  WebSocketServer = wsModule.WebSocketServer || wsModule.default?.WebSocketServer || wsModule.default?.Server;
} catch {
  WebSocketServer = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendWs(ws, message) {
  if (!ws || ws.readyState !== 1 /* OPEN */) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // ignore send errors — connection may be closing
  }
}

function broadcastToRoom(wsSessions, roomId, message) {
  const sessions = wsSessions.get(roomId);
  if (!sessions) return;
  for (const ws of sessions) {
    sendWs(ws, message);
  }
}

function validateChatMessage(text) {
  if (typeof text !== "string") return false;
  return text.trim().length > 0;
}

/**
 * Build the JSON I-packet message from telemetry fields.
 * All field values are passed through as-is (string or number) — no rounding.
 */
export function buildIPacketJson({ raceId, playerId, d, v, a, t }) {
  return {
    type: "i",
    raceId,
    playerId,
    d: String(d),
    v: String(v),
    a: String(a),
    t: String(t),
  };
}

// ---------------------------------------------------------------------------
// WS server factory
// ---------------------------------------------------------------------------

/**
 * Create and attach a WebSocket server to the existing HTTP server.
 *
 * @param {import("node:http").Server} httpServer
 * @param {{ tcpServer: import("./tcp-server.js").TcpServer, logger: object }} services
 * @param {string} jwtSecret
 * @returns {object|null} WebSocketServer instance, or null if ws is unavailable
 */
export function createWsServer(httpServer, { tcpServer, logger }, jwtSecret) {
  if (!WebSocketServer) {
    logger?.warn("ws package not available — WebSocket server disabled. Run: npm install ws");
    return null;
  }

  if (!jwtSecret) {
    throw new Error("createWsServer: jwtSecret is required");
  }

  const wss = new WebSocketServer({ noServer: true });

  // Map<playerId, Set<WebSocket>> — connected custom-client sessions
  const sessionsByPlayerId = new Map();

  // Map<roomId, Set<WebSocket>> — WS sessions per room
  const wsByRoom = new Map();

  // Map<playerId, number> — last seen telemetry timestamp per player
  const lastSeenTelemetryAt = new Map();

  // Map<raceId, boolean> — races whose race-announced has been pushed
  const announcedRaces = new Set();

  // Map<raceId, boolean> — races whose race-result has been pushed
  const resultedRaces = new Set();

  // ---------------------------------------------------------------------------
  // JWT upgrade validation
  // ---------------------------------------------------------------------------

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") return; // not our path

    const token = url.searchParams.get("token") ||
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();

    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    let claims;
    try {
      claims = verifyJwt(token, jwtSecret);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._claims = claims;
      wss.emit("connection", ws, req);
    });
  });

  // ---------------------------------------------------------------------------
  // Connection handler
  // ---------------------------------------------------------------------------

  wss.on("connection", (ws) => {
    const claims = ws._claims;
    const playerId = Number(claims?.sub || 0);
    const username = String(claims?.username || "");
    const sessionKey = String(claims?.sk || "");

    if (!playerId) {
      sendWs(ws, { type: "error", code: "unauthorized", message: "Invalid token payload" });
      ws.close();
      return;
    }

    logger?.info("WS client connected", { playerId, username });

    // Register session
    if (!sessionsByPlayerId.has(playerId)) {
      sessionsByPlayerId.set(playerId, new Set());
    }
    sessionsByPlayerId.get(playerId).add(ws);

    // ---------------------------------------------------------------------------
    // Message dispatch
    // ---------------------------------------------------------------------------

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        sendWs(ws, { type: "error", code: "invalid-json" });
        return;
      }

      const { type } = msg;

      switch (type) {
        case "join-room":
          handleJoinRoom(ws, msg, playerId, username, sessionKey);
          break;
        case "chat":
          handleChat(ws, msg, playerId, username);
          break;
        case "challenge":
          handleChallenge(ws, msg, playerId, username);
          break;
        case "challenge-accept":
          handleChallengeAccept(ws, msg, playerId);
          break;
        case "challenge-decline":
          handleChallengeDecline(ws, msg, playerId);
          break;
        case "race-ready":
          handleRaceReady(ws, msg, playerId);
          break;
        case "race-done":
          handleRaceDone(ws, msg, playerId);
          break;
        default:
          sendWs(ws, { type: "error", code: "unknown-message-type", receivedType: type });
      }
    });

    // ---------------------------------------------------------------------------
    // Disconnect cleanup
    // ---------------------------------------------------------------------------

    ws.on("close", () => {
      logger?.info("WS client disconnected", { playerId, username });
      const sessions = sessionsByPlayerId.get(playerId);
      if (sessions) {
        sessions.delete(ws);
        if (sessions.size === 0) sessionsByPlayerId.delete(playerId);
      }
      // Remove from all rooms
      for (const [roomId, roomSessions] of wsByRoom.entries()) {
        roomSessions.delete(ws);
        if (roomSessions.size === 0) wsByRoom.delete(roomId);
      }
    });

    ws.on("error", (err) => {
      logger?.warn("WS client error", { playerId, error: err.message });
    });
  });

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  function handleJoinRoom(ws, msg, playerId, username, sessionKey) {
    const roomId = Number(msg.roomId || 1);

    // Register in room WS set
    if (!wsByRoom.has(roomId)) wsByRoom.set(roomId, new Set());
    wsByRoom.get(roomId).add(ws);

    // Build lobby snapshot from tcpServer.rooms (read-only)
    const roomPlayers = tcpServer.rooms.get(roomId) || [];
    const players = roomPlayers.map((p) => ({
      playerId: Number(p.playerId),
      username: String(p.username || ""),
      carId: Number(p.carId || 0),
    }));

    sendWs(ws, {
      type: "lobby-snapshot",
      roomId,
      players,
    });

    // Notify other WS clients in the room
    const carId = getPlayerCarId(playerId);
    broadcastToRoom(wsByRoom, roomId, {
      type: "player-joined",
      roomId,
      playerId,
      username,
      carId,
    });
  }

  function handleChat(ws, msg, playerId, username) {
    const { roomId, text } = msg;
    if (!validateChatMessage(text)) {
      sendWs(ws, { type: "error", code: "invalid-chat-message" });
      return;
    }
    broadcastToRoom(wsByRoom, Number(roomId || 1), {
      type: "chat",
      roomId: Number(roomId || 1),
      playerId,
      username,
      text: String(text).trim(),
    });
  }

  function handleChallenge(ws, msg, playerId, username) {
    const { targetPlayerId, roomId } = msg;
    if (!targetPlayerId) {
      sendWs(ws, { type: "error", code: "missing-field", field: "targetPlayerId" });
      return;
    }

    const targetSessions = sessionsByPlayerId.get(Number(targetPlayerId));
    if (!targetSessions || targetSessions.size === 0) {
      sendWs(ws, { type: "error", code: "player-not-found" });
      return;
    }

    const challengeId = generateId();
    const challengerCarId = getPlayerCarId(playerId);

    for (const targetWs of targetSessions) {
      sendWs(targetWs, {
        type: "challenge-received",
        challengeId,
        challengerPlayerId: playerId,
        challengerUsername: username,
        challengerCarId,
        roomId: Number(roomId || 1),
      });
    }

    // Store pending challenge so accept/decline can find it
    pendingWsChallenges.set(challengeId, {
      challengerId: playerId,
      challengedId: Number(targetPlayerId),
      roomId: Number(roomId || 1),
      createdAt: Date.now(),
    });

    sendWs(ws, { type: "challenge-sent", challengeId });
  }

  function handleChallengeAccept(ws, msg, playerId) {
    const { challengeId } = msg;
    const challenge = pendingWsChallenges.get(challengeId);
    if (!challenge) {
      sendWs(ws, { type: "error", code: "challenge-not-found" });
      return;
    }

    const raceId = generateId();
    pendingWsChallenges.delete(challengeId);

    // Notify challenger
    const challengerSessions = sessionsByPlayerId.get(challenge.challengerId);
    if (challengerSessions) {
      for (const cws of challengerSessions) {
        sendWs(cws, { type: "challenge-accepted", challengeId, raceId });
      }
    }

    sendWs(ws, { type: "challenge-accepted", challengeId, raceId });
  }

  function handleChallengeDecline(ws, msg, playerId) {
    const { challengeId } = msg;
    const challenge = pendingWsChallenges.get(challengeId);
    if (!challenge) {
      sendWs(ws, { type: "error", code: "challenge-not-found" });
      return;
    }

    pendingWsChallenges.delete(challengeId);

    const challengerSessions = sessionsByPlayerId.get(challenge.challengerId);
    if (challengerSessions) {
      for (const cws of challengerSessions) {
        sendWs(cws, { type: "challenge-declined", challengeId });
      }
    }

    sendWs(ws, { type: "challenge-declined", challengeId });
  }

  function handleRaceReady(ws, msg, playerId) {
    // Acknowledge — actual race start is driven by the TCP server
    sendWs(ws, { type: "race-ready-ack", raceId: msg.raceId });
  }

  function handleRaceDone(ws, msg, playerId) {
    // Acknowledge — results are pushed by the polling loop
    sendWs(ws, { type: "race-done-ack", raceId: msg.raceId });
  }

  // ---------------------------------------------------------------------------
  // Pending WS-only challenges (custom client ↔ custom client)
  // ---------------------------------------------------------------------------

  const pendingWsChallenges = new Map();

  // Cleanup stale WS challenges every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, ch] of pendingWsChallenges.entries()) {
      if (now - ch.createdAt > 5 * 60 * 1000) pendingWsChallenges.delete(id);
    }
  }, 5 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getPlayerCarId(playerId) {
    // Try to find the player's car from TCP server connection state (read-only)
    const connId = tcpServer.connIdByPlayerId?.get(Number(playerId));
    if (connId) {
      const conn = tcpServer.connections?.get(connId);
      if (conn) return Number(conn.carId || 0);
    }
    return 0;
  }

  function generateId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function getWsSessionsForRace(race) {
    const sessions = [];
    for (const player of race.players || []) {
      const pid = Number(player.playerId);
      const s = sessionsByPlayerId.get(pid);
      if (s) for (const ws of s) sessions.push({ ws, playerId: pid });
    }
    return sessions;
  }

  // ---------------------------------------------------------------------------
  // 30 Hz telemetry polling loop
  // ---------------------------------------------------------------------------

  const POLL_INTERVAL_MS = 33; // ~30 Hz

  setInterval(() => {
    if (!tcpServer.races) return;

    for (const [raceId, race] of tcpServer.races.entries()) {
      const wsParticipants = getWsSessionsForRace(race);
      if (wsParticipants.length === 0) continue;

      // Push I-packet telemetry for each player in the race
      if (race.lastTelemetryByPlayer instanceof Map) {
        for (const [pid, telemetry] of race.lastTelemetryByPlayer.entries()) {
          const lastSeen = lastSeenTelemetryAt.get(`${raceId}:${pid}`) || 0;
          if (telemetry.at > lastSeen) {
            lastSeenTelemetryAt.set(`${raceId}:${pid}`, telemetry.at);

            const packet = buildIPacketJson({
              raceId,
              playerId: pid,
              d: telemetry.distance ?? telemetry.d ?? "0",
              v: telemetry.velocity ?? telemetry.v ?? "0",
              a: telemetry.acceleration ?? telemetry.a ?? "0",
              t: telemetry.tick ?? telemetry.t ?? "0",
            });

            // Send to all WS participants in this race
            for (const { ws } of wsParticipants) {
              sendWs(ws, packet);
            }
          }
        }
      }

      // Push race-announced when race becomes active
      if (race.announced && !announcedRaces.has(raceId)) {
        announcedRaces.add(raceId);
        const players = (race.players || []).map((p) => ({
          playerId: Number(p.playerId),
          carId: Number(p.carId || 0),
          lane: Number(p.lane || 1),
          bracketTime: Number(p.bracketTime ?? -1),
        }));

        for (const { ws } of wsParticipants) {
          sendWs(ws, {
            type: "race-announced",
            raceId,
            trackId: Number(race.trackId || 32),
            players,
          });
        }
      }

      // Push race-result when engine wear has been applied (race complete)
      if (race.engineWearApplied && !resultedRaces.has(raceId)) {
        resultedRaces.add(raceId);

        // Determine winner from lastDistance
        let winnerPlayerId = null;
        let maxDistance = -Infinity;
        if (race.lastTelemetryByPlayer instanceof Map) {
          for (const [pid, tel] of race.lastTelemetryByPlayer.entries()) {
            const d = Number(tel.distance ?? tel.d ?? 0);
            if (d > maxDistance) {
              maxDistance = d;
              winnerPlayerId = pid;
            }
          }
        }

        for (const { ws, playerId: pid } of wsParticipants) {
          sendWs(ws, {
            type: "race-result",
            raceId,
            winnerPlayerId,
            moneyDelta: 0, // actual delta comes from RR handler — placeholder
            engineWear: 35, // actual wear from engine-state — placeholder
          });
        }
      }
    }

    // Cleanup stale telemetry tracking for finished races
    for (const key of lastSeenTelemetryAt.keys()) {
      const [raceId] = key.split(":");
      if (!tcpServer.races.has(raceId)) {
        lastSeenTelemetryAt.delete(key);
      }
    }
    for (const raceId of announcedRaces) {
      if (!tcpServer.races.has(raceId)) announcedRaces.delete(raceId);
    }
    for (const raceId of resultedRaces) {
      if (!tcpServer.races.has(raceId)) resultedRaces.delete(raceId);
    }
  }, POLL_INTERVAL_MS);

  logger?.info("WS server attached at /ws");
  return wss;
}
