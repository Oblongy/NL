import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { decodePayload, encryptPayload } from "./nitto-cipher.js";
import { advanceEngineConditionForCars } from "./engine-state.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { ensureDefaultRaceRooms, getDefaultRaceRoom } from "./race-room-catalog.js";
import { getSessionPlayerId } from "./session.js";

const MESSAGE_DELIMITER = "\x04";
const FIELD_DELIMITER = "\x1e";

export class TcpServer {
  constructor({ logger, notify, proxy, supabase, raceRoomRegistry = null, port = 3724, host = "127.0.0.1" }) {
    this.logger = logger;
    this.notify = notify;
    this.proxy = proxy;
    this.supabase = supabase;
    this.raceRoomRegistry = raceRoomRegistry;
    this.port = port;
    this.host = host;
    this.started = false;
    this.server = null;
    this.connections = new Map();
    this.nextConnId = 1;
    // Room state: roomId -> [{ connId, playerId, username, carId }]
    this.rooms = new Map();
    this.ensureRoomCatalog();
    // Pending lobby challenges keyed by server-issued race GUID.
    // The 10.0.03 lobby UI expects `RCLG` to carry a `r="<guid>"` attribute.
    this.pendingRaceChallenges = new Map();
    this.races = new Map();
    // Track race completion for cleanup
    this.raceCompletions = new Map(); // raceId -> Set of playerIds who sent RD
    
    // Cleanup stale challenges every 5 minutes
    this.challengeCleanupInterval = setInterval(() => {
      this.cleanupStaleChallenges();
    }, 5 * 60 * 1000);
  }

  async start() {
    if (this.started) return;

    this.server = createServer((socket) => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        this.started = true;
        this.logger.info("TCP server listening", { host: this.host, port: this.port });
        resolve();
      });
      this.server.on("error", (error) => {
        this.logger.error("TCP server error", { error: error.message });
        reject(error);
      });
    });
  }

  async stop() {
    if (!this.started || !this.server) return;
    
    // Clear cleanup interval
    if (this.challengeCleanupInterval) {
      clearInterval(this.challengeCleanupInterval);
      this.challengeCleanupInterval = null;
    }
    
    for (const [, conn] of this.connections) {
      try { conn.socket.destroy(); } catch {}
    }
    this.connections.clear();
    return new Promise((resolve) => {
      this.server.close(() => { this.started = false; resolve(); });
    });
  }

  handleConnection(socket) {
    const connId = this.nextConnId++;
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    this.logger.info("TCP connection opened", { connId, remoteAddr });

    const conn = {
      id: connId,
      socket,
      buffer: "",
      playerId: null,
      sessionKey: null,
      bootstrapSent: false,
      lobbyRoomsSent: false,
    };
    this.connections.set(connId, conn);

    socket.on("data", (data) => {
      try {
        this.logger.info("TCP raw data received", {
          connId,
          dataLength: data.length,
          rawData: data.toString("latin1").substring(0, 200),
        });
        this.handleData(conn, data);
      } catch (error) {
        this.logger.error("TCP data handling error", { connId, error: error.message });
      }
    });

    socket.on("end", () => {
      this.logger.info("TCP connection closed", { connId, remoteAddr });
      this.leaveRoom(conn);
      this.connections.delete(connId);
    });

    socket.on("error", (error) => {
      this.logger.error("TCP socket error", { connId, error: error.message });
      this.leaveRoom(conn);
      this.connections.delete(connId);
    });
  }

  handleData(conn, data) {
    const raw = data.toString("latin1");

    // Flash sends a cross-domain policy request as the very first bytes on any
    // raw TCP socket before it will allow game data to flow. Respond and bail.
    if (raw.startsWith("<policy-file-request/>") || conn.buffer === "" && raw.startsWith("<policy")) {
      this.logger.info("TCP policy request received", { connId: conn.id });
      const policy =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">' +
        '<cross-domain-policy>' +
        '<allow-access-from domain="*" to-ports="*"/>' +
        '</cross-domain-policy>\0';
      conn.socket.write(Buffer.from(policy, "latin1"));
      return;
    }

    conn.buffer += raw;
    const messages = conn.buffer.split(MESSAGE_DELIMITER);
    conn.buffer = messages.pop() || "";
    for (const message of messages) {
      if (message.length > 0) {
        this.handleMessage(conn, message).catch((error) => {
          this.logger.error("Async message handling error", { connId: conn.id, error: error.message });
        });
      }
    }
  }

  async handleMessage(conn, rawMessage) {
    conn._lastRaw = rawMessage;
    try {
      let decodedMessage = rawMessage;
      let seed = null;

      try {
        const decodedPayload = decodePayload(rawMessage);
        decodedMessage = decodedPayload.decoded;
        seed = decodedPayload.seed;
      } catch {
        // Some bootstrap messages are already plain-text. Keep supporting them.
      }

      const parts = decodedMessage.split(FIELD_DELIMITER);
      const messageType = parts[0];

      this.logger.info("TCP message received", {
        connId: conn.id,
        messageType,
        parts: parts.length,
        seed,
        rawMessage,
        decodedMessage,
      });

      // --- L: Login ---
      if (messageType === "L") {
        const sessionKey = parts[1];
        conn.sessionKey = sessionKey;

        if (this.supabase && sessionKey) {
          try {
            const playerId = await getSessionPlayerId({ supabase: this.supabase, sessionKey });
            if (playerId) {
              // Close any existing connections for this player
              for (const [existingConnId, existingConn] of this.connections.entries()) {
                if (existingConnId !== conn.id && existingConn.playerId === playerId) {
                  this.logger.info("Closing stale connection for player", { staleConnId: existingConnId, playerId });
                  this.leaveRoom(existingConn);
                  existingConn.socket?.destroy();
                  this.connections.delete(existingConnId);
                }
              }
              conn.playerId = playerId;
              // Also fetch username for room display
              const { data: player } = await this.supabase
                .from("game_players")
                .select("username, default_car_game_id")
                .eq("id", playerId)
                .maybeSingle();
              conn.username = player?.username || "Player";
              conn.carId = Number(player?.default_car_game_id || 0);
              this.logger.info("Player associated with connection", { connId: conn.id, playerId, username: conn.username });
            }
          } catch (error) {
            this.logger.error("Failed to lookup player ID from session", { connId: conn.id, error: error.message });
          }
        }

        // Python server: render_tuple("ac","L","s",1,"ni",1000,"ns",30,"tid",1,"trp",0,"trbp",0,"lft","0.5")
        this.sendMessage(conn, '"ac", "L", "s", 1, "ni", 1000, "ns", 30, "tid", 1, "trp", 0, "trbp", 0, "lft", "0.5"');
        // Python server: render_tuple("ac","GNL","d","<buddies><I id='1' n='ben' s='1' b='0' r='2' l='5' ul='5'/></buddies>")
        this.sendMessage(conn, '"ac", "GNL", "d", "<buddies></buddies>"');
        this.logger.info("TCP login complete", { connId: conn.id, sessionKey, playerId: conn.playerId });

      // --- HTI: Heartbeat ---
      } else if (messageType === "HTI") {
        // Python server: render_tuple("ac","HTI","s","<i ut='...' s='1' li='1' it='1'/>")
        const ut = Math.floor(Date.now() / 1000);
        this.sendMessage(conn, `"ac", "HTI", "s", "<i ut='${ut}' s='1' li='1' it='1'/>"`);

      // --- S / I: In-race position sync --- forward to opponent, don't ack
      } else if (messageType === "S" || messageType === "I") {
        // Find race via raceId or by scanning for this player
        let syncRace = conn.raceId ? this.races.get(conn.raceId) : null;
        if (!syncRace && conn.playerId) {
          for (const [, r] of this.races) {
            if (r.players.some(p => Number(p.playerId) === Number(conn.playerId))) {
              syncRace = r;
              conn.raceId = r.id;
              break;
            }
          }
        }
        if (syncRace) {
          for (const p of syncRace.players) {
            if (p.connId === conn.id) continue;
            const opponentConn = this.connections.get(p.connId);
            if (opponentConn) {
              opponentConn.socket.write(
                Buffer.from(conn._lastRaw + MESSAGE_DELIMITER, "latin1")
              );
            }
          }
        }
        // no ack

      // --- RD: Race done / result data ---
      } else if (messageType === "RD") {
        this.logger.info("TCP RD received", { connId: conn.id, parts: parts.length });
        this.sendMessage(conn, '"ac", "RD", "s", 1');
        
        // Apply engine wear even if race is missing (per protocol spec)
        const race = conn.raceId ? this.races.get(conn.raceId) : null;
        const playerId = conn.playerId;
        
        if (race) {
          // Track completion for cleanup
          if (!this.raceCompletions.has(race.id)) {
            this.raceCompletions.set(race.id, new Set());
          }
          this.raceCompletions.get(race.id).add(playerId);
          
          // Apply engine wear once per race
          if (!race.engineWearApplied) {
            advanceEngineConditionForCars(race.players.map((player) => player.carId));
            race.engineWearApplied = true;
            this.logger.info("TCP RD applied engine wear", { raceId: race.id });
          }
          
          // Clean up race if both players have sent RD
          const completions = this.raceCompletions.get(race.id);
          const allPlayersCompleted = race.players.every(p => completions.has(p.playerId));
          
          if (allPlayersCompleted) {
            this.races.delete(race.id);
            this.raceCompletions.delete(race.id);
            this.logger.info("TCP race cleaned up", { raceId: race.id });
          }
        } else if (playerId && conn.raceId) {
          // Race already cleaned up but we still need to apply engine wear
          // Try to get car ID from connection or database
          const carId = conn.carId;
          if (carId) {
            advanceEngineConditionForCars([carId]);
            this.logger.info("TCP RD applied engine wear (race missing)", { playerId, carId });
          }
        }
        
        this.handleRaceResult(conn, parts);

      // --- Single-char bootstrap packets: post-login handshake variants ---
      } else if (messageType.length === 1 && /^[A-Za-z0-9]$/.test(messageType)) {
        this.logger.info("TCP bootstrap received", {
          connId: conn.id,
          messageType,
          tokenLength: (parts[1] || "").length,
        });
        this.sendMessage(conn, `"ac", "${messageType}", "s", 1`);
        this.sendInitialLobbyBootstrap(conn, { source: messageType });

      // --- LRCR2: Get room list ---
      } else if (messageType === "LRCR2") {
        this.sendInitialLobbyBootstrap(conn, { source: "LRCR2", includeHandshake: false, forceRooms: true });
        this.logger.info("Sent LRCR2 room list", { connId: conn.id });

      // --- JRC: Join room (create) ---
      } else if (messageType === "JRC") {
        const playerId = conn.playerId || 0;
        const username = conn.username || "Player";
        const roomId = this.resolveRoomIdForJoin(conn, parts);
        this.leaveRoom(conn);
        conn.roomId = roomId;

        // Add player to room, removing any stale entries for this connId OR playerId
        const room = this.rooms.get(roomId) || [];
        const filtered = room.filter(p => p.connId !== conn.id && p.playerId !== playerId);
        filtered.push({ connId: conn.id, playerId, username, carId: conn.carId || 0 });
        this.rooms.set(roomId, filtered);

        if (this.raceRoomRegistry && playerId > 0) {
          const syncResult = this.raceRoomRegistry.addPlayer(roomId, {
            id: playerId,
            publicId: getPublicIdForPlayer({ id: playerId }),
            name: username,
          });
          if (!syncResult.success) {
            this.logger.warn("Failed to sync TCP room membership to registry", {
              connId: conn.id,
              playerId,
              roomId,
              error: syncResult.error,
            });
          }
        }

        // Send JR, LR, LRCU x2 to joining player
        this.sendMessage(conn, '"ac", "JR", "s", 1');
        this.sendRoomSnapshot(conn, filtered, { duplicateUsers: true });

        // Notify all OTHER players in room that someone joined (send updated LRCU)
        for (const member of filtered) {
          if (member.connId === conn.id) continue;
          const otherConn = this.connections.get(member.connId);
          if (otherConn) {
            this.sendRoomUsers(otherConn, filtered);
          }
        }

        this.logger.info("Player joined room", { connId: conn.id, playerId, username, roomId, roomSize: filtered.length });

      // --- LRC: Room refresh / content check ---
      } else if (messageType === "LRC") {
        this.handleLobbyRoomRefresh(conn);

      // --- GR: Get race (after JRC, triggers race announcement) ---
      } else if (messageType === "GR") {
        this.logger.info("TCP GR received", { connId: conn.id });
        this.sendMessage(conn, '"ac", "GR", "s", 1');

      // --- TC: Team / title channel selection ---
      } else if (messageType === "TC") {
        this.logger.info("TCP TC received", {
          connId: conn.id,
          channelName: parts[1] || "",
        });
        this.sendMessage(conn, '"ac", "TC", "s", 1');

      // --- RRQ: Live race request / matchmaking handshake ---
      } else if (messageType === "RRQ") {
        this.handleRaceRequest(conn, parts);

      // --- LO: Logout ---
      } else if (messageType === "LO") {
        conn.socket.end();

      // --- TE / CRC: Chat message in room ---
      } else if (messageType === "TE" || messageType === "CRC") {
        this.logger.info("TCP chat parts", { connId: conn.id, messageType, parts });
        // CRC has 8 parts - find the text (longest non-numeric part after index 0)
        const chatText = messageType === "CRC"
          ? parts.slice(1).find(p => p.length > 1 && !/^\d+$/.test(p)) || ""
          : (parts[1] || "");
        this.logger.info("TCP chat received", { connId: conn.id, messageType, chatText });
        if (conn.roomId && chatText) {
          const room = this.rooms.get(conn.roomId) || [];
          const chatMsg = `"ac", "TE", "i", "${conn.playerId}", "t", "${chatText}"`;
          for (const member of room) {
            const memberConn = this.connections.get(member.connId);
            if (memberConn) this.sendMessage(memberConn, chatMsg);
          }
        }

      // --- SRC: Start Race Connection ---
      // The Flash client opens a *second* TCP connection for the actual race
      // data exchange. The first message on that connection is SRC carrying
      // the session key so we can associate it with the lobby connection.
      // Format observed: SRC \x1e <sessionKey> [\x1e <raceGuid>]
      } else if (messageType === "SRC") {
        const srcSessionKey = parts[1] || "";
        const srcRaceGuid   = parts[2] || "";
        this.logger.info("TCP SRC received (race channel open)", {
          connId: conn.id,
          srcSessionKey,
          srcRaceGuid,
        });

        // Resolve the player from the session key
        if (this.supabase && srcSessionKey) {
          try {
            const playerId = await getSessionPlayerId({ supabase: this.supabase, sessionKey: srcSessionKey });
            if (playerId) {
              conn.playerId = playerId;
              conn.sessionKey = srcSessionKey;
              const { data: player } = await this.supabase
                .from("game_players")
                .select("username, default_car_game_id")
                .eq("id", playerId)
                .maybeSingle();
              conn.username = player?.username || "Player";
              conn.carId = Number(player?.default_car_game_id || 0);
            }
          } catch (err) {
            this.logger.error("SRC session lookup failed", { connId: conn.id, error: err.message });
          }
        }

        // Find the active race for this player (by GUID hint or by playerId)
        let srcRace = null;
        if (srcRaceGuid) {
          srcRace = this.races.get(srcRaceGuid) || this.pendingRaceChallenges.get(srcRaceGuid) || null;
        }
        if (!srcRace && conn.playerId) {
          for (const [, r] of this.races) {
            if (r.players.some(p => Number(p.playerId) === Number(conn.playerId))) {
              srcRace = r;
              break;
            }
          }
        }

        if (srcRace) {
          // Attach this race-channel connection to the race
          conn.raceId = srcRace.id;
          
          // Update the race player's connId to point to this race channel connection
          // This ensures I/S packets are forwarded to the correct connection
          const racePlayer = srcRace.players.find(p => Number(p.playerId) === Number(conn.playerId));
          if (racePlayer) {
            racePlayer.connId = conn.id;
            this.logger.info("TCP SRC updated race player connId", { 
              connId: conn.id, 
              raceId: srcRace.id, 
              playerId: conn.playerId 
            });
          }
          
          const [p1, p2] = srcRace.players;
          // Acknowledge the race channel and push the race-start burst
          this.sendMessage(conn, '"ac", "SRC", "s", 1');
          this.sendMessage(conn, `"ac", "RRA", "d", "${this.escapeForTcp(this.buildRraXml({
            challengerPlayerId: p1.playerId,
            challengerCarId:    p1.carId,
            challengedPlayerId: p2.playerId,
            challengedCarId:    p2.carId,
            trackId: srcRace.trackId || 32,
          }))}"`);
          this.sendMessage(conn, `"ac", "RO", "t", ${srcRace.trackId || 32}`);
          this.sendInitialIoFrames(conn);
          this.logger.info("TCP SRC race channel linked", { connId: conn.id, raceId: srcRace.id });
        } else {
          // No active race yet — just ack so the client doesn't time out
          this.sendMessage(conn, '"ac", "SRC", "s", 1');
          this.logger.info("TCP SRC ack sent (no active race found)", { connId: conn.id });
        }

      // --- RRS: Race ready status ---
      } else if (messageType === "RRS") {
        this.handleRaceReady(conn, parts);

      // --- RO: Race open ---
      } else if (messageType === "RO") {
        this.handleRaceOpen(conn);

      // --- RR: Race result ---
      } else if (messageType === "RR") {
        this.handleRaceResult(conn, parts);

      } else {
        this.logger.info("TCP unhandled message", { connId: conn.id, messageType });
      }

    } catch (error) {
      this.logger.error("TCP message handling error", {
        connId: conn.id,
        error: error.message,
        message: rawMessage.substring(0, 200),
      });
    }
  }

  leaveRoom(conn) {
    if (conn.raceId) {
      const race = this.races.get(conn.raceId);
      if (race) {
        race.players = race.players.filter((player) => player.connId !== conn.id);
        if (race.players.length === 0) {
          this.races.delete(conn.raceId);
          this.raceCompletions.delete(conn.raceId);
          this.logger.info("TCP race cleaned up (all players left)", { raceId: conn.raceId });
        }
      }
    }
    if (!conn.roomId) return;
    const room = this.rooms.get(conn.roomId) || [];
    const updated = room.filter(p => p.connId !== conn.id);
    this.rooms.set(conn.roomId, updated);
    // Notify remaining players
    if (updated.length > 0) {
      for (const member of updated) {
        const otherConn = this.connections.get(member.connId);
        if (otherConn) this.sendRoomUsers(otherConn, updated);
      }
    }
    this.logger.info("Player left room", { connId: conn.id, roomId: conn.roomId, remaining: updated.length });
    conn.roomId = null;
  }

  sendInitialLobbyBootstrap(conn, { source, includeHandshake = true, forceRooms = false } = {}) {
    if (includeHandshake && !conn.bootstrapSent) {
      const ut = Math.floor(Date.now() / 1000);
      // 10.0.03 enters lobby after the socket side sees the login/bootstrap
      // sequence complete. Emit the canonical handshake burst once so the beta
      // client can satisfy its socket-ready gate before it starts room flow.
      this.sendMessage(conn, '"ac", "L", "s", 1, "ni", 1000, "ns", 30, "tid", 1, "trp", 0, "trbp", 0, "lft", "0.5"');
      this.sendMessage(conn, '"ac", "GNL", "d", "<buddies></buddies>"');
      this.sendMessage(conn, `"ac", "HTI", "s", "<i ut='${ut}' s='1' li='1' it='1'/>"`);
      conn.bootstrapSent = true;
      this.logger.info("TCP initial lobby bootstrap sent", { connId: conn.id, source });
    }

    if (forceRooms || !conn.lobbyRoomsSent) {
      this.sendMessage(
        conn,
        `"ac", "LRCR2", "d", "${this.escapeForTcp(this.buildLobbyRoomsXml())}"`
      );
      conn.lobbyRoomsSent = true;
    }
  }

  ensureRoomCatalog() {
    const knownRooms = ensureDefaultRaceRooms(this.raceRoomRegistry);
    for (const room of knownRooms) {
      const roomId = Number(room.roomId ?? room.id ?? 0);
      if (roomId > 0 && !this.rooms.has(roomId)) {
        this.rooms.set(roomId, []);
      }
    }
  }

  getRoomDefinitions() {
    const registryRooms = this.raceRoomRegistry?.list?.() || ensureDefaultRaceRooms();
    return registryRooms.map((room) => {
      const fallback = getDefaultRaceRoom(room.roomId) || {};
      return {
        roomId: Number(room.roomId ?? fallback.id ?? 0),
        name: room.name || fallback.name || `Room ${room.roomId}`,
        type: room.type || fallback.type || "team",
        maxPlayers: Number(room.maxPlayers ?? fallback.maxPlayers ?? 8),
        tcpRoomType: Number(room.tcpRoomType ?? fallback.tcpRoomType ?? 5),
        systemMessages: Number(room.systemMessages ?? fallback.systemMessages ?? 0),
        players: room.players || [],
      };
    });
  }

  getRoomDefinition(roomId) {
    return this.getRoomDefinitions().find((room) => Number(room.roomId) === Number(roomId)) || null;
  }

  buildLobbyRoomsXml() {
    const roomsXml = this.getRoomDefinitions().map((room) => {
      const tcpPlayerCount = this.rooms.get(room.roomId)?.length ?? 0;
      const activePlayers = tcpPlayerCount > 0 ? tcpPlayerCount : (room.players.length ?? 0);
      return (
        `<r rc='${activePlayers}' cy='${room.maxPlayers}' rt='${room.tcpRoomType}' ` +
        `cid='${room.roomId}' rn='${this.escapeXml(room.name)}' ip='0' mo='0' sm='${room.systemMessages}' pro='0'/>`
      );
    }).join("");
    return `<rooms>${roomsXml}</rooms>`;
  }

  buildRoomQueueXml(roomPlayers, roomId = null) {
    const roomType = this.getRoomDefinition(roomId)?.type || "";

    // KOTH strips use a line-up list keyed by racer/car, not Rivals challenge
    // pairs. The 10.0.03 room movie expects at least one child node here and
    // reads `i` + `ci` directly when rendering the queue.
    if (roomType === "bracket_koth" || roomType === "h2h_koth") {
      const queueXml = roomPlayers.map((player) =>
        `<k i='${player.playerId}' ci='${player.carId}'/>`
      ).join("");
      return `<q>${queueXml}</q>`;
    }

    const queueXml = roomPlayers.map((player) =>
      `<r i='${player.playerId}' icid='${player.carId}' ci='${player.playerId}' cicid='${player.carId}' bt='0' b='0'/>`
    ).join("");
    return `<q>${queueXml}</q>`;
  }

  buildRoomUsersXml(roomPlayers) {
    const usersXml = roomPlayers.map((player) =>
      `<u i='${player.playerId}' un='${player.username}' ti='1' tid='1' tf='7D7D7D' ms='5' iv='0'/>`
    ).join("");
    return `<ul>${usersXml}</ul>`;
  }

  sendRoomUsers(conn, roomPlayers) {
    this.sendMessage(conn, `"ac", "LRCU", "d", "${this.buildRoomUsersXml(roomPlayers)}"`);
  }

  sendRoomSnapshot(conn, roomPlayers, { duplicateUsers = false } = {}) {
    this.sendMessage(conn, `"ac", "LR", "s", "${this.escapeForTcp(this.buildRoomQueueXml(roomPlayers, conn.roomId))}"`);
    this.sendRoomUsers(conn, roomPlayers);
    if (duplicateUsers) {
      this.sendRoomUsers(conn, roomPlayers);
    }
  }

  isKnownRoomId(roomId) {
    if (Number(roomId) <= 0) {
      return false;
    }

    return this.getRoomDefinitions().some((room) => Number(room.roomId) === Number(roomId));
  }

  resolveRoomIdForJoin(conn, parts = []) {
    // 10.0.03 uses chatJoin(roomType, cid, ..., asInvisible), so the canonical
    // category/room id arrives in JRC field #2. Older synthetic fixtures in
    // this repo sometimes placed the room id in field #1, so keep that only as
    // a defensive fallback.
    const requestedRoomId = Number(parts[2] || 0);
    if (this.isKnownRoomId(requestedRoomId)) {
      return requestedRoomId;
    }

    const fallbackRoomId = Number(parts[1] || 0);
    if (this.isKnownRoomId(fallbackRoomId)) {
      return fallbackRoomId;
    }

    const playerId = Number(conn.playerId || 0);
    if (playerId > 0 && this.raceRoomRegistry) {
      const selectedRoom = this.raceRoomRegistry.getRoomByPlayer(playerId);
      if (selectedRoom?.roomId) {
        return Number(selectedRoom.roomId);
      }
    }
    return 1;
  }

  handleLobbyRoomRefresh(conn) {
    const roomId = Number(conn.roomId || 0);
    const roomPlayers = this.rooms.get(roomId) || [];

    // 10.0.03 captures show `LRC` as a standalone lobby packet after room
    // entry. Treat it as a room-content refresh using the canonical `LR` +
    // `LRCU` snapshot we already emit on join, but do not invent a new ack.
    if (roomId > 0 && roomPlayers.some((player) => player.connId === conn.id)) {
      this.sendRoomSnapshot(conn, roomPlayers);
    }

    this.logger.info("TCP LRC received", {
      connId: conn.id,
      roomId: roomId || null,
      roomSize: roomPlayers.length,
    });
  }

  handleRaceRequest(conn, parts) {
    const requesterPlayerId = Number(conn.playerId || 0);
    const requesterCarId = Number(parts[1] || conn.carId || 0);
    const targetPlayerId = Number(parts[2] || 0);
    const targetCarId = Number(parts[3] || 0);
    const lane = Number(parts[4] || 0);
    // Observed client packets carry a trailing `-1` when no bracket/bet is set.
    // In 10.0.03 XML this maps to the `b` (bracket time) attribute, not `bt`.
    const bracketTime = Number(parts[5] || -1);

    this.sendMessage(conn, '"ac", "RRQ", "s", 1');

    const targetConn = this.findConnectionByPlayerId(targetPlayerId);
    if (!targetConn) {
      this.logger.info("TCP RRQ ignored (target not connected)", {
        connId: conn.id,
        requesterPlayerId,
        targetPlayerId,
      });
      return;
    }

    const raceGuid = randomUUID();
    const challenge = {
      id: raceGuid,
      roomId: conn.roomId || 1,
      trackId: 32,
      createdAt: Date.now(),
      challenger: {
        connId: conn.id,
        playerId: requesterPlayerId,
        carId: requesterCarId,
        username: conn.username || "Player",
        lane,
      },
      challenged: {
        connId: targetConn.id,
        playerId: targetPlayerId,
        carId: targetCarId,
        username: targetConn.username || "Player",
      },
      bracketTime,
      // Treat the challenger as ready by virtue of initiating the request. The
      // challenged side becomes ready once they accept (RRS echoing `raceGuid`).
      ready: {
        challenger: true,
        challenged: false,
      },
    };

    this.pendingRaceChallenges.set(raceGuid, challenge);

    this.logger.info("TCP RRQ queued", {
      connId: conn.id,
      raceGuid,
      requesterPlayerId,
      requesterCarId,
      targetPlayerId,
      targetCarId,
      lane,
      bracketTime,
    });

    // Notify the target client using the same RCLG XML shape the 10.0.03 lobby
    // uses for incoming challenges (see RivalsChallengePanel.addChallenge()).
    const ucuXml = this.buildUcuXml({
      playerId: requesterPlayerId,
      username: conn.username || "Player",
    });
    const rclgXml = this.buildRclgXml({
      challengerPlayerId: requesterPlayerId,
      challengerCarId: requesterCarId,
      challengedPlayerId: targetPlayerId,
      challengedCarId: targetCarId,
      bracketTime,
      raceGuid,
    });

    this.sendMessage(targetConn, `"ac", "UCU", "d", "${this.escapeForTcp(ucuXml)}"`);
    this.sendMessage(targetConn, `"ac", "RCLG", "d", "${this.escapeForTcp(rclgXml)}"`);
  }

  findConnectionByPlayerId(playerId) {
    if (!playerId) return null;
    for (const [, candidate] of this.connections) {
      if (Number(candidate.playerId || 0) === Number(playerId)) return candidate;
    }
    return null;
  }

  escapeXml(value) {
    if (!value) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  escapeForTcp(value) {
    if (!value) return "";
    // Messages are encoded as `"..."` tokens; escape internal quotes.
    return String(value).replace(/"/g, '\\"');
  }

  buildUcuXml({ playerId, username }) {
    return `<ul><u ul='0' i='${Number(playerId)}' un='${this.escapeXml(username)}' ti='2' tid='2' tf='7D7D7D' ms='5' iv='0'/></ul>`;
  }

  buildRclgXml({
    challengerPlayerId,
    challengerCarId,
    challengedPlayerId,
    challengedCarId,
    bracketTime,
    raceGuid,
  }) {
    return (
      `<r i='${Number(challengerPlayerId)}' ci='${Number(challengedPlayerId)}' ` +
      `icid='${Number(challengerCarId)}' cicid='${Number(challengedCarId)}' ` +
      `bt='0' b='${Number(bracketTime)}' r='${raceGuid}'/>`
    );
  }

  buildRnXml({ challengerPlayerId, challengerCarId, challengedPlayerId, challengedCarId }) {
    return (
      `<q><r i='${Number(challengerPlayerId)}' icid='${Number(challengerCarId)}' ` +
      `ci='${Number(challengedPlayerId)}' cicid='${Number(challengedCarId)}'/></q>`
    );
  }

  buildRraXml({ challengerPlayerId, challengerCarId, challengedPlayerId, challengedCarId, trackId }) {
    return (
      `<r r1id='${Number(challengerPlayerId)}' r2id='${Number(challengedPlayerId)}' ` +
      `r1cid='${Number(challengerCarId)}' r2cid='${Number(challengedCarId)}' ` +
      `b1='-1' b2='-1' bt='0' sc1='0' sc2='0' t='${Number(trackId)}'/>`
    );
  }

  createRaceSession(requestA, requestB) {
    const connA = this.connections.get(requestA.connId);
    const connB = this.connections.get(requestB.connId);
    if (!connA || !connB) {
      this.logger.warn("Race session aborted due to missing connection", {
        requestAConnId: requestA.connId,
        requestBConnId: requestB.connId,
      });
      return;
    }

    const raceId = randomUUID();
    const race = {
      id: raceId,
      roomId: requestA.roomId || requestB.roomId || 1,
      players: [
        {
          connId: requestA.connId,
          playerId: requestA.requesterPlayerId,
          carId: requestA.requesterCarId,
          lane: requestA.lane,
          bet: requestA.bet,
          ready: false,
          opened: false,
        },
        {
          connId: requestB.connId,
          playerId: requestB.requesterPlayerId,
          carId: requestB.requesterCarId,
          lane: requestB.lane,
          bet: requestB.bet,
          ready: false,
          opened: false,
        },
      ],
      announced: false,
      trackId: 32,
      createdAt: Date.now(),
    };

    this.races.set(raceId, race);
    connA.raceId = raceId;
    connB.raceId = raceId;

    this.sendRaceCreate(race);
    this.logger.info("TCP RRQ matched", {
      raceId,
      players: race.players.map((player) => ({
        connId: player.connId,
        playerId: player.playerId,
        carId: player.carId,
      })),
    });
  }

  handleRaceReady(conn, parts) {
    // If we already have an active race, keep the existing per-player ready flow.
    const existingRace = conn.raceId ? this.races.get(conn.raceId) : null;
    if (existingRace) {
      const player = existingRace.players.find((entry) => entry.connId === conn.id);
      if (!player) {
        this.logger.info("TCP RRS received from unknown race player", { connId: conn.id, raceId: existingRace.id });
        return;
      }

      player.ready = true;
      this.sendMessage(conn, `"ac", "RRS", "s", 1, "i", "${existingRace.id}"`);
      this.logger.info("TCP RRS received", {
        connId: conn.id,
        raceId: existingRace.id,
        readyCount: existingRace.players.filter((entry) => entry.ready).length,
      });

      if (!existingRace.announced && existingRace.players.every((entry) => entry.ready)) {
        existingRace.announced = true;
        for (const participant of existingRace.players) {
          const participantConn = this.connections.get(participant.connId);
          if (!participantConn) continue;
          this.sendMessage(participantConn, `"ac", "RN", "d", "${this.escapeForTcp(this.buildRnXml({
            challengerPlayerId: existingRace.players[0].playerId,
            challengerCarId: existingRace.players[0].carId,
            challengedPlayerId: existingRace.players[1].playerId,
            challengedCarId: existingRace.players[1].carId,
          }))}"`);
          this.sendMessage(
            participantConn,
            `"ac", "RRA", "d", "${this.escapeForTcp(
              this.buildRraXml({
                challengerPlayerId: existingRace.players[0].playerId,
                challengerCarId: existingRace.players[0].carId,
                challengedPlayerId: existingRace.players[1].playerId,
                challengedCarId: existingRace.players[1].carId,
                trackId: 32,
              })
            )}"`
          );
          // Fallback: if the client doesn't emit RO, bootstrap the track anyway.
          this.sendMessage(participantConn, '"ac", "RO", "t", 32');
          this.sendInitialIoFrames(participantConn);
        }
        this.logger.info("TCP race ready broadcast sent", { raceId: existingRace.id });
      }
      return;
    }

    // Otherwise treat this as accepting a pending lobby challenge.
    const guid = parts.find((part) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) || "";
    const pending = guid ? this.pendingRaceChallenges.get(guid) : null;
    if (!pending) {
      this.logger.info("TCP RRS received without race", { connId: conn.id, parts });
      return;
    }

    if (Number(conn.playerId || 0) === pending.challenger.playerId) {
      pending.ready.challenger = true;
    } else if (Number(conn.playerId || 0) === pending.challenged.playerId) {
      pending.ready.challenged = true;
    }

    this.sendMessage(conn, `"ac", "RRS", "s", 1, "i", "${pending.id}"`);
    this.logger.info("TCP RRS accepted challenge", {
      connId: conn.id,
      raceGuid: pending.id,
      challengerReady: pending.ready.challenger,
      challengedReady: pending.ready.challenged,
    });

    if (!pending.ready.challenger || !pending.ready.challenged) {
      return;
    }

    this.pendingRaceChallenges.delete(pending.id);

    const challengerConn = this.connections.get(pending.challenger.connId);
    const challengedConn = this.connections.get(pending.challenged.connId);
    if (!challengerConn || !challengedConn) {
      this.logger.warn("Race session aborted due to missing connection", {
        raceGuid: pending.id,
        challengerConnId: pending.challenger.connId,
        challengedConnId: pending.challenged.connId,
      });
      return;
    }

    const race = {
      id: pending.id,
      roomId: pending.roomId,
      players: [
        {
          connId: pending.challenger.connId,
          playerId: pending.challenger.playerId,
          carId: pending.challenger.carId,
          lane: 1,
          bet: 0,
          ready: true,
          opened: false,
        },
        {
          connId: pending.challenged.connId,
          playerId: pending.challenged.playerId,
          carId: pending.challenged.carId,
          lane: 2,
          bet: 0,
          ready: true,
          opened: false,
        },
      ],
      announced: true,
      trackId: pending.trackId || 32,
      createdAt: Date.now(),
    };

    this.races.set(race.id, race);
    challengerConn.raceId = race.id;
    challengedConn.raceId = race.id;

    const rnXml = this.buildRnXml({
      challengerPlayerId: pending.challenger.playerId,
      challengerCarId: pending.challenger.carId,
      challengedPlayerId: pending.challenged.playerId,
      challengedCarId: pending.challenged.carId,
    });
    const rraXml = this.buildRraXml({
      challengerPlayerId: pending.challenger.playerId,
      challengerCarId: pending.challenger.carId,
      challengedPlayerId: pending.challenged.playerId,
      challengedCarId: pending.challenged.carId,
      trackId: pending.trackId,
    });

    for (const participantConn of [challengerConn, challengedConn]) {
      this.sendMessage(participantConn, `"ac", "RN", "d", "${this.escapeForTcp(rnXml)}"`);
      this.sendMessage(participantConn, `"ac", "RRA", "d", "${this.escapeForTcp(rraXml)}"`);
      // Fallback: some clients don't send RO after RN/RRA. Bootstrap anyway.
      this.sendMessage(participantConn, `"ac", "RO", "t", ${pending.trackId}`);
      this.sendInitialIoFrames(participantConn);
    }

    this.logger.info("TCP race started from RRQ/RRS", {
      raceGuid: race.id,
      challengerPlayerId: pending.challenger.playerId,
      challengedPlayerId: pending.challenged.playerId,
    });
  }

  handleRaceOpen(conn) {
    const race = conn.raceId ? this.races.get(conn.raceId) : null;
    if (!race) {
      this.logger.info("TCP RO received without race", { connId: conn.id });
      return;
    }

    const player = race.players.find((entry) => entry.connId === conn.id);
    if (!player) {
      this.logger.info("TCP RO received from unknown race player", { connId: conn.id, raceId: race.id });
      return;
    }

    player.opened = true;
    this.logger.info("TCP RO received", { connId: conn.id, raceId: race.id, openedCount: race.players.filter((entry) => entry.opened).length });

    this.sendMessage(conn, '"ac", "RO", "t", 32');
    this.sendInitialIoFrames(conn);
  }

  handleRaceResult(conn, parts) {
    const race = conn.raceId ? this.races.get(conn.raceId) : null;
    this.logger.info("TCP RR received", {
      connId: conn.id,
      raceId: race?.id || null,
      parts,
    });

    if (!race) return;

    if (!race.engineWearApplied) {
      advanceEngineConditionForCars(race.players.map((player) => player.carId));
      race.engineWearApplied = true;
    }

    this.sendMessage(conn, '"ac", "RR", "s", 1');
    this.sendMessage(conn, '"ac", "UR", "s", 1');
    this.sendMessage(conn, '"ac", "OR", "s", 1');
  }

  sendRaceCreate(race) {
    const [playerOne, playerTwo] = race.players;
    const message =
      `"ac", "RCLG", "s", 1, "i", "${race.id}", "r1id", "${playerOne.playerId}", "r2id", "${playerTwo.playerId}", "r1cid", "${playerOne.carId}", "r2cid", "${playerTwo.carId}"`;

    for (const participant of race.players) {
      const participantConn = this.connections.get(participant.connId);
      if (!participantConn) continue;
      this.sendMessage(participantConn, message);
    }
  }

  buildRraMessage(race) {
    const [playerOne, playerTwo] = race.players;
    return `"ac", "RRA", "d", "<r r1id='${playerOne.playerId}' r2id='${playerTwo.playerId}' r1cid='${playerOne.carId}' r2cid='${playerTwo.carId}' b1='-1' b2='-1' bt='0' sc1='0' sc2='0' t='32'/>"`;
  }

  sendInitialIoFrames(conn) {
    const frames = [
      { d: "-13", v: "0", a: "0", t: "0" },
      { d: "-12.863", v: "0.698", a: "36.072", t: "0" },
      { d: "-12.709", v: "1.213", a: "31.555", t: "0" },
    ];

    for (const frame of frames) {
      this.sendMessage(conn, `"ac", "IO", "d", ${frame.d}, "v", ${frame.v}, "a", ${frame.a}, "t", ${frame.t}`);
    }
  }

  buildRacePairKey(playerAId, playerBId) {
    return [playerAId, playerBId].sort((left, right) => left - right).join(":");
  }

  sendMessage(conn, message) {
    try {
      const seed = Math.floor(Math.random() * 90) + 10;
      const encrypted = encryptPayload(message, seed);
      conn.socket.write(Buffer.from(encrypted + MESSAGE_DELIMITER, "latin1"));
      this.logger.info("TCP message sent", {
        connId: conn.id,
        seed,
        bytes: encrypted.length + 1,
        rawMessage: message,
      });
    } catch (error) {
      this.logger.error("TCP send error", { connId: conn.id, error: error.message });
    }
  }

  cleanupStaleChallenges() {
    const now = Date.now();
    const staleThreshold = 2 * 60 * 1000; // 2 minutes
    let cleaned = 0;

    for (const [guid, challenge] of this.pendingRaceChallenges.entries()) {
      if (now - challenge.createdAt > staleThreshold) {
        this.pendingRaceChallenges.delete(guid);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info("Cleaned up stale challenges", { count: cleaned });
    }
  }
}
