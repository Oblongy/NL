import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { decodePayload, encryptPayload } from "./nitto-cipher.js";
import { advanceEngineConditionForCars } from "./engine-state.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { getClientRoleForPlayer } from "./player-role.js";
import { ensureDefaultRaceRooms, getDefaultRaceRoom } from "./race-room-catalog.js";
import { getSessionPlayerId } from "./session.js";
import {
  tcpConnectionsTotal,
  tcpActiveConnections,
  tcpMessagesReceived,
  tcpMessagesSent,
  tcpErrors,
  tcpMalformedFrames,
  tcpActiveRaces,
  tcpPendingChallenges,
  racesStartedTotal,
  racesCompletedTotal,
  cleanupEvictionsTotal,
} from "./metrics.js";

const MESSAGE_DELIMITER = "\x04";
const FIELD_DELIMITER = "\x1e";
const DEFAULT_GLOBAL_CHAT_CLASS = 2;

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
    // Room state: roomId -> [{ connId, playerId, username, carId, teamId, teamRole }]
    this.rooms = new Map();
    this.ensureRoomCatalog();
    // Pending lobby challenges keyed by server-issued race GUID.
    // The 10.0.03 lobby UI expects `RCLG` to carry a `r="<guid>"` attribute.
    this.pendingRaceChallenges = new Map();
    this.races = new Map();
    // Track race completion for cleanup
    this.raceCompletions = new Map(); // raceId -> Set of playerIds who sent RD
    // O(1) lookups for player->connection and player->race mappings
    this.connIdByPlayerId = new Map();
    this.raceIdByPlayerId = new Map();
    
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
    this.connIdByPlayerId.clear();
    this.raceIdByPlayerId.clear();
    
    return new Promise((resolve) => {
      this.server.close(() => { this.started = false; resolve(); });
    });
  }

  handleConnection(socket) {
    const connId = this.nextConnId++;
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    tcpConnectionsTotal.inc();
    tcpActiveConnections.inc();
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
      this.logger.info("TCP connection ended", { connId, remoteAddr });
      tcpActiveConnections.dec();
      this.leaveRoom(conn);
      // Clean up reverse lookups
      if (conn.playerId) {
        this.connIdByPlayerId.delete(conn.playerId);
        this.raceIdByPlayerId.delete(conn.playerId);
      }
      this.connections.delete(connId);
    });

    socket.on("close", () => {
      this.logger.info("TCP connection closed", { connId, remoteAddr });
      // Only cleanup if not already cleaned up by 'end' event
      if (this.connections.has(connId)) {
        tcpActiveConnections.dec();
        this.leaveRoom(conn);
        // Clean up reverse lookups
        if (conn.playerId) {
          this.connIdByPlayerId.delete(conn.playerId);
          this.raceIdByPlayerId.delete(conn.playerId);
        }
        this.connections.delete(connId);
      }
    });

    socket.on("error", (error) => {
      this.logger.error("TCP socket error", { connId, error: error.message });
      tcpActiveConnections.dec();
      tcpErrors.inc({ category: "socket" });
      this.leaveRoom(conn);
      // Clean up reverse lookups
      if (conn.playerId) {
        this.connIdByPlayerId.delete(conn.playerId);
        this.raceIdByPlayerId.delete(conn.playerId);
      }
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
              await this.hydrateConnectionPlayerContext(conn, { playerId, sessionKey });
              this.logger.info("Player associated with connection", {
                connId: conn.id,
                playerId,
                username: conn.username,
                teamId: conn.teamId || 0,
              });
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
          // Forward raw encrypted bytes to opponent - do NOT decrypt/re-encrypt
          for (const p of syncRace.players) {
            if (p.connId === conn.id) continue;
            const opponentConn = this.connections.get(p.connId);
            if (opponentConn && opponentConn.socket) {
              try {
                opponentConn.socket.write(
                  Buffer.from(conn._lastRaw + MESSAGE_DELIMITER, "latin1")
                );
                this.logger.info("TCP forwarded I/S packet", {
                  fromConnId: conn.id,
                  toConnId: opponentConn.id,
                  messageType,
                  raceId: syncRace.id
                });
              } catch (error) {
                this.logger.error("TCP I/S forward error", {
                  connId: conn.id,
                  opponentConnId: opponentConn.id,
                  error: error.message
                });
              }
            }
          }
        } else {
          this.logger.warn("TCP I/S packet received without active race", {
            connId: conn.id,
            playerId: conn.playerId,
            messageType
          });
        }
        // no ack - per protocol spec

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

      // --- Single-char client packets ---
      } else if (messageType.length === 1 && /^[A-Za-z0-9]$/.test(messageType)) {
        // 10.0.03 captures show standalone probes such as `H` before lobby and
        // `X`/`T` during race flow. The server does not answer them with `ac`
        // echoes or lobby bootstrap frames, so ignore them to avoid
        // contaminating the socket state machine.

      // --- LRCR2: Get room list ---
      } else if (messageType === "LRCR2") {
        const requestedStripId = Number(parts[2] || parts[1] || 0);
        this.sendMessage(conn,
          `"ac", "LRCR2", "d", "${this.escapeForTcp(this.buildLobbyRoomsXml(requestedStripId))}"`
        );
        this.logger.info("Sent LRCR2 room list", { connId: conn.id, stripId: requestedStripId });

      // --- JRC: Join room (create) ---
      } else if (messageType === "JRC") {
        const playerId = conn.playerId || 0;
        const username = conn.username || "Player";
        const roomId = this.resolveRoomIdForJoin(conn, parts);

        // Skip if player is not authenticated — SRC connections have no playerId
        if (!playerId) {
          this.logger.warn("TCP JRC ignored (no playerId)", { connId: conn.id });
          this.sendMessage(conn, '"ac", "JR", "s", 1');
          return;
        }

        this.leaveRoom(conn);
        conn.roomId = roomId;

        // Add player to room, removing any stale entries for this connId OR playerId
        const room = this.rooms.get(roomId) || [];
        const filtered = room.filter(p => p.connId !== conn.id && p.playerId !== playerId);
        filtered.push({
          connId: conn.id,
          playerId,
          username,
          carId: conn.carId || 0,
          teamId: Number(conn.teamId || 0),
          teamRole: conn.teamRole || "",
          clientRole: conn.clientRole || 5,
        });
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

        // 10.0.03 only acks the join here. The room snapshot follows after `GR`.
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

      // --- LR: Leave room ---
      } else if (messageType === "LR" && parts.length === 1) {
        this.logger.info("TCP LR (leave room) received", { connId: conn.id, roomId: conn.roomId });
        this.leaveRoom(conn);
        this.sendMessage(conn, '"ac", "LR", "s", 1');

      // --- GR: Get race (after JRC, triggers race announcement) ---
      } else if (messageType === "GR") {
        this.logger.info("TCP GR received", { connId: conn.id });
        const roomId = Number(conn.roomId || 0);
        const roomPlayers = this.rooms.get(roomId) || [];
        if (roomId > 0 && roomPlayers.some((player) => player.connId === conn.id)) {
          this.sendRoomSnapshot(conn, roomPlayers, { duplicateUsers: true });
        }

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

      // --- TE / CRC: Chat message in room / KOTH room creation ---
      } else if (messageType === "CRC" && this.handleKingOfHillRoomCreate(conn, parts)) {
        this.logger.info("TCP CRC handled as KOTH room create", { connId: conn.id, parts });
      } else if (messageType === "TE" || messageType === "CRC") {
        this.logger.info("TCP chat parts", { connId: conn.id, messageType, parts, partsCount: parts.length });
        this.broadcastChatMessage(conn, {
          messageType,
          chatText: this.extractChatText(messageType, parts),
        });

      // --- NIM: Instant message (private message) ---
      } else if (messageType === "NIM") {
        const targetPlayerId = Number(parts[1] || 0);
        const messageText = parts[2] || "";
        this.logger.info("TCP NIM received", { 
          connId: conn.id, 
          fromPlayerId: conn.playerId, 
          targetPlayerId, 
          messageText 
        });
        
        if (targetPlayerId && messageText && conn.playerId && conn.username) {
          // Find target player's connection
          const targetConn = this.findConnectionByPlayerId(targetPlayerId);
          if (targetConn) {
            // Send instant message to target with sender's username
            const chatClass = conn.clientRole === 1 ? 1 : (conn.clientRole === 8 ? 8 : (conn.clientRole === 2 ? 5 : DEFAULT_GLOBAL_CHAT_CLASS));
            const imMsg = `"ac", "NIM", "i", "${conn.playerId}", "u", "${this.escapeForTcp(conn.username)}", "t", "${this.escapeForTcp(messageText)}", "c", ${chatClass}`;
            this.sendMessage(targetConn, imMsg);
            // Ack to sender
            this.sendMessage(conn, '"ac", "NIM", "s", 1');
            this.logger.info("TCP NIM delivered", { 
              fromPlayerId: conn.playerId, 
              targetPlayerId 
            });
          } else {
            // Target not online
            this.sendMessage(conn, '"ac", "NIM", "s", 0');
            this.logger.info("TCP NIM failed (target offline)", { 
              fromPlayerId: conn.playerId, 
              targetPlayerId 
            });
          }
        } else {
          this.sendMessage(conn, '"ac", "NIM", "s", 0');
        }

      // --- SRC: Start Race Connection ---
      // The Flash client opens a *second* TCP connection for the actual race
      // data exchange. The first message on that connection is SRC carrying
      // the session key so we can associate it with the lobby connection.
      // Format observed: SRC \x1e <sessionKey> [\x1e <raceGuid>]
      } else if (messageType === "SRC") {
        const srcSessionKey = parts[1] || "";
        const srcRaceGuid   = parts[2] || "";
        
        // Validate session key format - should be alphanumeric, not chat text
        const isValidSessionKey = srcSessionKey && /^[a-zA-Z0-9_-]{8,}$/.test(srcSessionKey);
        
        if (!isValidSessionKey) {
          // Client is sending chat as SRC - treat it as a chat message
          this.broadcastChatMessage(conn, {
            messageType,
            chatText: srcSessionKey,
            logLabel: "TCP SRC chat received",
          });
          
          // Ack the message
          this.sendMessage(conn, '"ac", "SRC", "s", 1');
          return;
        }
        
        this.logger.info("TCP SRC received (race channel open)", {
          connId: conn.id,
          srcSessionKey,
          srcRaceGuid,
        });

        // Resolve the player from the session key (only if not already identified)
        if (this.supabase && srcSessionKey && !conn.playerId) {
          try {
            const playerId = await getSessionPlayerId({ supabase: this.supabase, sessionKey: srcSessionKey });
            if (playerId) {
              // Close any stale *race-channel* connection for the same player
              // before adopting this new race-channel socket. A race-channel
              // connection has `raceId` set. The lobby connection (no raceId)
              // must NOT be destroyed here.
              for (const [existingConnId, existingConn] of this.connections.entries()) {
                if (existingConnId !== conn.id &&
                    existingConn.playerId === playerId &&
                    existingConn.raceId) {
                  this.logger.info("SRC closing stale race connection for player", { staleConnId: existingConnId, playerId, newConnId: conn.id, staleRaceId: existingConn.raceId });
                  this.leaveRoom(existingConn);
                  existingConn.socket?.destroy();
                  this.connections.delete(existingConnId);
                  // Clean up reverse lookups for stale connection
                  if (this.connIdByPlayerId.get(playerId) === existingConnId) {
                    this.connIdByPlayerId.delete(playerId);
                  }
                  if (existingConn.raceId) {
                    this.raceIdByPlayerId.delete(playerId);
                  }
                }
              }
              conn.playerId = playerId;
              conn.sessionKey = srcSessionKey;
              // Set reverse lookup for O(1) player->connection mapping
              this.connIdByPlayerId.set(playerId, conn.id);
              
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
        } else if (!conn.playerId) {
          this.logger.warn("SRC received without valid session or existing player", { connId: conn.id, hasSessionKey: !!srcSessionKey, hasPlayerId: !!conn.playerId });
        }

        // Find the active race for this player (by GUID hint or by playerId)
        let srcRace = null;
        if (srcRaceGuid) {
          srcRace = this.races.get(srcRaceGuid) || this.pendingRaceChallenges.get(srcRaceGuid) || null;
        }
        if (!srcRace && conn.playerId) {
          // Use O(1) lookup if available, otherwise fall back to scan
          const cachedRaceId = this.raceIdByPlayerId.get(conn.playerId);
          if (cachedRaceId) {
            srcRace = this.races.get(cachedRaceId);
          }
          if (!srcRace) {
            for (const [, r] of this.races) {
              if (r.players.some(p => Number(p.playerId) === Number(conn.playerId))) {
                srcRace = r;
                break;
              }
            }
          }
        }

        if (srcRace) {
          // Attach this race-channel connection to the race
          conn.raceId = srcRace.id;
          
          // CRITICAL: Update the race player's connId to point to this race channel connection
          // The SRC connection is the RACE CHANNEL - all I/S packets flow through it
          const racePlayer = srcRace.players.find(p => Number(p.playerId) === Number(conn.playerId));
          if (racePlayer) {
            const oldConnId = racePlayer.connId;
            racePlayer.connId = conn.id;
            this.logger.info("TCP SRC race channel established", { 
              connId: conn.id,
              oldConnId,
              raceId: srcRace.id, 
              playerId: conn.playerId,
              playerLane: racePlayer.lane
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
          this.logger.info("TCP SRC race initialized", { 
            connId: conn.id, 
            raceId: srcRace.id,
            trackId: srcRace.trackId || 32,
            players: srcRace.players.map(p => ({ playerId: p.playerId, connId: p.connId, lane: p.lane }))
          });
        } else {
          // No active race yet — just ack so the client doesn't time out
          this.sendMessage(conn, '"ac", "SRC", "s", 1');
          this.logger.warn("TCP SRC ack sent (no active race found)", { 
            connId: conn.id,
            playerId: conn.playerId,
            srcRaceGuid
          });
        }

      // --- RRS: Race ready status ---
      } else if (messageType === "RRS") {
        this.handleRaceReady(conn, parts);

      // --- RO: Race open ---
      } else if (messageType === "RO") {
        this.handleRaceOpen(conn);

      // --- GK / JK: KOTH queue query / join ---
      } else if (messageType === "GK") {
        this.handleKingOfHillQueue(conn);
      } else if (messageType === "JK") {
        this.handleKingOfHillJoin(conn, parts);

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

  findRaceForConnection(conn) {
    // Fast path: use cached raceId on connection
    let race = conn.raceId ? this.races.get(conn.raceId) : null;
    
    // Fallback: use O(1) player->race lookup
    if (!race && conn.playerId) {
      const cachedRaceId = this.raceIdByPlayerId.get(conn.playerId);
      if (cachedRaceId) {
        race = this.races.get(cachedRaceId);
        if (race) {
          conn.raceId = cachedRaceId;
        }
      }
    }
    
    // Last resort: O(n) scan (should rarely happen now)
    if (!race && conn.playerId) {
      for (const [, candidate] of this.races) {
        if (candidate.players.some((player) => Number(player.playerId) === Number(conn.playerId))) {
          race = candidate;
          conn.raceId = candidate.id;
          this.raceIdByPlayerId.set(conn.playerId, candidate.id);
          break;
        }
      }
    }
    
    return race || null;
  }

  normalizeNumericToken(value, fallback = "0") {
    const token = String(value ?? "").trim();
    return token !== "" && Number.isFinite(Number(token)) ? token : String(fallback);
  }

  isRaceReadyForTelemetry(race) {
    return race.players.length === 2 && race.players.every((participant) => participant.raceConnId && participant.opened);
  }

  extractChatText(messageType, parts) {
    if (messageType === "CRC") {
      return parts.slice(1).find((part) => part.length > 1 && !/^\d+$/.test(part)) || "";
    }
    return parts[1] || "";
  }

  broadcastChatMessage(conn, { messageType, chatText, logLabel = "TCP chat received" }) {
    this.logger.info(logLabel, {
      connId: conn.id,
      messageType,
      chatText,
      username: conn.username,
      playerId: conn.playerId,
      roomId: conn.roomId,
      hasUsername: !!conn.username,
      hasPlayerId: !!conn.playerId,
    });

    if (!(chatText && conn.playerId && conn.username)) {
      this.logger.warn("Chat message rejected", {
        connId: conn.id,
        messageType,
        hasChatText: !!chatText,
        hasPlayerId: !!conn.playerId,
        hasUsername: !!conn.username,
      });
      return false;
    }

    if (conn.roomId) {
      const room = this.rooms.get(conn.roomId) || [];
      const chatClass = conn.clientRole === 1 ? 1 : (conn.clientRole === 8 ? 8 : (conn.clientRole === 2 ? 5 : DEFAULT_GLOBAL_CHAT_CLASS));
      const roomChatMsg =
        `"ac", "TE", "i", "${conn.playerId}", "u", "${this.escapeForTcp(conn.username)}", "t", "${this.escapeForTcp(chatText)}", "c", ${chatClass}`;
      this.logger.info("Broadcasting room chat", { connId: conn.id, roomId: conn.roomId, memberCount: room.length });
      for (const member of room) {
        const memberConn = this.connections.get(member.connId);
        if (memberConn) {
          this.sendMessage(memberConn, roomChatMsg);
        }
      }
      return true;
    }

    const chatClass = conn.clientRole === 1 ? 1 : (conn.clientRole === 8 ? 8 : (conn.clientRole === 2 ? 5 : DEFAULT_GLOBAL_CHAT_CLASS));

    const globalChatMsg =
      `"ac", "GC", "u", "${this.escapeForTcp(conn.username)}", "m", "${this.escapeForTcp(chatText)}", "c", ${chatClass}`;
    let recipientCount = 0;
    for (const [, otherConn] of this.connections) {
      if (otherConn.playerId && !otherConn.roomId) {
        this.sendMessage(otherConn, globalChatMsg);
        recipientCount += 1;
      }
    }
    this.logger.info("Broadcasting global chat", {
      connId: conn.id,
      recipientCount,
      chatClass,
    });
    return true;
  }

  handleRaceTelemetry(conn, messageType, parts) {
    const race = this.findRaceForConnection(conn);
    if (!race) {
      // Solo/test drive mode - client sends telemetry but no race exists
      // Silently ignore (no need to forward to opponent)
      return;
    }

    // Find sender by race channel connection ID
    const sender = race.players.find((participant) => participant.raceConnId === conn.id);
    if (!sender) {
      this.logger.warn("TCP telemetry rejected (connection not bound to race participant)", {
        connId: conn.id,
        raceId: race.id,
        playerId: conn.playerId,
        messageType,
        players: race.players.map(p => ({ playerId: p.playerId, connId: p.connId, raceConnId: p.raceConnId }))
      });
      return;
    }

    if (!this.isRaceReadyForTelemetry(race) || !race.sequenceStarted) {
      return;
    }

    // Update race activity timestamp
    race.lastActivity = Date.now();

    // Extract telemetry data - Flash client expects IO messages, not raw I/S
    // The client's RaceOpponent class processes IO messages to update opponent position
    const rawDistance = parts[1];
    const rawVelocity = parts[2];
    const rawAcceleration = parts[3];
    const rawTick = parts[4] || "0";
    
    // Normalize values but preserve original if valid
    const distance = this.normalizeNumericToken(rawDistance, "0");
    const velocity = this.normalizeNumericToken(rawVelocity, "0");
    const acceleration = this.normalizeNumericToken(rawAcceleration, "0");
    const tick = this.normalizeNumericToken(rawTick, "0");

    // Forward telemetry to opponent as IO message
    // This is what the Flash client's amLive.oppObj.raceOpp.getPos() expects
    const ioMessage =
      `"ac", "IO", "d", ${distance}, "v", ${velocity}, "a", ${acceleration}, "t", ${tick}`;

    for (const participant of race.players) {
      if (participant.raceConnId === conn.id) continue; // Skip sender
      const participantConn = this.connections.get(participant.raceConnId);
      if (participantConn && participantConn.socket && !participantConn.socket.destroyed) {
        try {
          this.sendMessage(participantConn, ioMessage);
          
          // Debug logging (can be disabled in production for performance)
          if (this.debugTelemetry) {
            this.logger.info("TCP forwarded telemetry as IO", {
              fromConnId: conn.id,
              toConnId: participantConn.id,
              messageType,
              raceId: race.id,
              distance,
              velocity
            });
          }
        } catch (error) {
          this.logger.error("TCP telemetry forward error", {
            connId: conn.id,
            opponentConnId: participantConn.id,
            raceId: race.id,
            error: error.message,
            stack: error.stack,
            socketDestroyed: participantConn.socket?.destroyed,
            socketWritable: participantConn.socket?.writable
          });
          tcpErrors.inc({ category: "telemetry_forward" });
        }
      } else {
        this.logger.warn("TCP opponent connection unavailable for telemetry", {
          connId: conn.id,
          opponentConnId: participant.raceConnId,
          raceId: race.id,
          socketExists: !!participantConn?.socket,
          socketDestroyed: participantConn?.socket?.destroyed
        });
      }
    }

    // Send periodic race state updates to keep connection alive
    // Only send if no recent telemetry to avoid interference
    if (!race.lastStateUpdate || Date.now() - race.lastStateUpdate > 5000) {
      race.lastStateUpdate = Date.now();
      for (const participant of race.players) {
        const participantConn = this.connections.get(participant.raceConnId);
        if (participantConn) {
          this.sendMessage(participantConn, '"ac", "RKA", "s", 1'); // Race Keep Alive
        }
      }
    }
  }

  handleRivalsReactionTime(conn, parts) {
    const race = this.findRaceForConnection(conn);
    if (!race || !conn.playerId) {
      this.logger.info("TCP RIVRT received without race", { connId: conn.id, parts });
      return;
    }

    const reactionTime = this.normalizeNumericToken(parts[1], 0);
    if (!race.reactionTimes) {
      race.reactionTimes = new Map();
    }
    race.reactionTimes.set(Number(conn.playerId), reactionTime);

    const racerIndex = Math.max(
      1,
      race.players.findIndex((player) => Number(player.playerId) === Number(conn.playerId)) + 1,
    );
    const rivalsMessage =
      `"ac", "RIVRT", "r", ${racerIndex}, "rt", ${reactionTime}, "i", ${Number(conn.playerId)}`;

    for (const participant of race.players) {
      const participantConn = this.connections.get(participant.raceConnId);
      if (!participantConn) continue;
      if (participant.raceConnId !== conn.id) {
        this.sendMessage(participantConn, `"ac", "RIVRTO", "rt", ${reactionTime}`);
      }
      this.sendMessage(participantConn, rivalsMessage);
    }
  }

  handleRaceMeta(conn, parts) {
    const race = this.findRaceForConnection(conn);
    if (!race || !conn.playerId) {
      this.logger.info("TCP M received without race", { connId: conn.id, parts });
      return;
    }

    if (!race.metaByPlayer) {
      race.metaByPlayer = new Map();
    }
    race.metaByPlayer.set(Number(conn.playerId), parts.slice(1));
  }

  handleKingOfHillRoomCreate(conn, parts) {
    const roomType = Number(parts[2] || 0);
    if (roomType !== 3 && roomType !== 6) {
      return false;
    }

    const roomId = roomType === 3 ? 3 : 4;
    const roomName = "User Room";
    this.leaveRoom(conn);
    conn.roomId = roomId;

    const roomPlayers = this.rooms.get(roomId) || [];
    const updatedPlayers = roomPlayers.filter((player) => Number(player.playerId) !== Number(conn.playerId));
    updatedPlayers.push({
      connId: conn.id,
      playerId: Number(conn.playerId || 0),
      username: conn.username || "Player",
      carId: Number(conn.carId || 0),
    });
    this.rooms.set(roomId, updatedPlayers);

    if (this.raceRoomRegistry && conn.playerId) {
      this.raceRoomRegistry.addPlayer(roomId, {
        id: Number(conn.playerId),
        publicId: getPublicIdForPlayer({ id: Number(conn.playerId) }),
        name: conn.username || "Player",
      });
    }

    const roomXml =
      `<rooms><r rc='1' cy='20' rt='${roomType}' cid='${roomId}' rn='${roomName}' ip='0' mo='0' sm='0' pro='0'/></rooms>`;
    this.sendMessage(conn, `"ac", "CRC", "s", 1, "d", "${roomXml}"`);
    this.sendMessage(conn, '"ac", "JR", "s", 1');
    return true;
  }

  handleKingOfHillQueue(conn) {
    const roomId = conn.roomId || 4;
    const roomPlayers = this.rooms.get(roomId) || [];
    
    // Filter players who have made a KOTH selection (are in queue)
    const queuedPlayers = [];
    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection) {
        queuedPlayers.push({
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
        });
      }
    }
    
    const queueXml = queuedPlayers.length > 0
      ? queuedPlayers.map(p => `<k i='${p.playerId}' ks='0' ci='${p.carId}'/>`).join("")
      : "<k i='0' ks='0' ci='0'/>";
    
    this.sendMessage(conn, `"ac", "KU", "s", "<q>${queueXml}</q>"`);
  }

  handleKingOfHillJoin(conn, parts) {
    const carId = Number(parts[1] || 0);
    const lane = Number(parts[2] || -1);
    
    conn.kingOfHillSelection = {
      carId,
      lane,
    };
    
    this.sendMessage(conn, '"ac", "UNU", "i", 1, "s", 1, "ul", ""');
    
    // Try to match with another player in the KOTH queue
    const roomId = conn.roomId || 4;
    const roomPlayers = this.rooms.get(roomId) || [];
    
    // Find all players in queue (excluding current player)
    const waitingPlayers = [];
    for (const player of roomPlayers) {
      if (player.connId === conn.id) continue;
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection && !playerConn.raceId) {
        waitingPlayers.push({
          conn: playerConn,
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
          lane: playerConn.kingOfHillSelection.lane,
        });
      }
    }
    
    // If there's at least one waiting player, match them
    if (waitingPlayers.length > 0 && !conn.raceId) {
      const opponent = waitingPlayers[0];
      
      this.logger.info("KOTH match found", {
        player1: { connId: conn.id, playerId: conn.playerId, carId },
        player2: { connId: opponent.conn.id, playerId: opponent.playerId, carId: opponent.carId },
      });
      
      // Create race request for player 1
      const request1 = {
        connId: conn.id,
        requesterPlayerId: Number(conn.playerId),
        requesterCarId: carId,
        roomId,
        lane: lane >= 0 ? lane : 0,
        bet: 0,
      };
      
      // Create race request for player 2
      const request2 = {
        connId: opponent.conn.id,
        requesterPlayerId: Number(opponent.playerId),
        requesterCarId: opponent.carId,
        roomId,
        lane: opponent.lane >= 0 ? opponent.lane : 1,
        bet: 0,
      };
      
      // Clear their KOTH selections
      delete conn.kingOfHillSelection;
      delete opponent.conn.kingOfHillSelection;
      
      // Create the race session
      this.createRaceSession(request1, request2);
      
      // Broadcast updated queue to room
      this.broadcastKothQueueUpdate(roomId);
    } else {
      // Broadcast updated queue to show this player joined
      this.broadcastKothQueueUpdate(roomId);
    }
  }
  
  broadcastKothQueueUpdate(roomId) {
    const roomPlayers = this.rooms.get(roomId) || [];
    const queuedPlayers = [];
    
    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection) {
        queuedPlayers.push({
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
        });
      }
    }
    
    const queueXml = queuedPlayers.length > 0
      ? queuedPlayers.map(p => `<k i='${p.playerId}' ks='0' ci='${p.carId}'/>`).join("")
      : "<k i='0' ks='0' ci='0'/>";
    
    const queueMessage = `"ac", "LR", "s", "<q>${queueXml}</q>"`;
    
    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn) {
        this.sendMessage(playerConn, queueMessage);
      }
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
    const roomId = Number(conn.roomId);
    const roomType = this.getRoomDefinition(roomId)?.type || "";
    const hadKothSelection = Boolean(conn.kingOfHillSelection);
    const room = this.rooms.get(roomId) || [];
    const updated = room.filter(p => p.connId !== conn.id);
    this.rooms.set(roomId, updated);

    if (this.raceRoomRegistry && conn.playerId) {
      this.raceRoomRegistry.removePlayer(roomId, Number(conn.playerId));
    }

    delete conn.kingOfHillSelection;

    // Notify remaining players
    if (updated.length > 0) {
      for (const member of updated) {
        const otherConn = this.connections.get(member.connId);
        if (otherConn) this.sendRoomUsers(otherConn, updated);
      }
    }
    if (this.isKingOfTheHillRoomType(roomType)) {
      this.broadcastKothQueueUpdate(roomId);
    }
    this.logger.info("Player left room", { connId: conn.id, roomId, remaining: updated.length, hadKothSelection });
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
        stripId: Number(room.stripId ?? fallback.stripId ?? room.roomId ?? fallback.id ?? 0),
        players: room.players || [],
      };
    });
  }

  getRoomDefinition(roomId) {
    return this.getRoomDefinitions().find((room) => Number(room.roomId) === Number(roomId)) || null;
  }

  buildLobbyRoomsXml(stripId = 0) {
    const allRooms = this.getRoomDefinitions();
    const rooms = stripId > 0
      ? allRooms.filter((room) => (room.stripId ?? room.roomId) === stripId)
      : allRooms;
    const roomsXml = rooms.map((room) => {
      const tcpPlayerCount = this.rooms.get(room.roomId)?.length ?? 0;
      const activePlayers = tcpPlayerCount > 0 ? tcpPlayerCount : (room.players.length ?? 0);
      const pi = room.stripId ?? room.roomId;
      return (
        `<r rc='${activePlayers}' cy='${room.maxPlayers}' rt='${room.tcpRoomType}' ` +
        `cid='${room.roomId}' pi='${pi}' rn='${this.escapeXml(room.name)}' ip='0' mo='0' sm='${room.systemMessages}' pro='0'/>`
      );
    }).join("");
    return `<rooms>${roomsXml}</rooms>`;
  }

  buildRoomQueueXml(roomPlayers, roomId = null) {
    const roomType = this.getRoomDefinition(roomId)?.type || "";

    // Team Rivals room snapshots should start empty until actual challenge
    // records are pushed; generic 1v1 rows confuse the Team Rivals room movie.
    if (roomType === "team") {
      const roomState = this.raceRoomRegistry?.get(roomId);
      if (roomState?.teamRivalsQueueXml) {
        return String(roomState.teamRivalsQueueXml);
      }
      return "<q></q>";
    }

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
    const usersXml = roomPlayers
      .filter((player) => Number(player.playerId || 0) > 0 && player.username)
      .map((player) => {
      let color = "7D7D7D"; // Default user grey
      if (player.clientRole === 1) color = "FF0000"; // Admin
      else if (player.clientRole === 2) color = "66CCFF"; // Mod
      else if (player.clientRole === 8) color = "0000FF"; // Senior Mod
      else if (player.clientRole === 6) color = "00AA00"; // Team Member Green
      
      return `<u i='${player.playerId}' un='${this.escapeXml(player.username)}' ti='${Number(player.teamId || 0)}' tid='${Number(player.teamId || 0)}' tf='${color}' ms='5' iv='0'/>`;
    }).join("");
    return `<ul>${usersXml}</ul>`;
  }

  isKingOfTheHillRoomType(roomType) {
    return roomType === "bracket_koth" || roomType === "h2h_koth";
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

  handleKingOfHillRoomCreate(conn, parts) {
    const roomType = Number(parts[2] || 0);
    if (roomType !== 3 && roomType !== 6) {
      return false;
    }

    const roomId = roomType === 3 ? 3 : 4;
    const roomName = "User Room";
    this.leaveRoom(conn);
    conn.roomId = roomId;

    const roomPlayers = this.rooms.get(roomId) || [];
    const updatedPlayers = roomPlayers.filter((player) => Number(player.playerId) !== Number(conn.playerId));
    updatedPlayers.push({
      connId: conn.id,
      playerId: Number(conn.playerId || 0),
      username: conn.username || "Player",
      carId: Number(conn.carId || 0),
      teamId: Number(conn.teamId || 0),
      teamRole: conn.teamRole || "",
      clientRole: conn.clientRole || 5,
    });
    this.rooms.set(roomId, updatedPlayers);

    if (this.raceRoomRegistry && conn.playerId) {
      this.raceRoomRegistry.addPlayer(roomId, {
        id: Number(conn.playerId),
        publicId: getPublicIdForPlayer({ id: Number(conn.playerId) }),
        name: conn.username || "Player",
      });
    }

    const roomXml =
      `<rooms><r rc='1' cy='20' rt='${roomType}' cid='${roomId}' rn='${roomName}' ip='0' mo='0' sm='0' pro='0'/></rooms>`;
    this.sendMessage(conn, `"ac", "CRC", "s", 1, "d", "${roomXml}"`);
    this.sendMessage(conn, '"ac", "JR", "s", 1');
    return true;
  }

  handleKingOfHillQueue(conn) {
    const roomId = conn.roomId || 4;
    const roomPlayers = this.rooms.get(roomId) || [];
    const queuedPlayers = [];

    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection) {
        queuedPlayers.push({
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
        });
      }
    }

    const queueXml = queuedPlayers.length > 0
      ? queuedPlayers.map((player) => `<k i='${player.playerId}' ks='0' ci='${player.carId}'/>`).join("")
      : "<k i='0' ks='0' ci='0'/>";

    this.sendMessage(conn, `"ac", "KU", "s", "<q>${queueXml}</q>"`);
  }

  handleKingOfHillJoin(conn, parts) {
    const carId = Number(parts[1] || 0);
    const lane = Number(parts[2] || -1);

    conn.kingOfHillSelection = {
      carId,
      lane,
    };

    this.sendMessage(conn, '"ac", "UNU", "i", 1, "s", 1, "ul", ""');

    const roomId = conn.roomId || 4;
    const roomPlayers = this.rooms.get(roomId) || [];
    const waitingPlayers = [];

    for (const player of roomPlayers) {
      if (player.connId === conn.id) continue;
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection && !playerConn.raceId) {
        waitingPlayers.push({
          conn: playerConn,
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
          lane: playerConn.kingOfHillSelection.lane,
        });
      }
    }

    if (waitingPlayers.length > 0 && !conn.raceId) {
      const opponent = waitingPlayers[0];

      this.logger.info("KOTH match found", {
        player1: { connId: conn.id, playerId: conn.playerId, carId },
        player2: { connId: opponent.conn.id, playerId: opponent.playerId, carId: opponent.carId },
      });

      const request1 = {
        connId: conn.id,
        requesterPlayerId: Number(conn.playerId),
        requesterCarId: carId,
        roomId,
        lane: lane >= 0 ? lane : 0,
        bet: 0,
      };
      const request2 = {
        connId: opponent.conn.id,
        requesterPlayerId: Number(opponent.playerId),
        requesterCarId: opponent.carId,
        roomId,
        lane: opponent.lane >= 0 ? opponent.lane : 1,
        bet: 0,
      };

      delete conn.kingOfHillSelection;
      delete opponent.conn.kingOfHillSelection;

      this.createRaceSession(request1, request2);
      this.broadcastKothQueueUpdate(roomId);
      return;
    }

    this.broadcastKothQueueUpdate(roomId);
  }

  broadcastKothQueueUpdate(roomId) {
    const roomPlayers = this.rooms.get(roomId) || [];
    const queuedPlayers = [];

    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn?.kingOfHillSelection) {
        queuedPlayers.push({
          playerId: player.playerId,
          carId: playerConn.kingOfHillSelection.carId,
        });
      }
    }

    const queueXml = queuedPlayers.length > 0
      ? queuedPlayers.map((player) => `<k i='${player.playerId}' ks='0' ci='${player.carId}'/>`).join("")
      : "<k i='0' ks='0' ci='0'/>";
    const queueMessage = `"ac", "LR", "s", "<q>${queueXml}</q>"`;

    for (const player of roomPlayers) {
      const playerConn = this.connections.get(player.connId);
      if (playerConn) {
        this.sendMessage(playerConn, queueMessage);
      }
    }
  }

  async hydrateConnectionPlayerContext(conn, { playerId, sessionKey = conn.sessionKey } = {}) {
    if (!this.supabase || !playerId) {
      return;
    }

    const numericPlayerId = Number(playerId);
    let playerResult = await this.supabase
      .from("game_players")
      .select("username, default_car_game_id, team_id, role")
      .eq("id", numericPlayerId)
      .maybeSingle();

    if (playerResult.error) {
      const msg = String(playerResult.error?.message || "");
      if (/role/i.test(msg) && /does not exist|unknown column|column/i.test(msg)) {
        // schema doesn't have role column — retry without it
        playerResult = await this.supabase
          .from("game_players")
          .select("username, default_car_game_id, team_id")
          .eq("id", numericPlayerId)
          .maybeSingle();
        if (playerResult.error) {
          throw playerResult.error;
        }
      } else {
        throw playerResult.error;
      }
    }

    const player = playerResult.data;
    let teamMember = null;

    const teamWithRoleResult = await this.supabase
      .from("game_team_members")
      .select("team_id, role")
      .eq("player_id", numericPlayerId)
      .maybeSingle();

    if (teamWithRoleResult.error) {
      const message = String(teamWithRoleResult.error?.message || "");
      if (/role/i.test(message) && /does not exist|unknown column|column/i.test(message)) {
        const compatTeamResult = await this.supabase
          .from("game_team_members")
          .select("team_id")
          .eq("player_id", numericPlayerId)
          .maybeSingle();
        if (compatTeamResult.error) {
          throw compatTeamResult.error;
        }
        teamMember = compatTeamResult.data
          ? { team_id: compatTeamResult.data.team_id, role: "" }
          : null;
      } else {
        throw teamWithRoleResult.error;
      }
    } else {
      teamMember = teamWithRoleResult.data;
    }

    conn.playerId = numericPlayerId;
    conn.sessionKey = sessionKey;
    conn.username = player?.username || "Player";
    conn.carId = Number(player?.default_car_game_id || 0);
    conn.teamId = Number(teamMember?.team_id || player?.team_id || 0);
    conn.teamRole = teamMember?.role || "";
    conn.clientRole = getClientRoleForPlayer(player);
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

    // Use excludeRaceChannels to get the lobby connection for the target
    const targetConn = this.findConnectionByPlayerId(targetPlayerId, true);
    if (!targetConn) {
      this.logger.warn("TCP RRQ ignored (target not connected)", {
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

    this.logger.info("TCP RRQ challenge created", {
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
    
    this.logger.info("TCP RRQ challenge sent to target", {
      targetConnId: targetConn.id,
      targetPlayerId,
      raceGuid
    });
  }

  findConnectionByPlayerId(playerId, excludeRaceChannels = false) {
    if (!playerId) return null;
    const matches = [];
    for (const [, candidate] of this.connections) {
      if (Number(candidate.playerId || 0) === Number(playerId)) {
        matches.push(candidate);
      }
    }
    
    if (matches.length === 0) return null;
    
    // If we have multiple connections for the same player, prefer the lobby connection
    // (the one that has roomId set) unless we specifically want the race channel
    if (matches.length === 1) return matches[0];
    
    if (excludeRaceChannels) {
      // Return the connection that has a roomId (lobby connection)
      const lobbyConn = matches.find(c => c.roomId);
      return lobbyConn || matches[0];
    }
    
    // Return the most recent connection
    return matches[matches.length - 1];
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

  buildRraXml({ challengerPlayerId, challengerCarId, challengedPlayerId, challengedCarId, trackId, sc1 = 0, sc2 = 0 }) {
    return (
      `<r r1id='${Number(challengerPlayerId)}' r2id='${Number(challengedPlayerId)}' ` +
      `r1cid='${Number(challengerCarId)}' r2cid='${Number(challengedCarId)}' ` +
      `b1='-1' b2='-1' bt='0' sc1='${Number(sc1)}' sc2='${Number(sc2)}' t='${Number(trackId)}'/>`
    );
  }

  async createRaceSession(requestA, requestB) {
    const connA = this.connections.get(requestA.connId);
    const connB = this.connections.get(requestB.connId);
    if (!connA || !connB) {
      this.logger.warn("Race session aborted due to missing connection", {
        requestAConnId: requestA.connId,
        requestBConnId: requestB.connId,
      });
      return;
    }

    // Fetch SC for both players
    let scA = 0, scB = 0;
    if (this.supabase) {
      try {
        const [resA, resB] = await Promise.all([
          this.supabase.from("game_players").select("score").eq("id", requestA.requesterPlayerId).maybeSingle(),
          this.supabase.from("game_players").select("score").eq("id", requestB.requesterPlayerId).maybeSingle(),
        ]);
        scA = Number(resA.data?.score ?? 0);
        scB = Number(resB.data?.score ?? 0);
      } catch (err) {
        this.logger.warn("Failed to fetch SC for race session", { error: err.message });
      }
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
          sc: scA,
          ready: false,
          opened: false,
        },
        {
          connId: requestB.connId,
          playerId: requestB.requesterPlayerId,
          carId: requestB.requesterCarId,
          lane: requestB.lane,
          bet: requestB.bet,
          sc: scB,
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
      // Find player by playerId (not connId) since this might be the lobby connection
      const player = existingRace.players.find((entry) => Number(entry.playerId) === Number(conn.playerId));
      if (!player) {
        this.logger.warn("TCP RRS received from unknown race player", { 
          connId: conn.id, 
          playerId: conn.playerId,
          raceId: existingRace.id,
          racePlayers: existingRace.players.map(p => ({ playerId: p.playerId, connId: p.connId }))
        });
        return;
      }

      player.ready = true;
      this.sendMessage(conn, `"ac", "RRS", "s", 1, "i", "${existingRace.id}"`);
      this.logger.info("TCP RRS received", {
        connId: conn.id,
        playerId: conn.playerId,
        raceId: existingRace.id,
        readyCount: existingRace.players.filter((entry) => entry.ready).length,
        totalPlayers: existingRace.players.length
      });

      if (!existingRace.announced && existingRace.players.every((entry) => entry.ready)) {
        existingRace.announced = true;
        this.logger.info("TCP race starting - both players ready", { 
          raceId: existingRace.id,
          players: existingRace.players.map(p => ({ playerId: p.playerId, ready: p.ready }))
        });
        
        for (const participant of existingRace.players) {
          // Use the lobby connection for these messages (not race channel yet)
          const participantConn = this.findConnectionByPlayerId(participant.playerId);
          if (!participantConn) {
            this.logger.warn("TCP RRS cannot find connection for player", {
              playerId: participant.playerId,
              raceId: existingRace.id
            });
            continue;
          }
          
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
                trackId: existingRace.trackId || 32,
              })
            )}"`
          );
          // Fallback: if the client doesn't emit RO, bootstrap the track anyway.
          this.sendMessage(participantConn, `"ac", "RO", "t", ${existingRace.trackId || 32}`);
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

    // Award SC based on race result
    // parts[1] = winner player ID (sent by client in RR message)
    const winnerPlayerId = Number(parts[1] || 0);
    const SC_WIN = 50;
    const SC_LOSS = 10;

    if (winnerPlayerId && this.supabase && !race.scAwarded) {
      race.scAwarded = true;

      for (const participant of race.players) {
        const isWinner = Number(participant.playerId) === winnerPlayerId;
        const scGain = isWinner ? SC_WIN : SC_LOSS;
        const currentSc = Number(participant.sc ?? 0);

        // Fetch current wins/losses then increment
        this.supabase
          .from("game_players")
          .select("wins, losses")
          .eq("id", participant.playerId)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error || !data) return;
            return this.supabase.from("game_players").update({
              score: currentSc + scGain,
              wins: (data.wins ?? 0) + (isWinner ? 1 : 0),
              losses: (data.losses ?? 0) + (isWinner ? 0 : 1),
            }).eq("id", participant.playerId);
          })
          .then((res) => {
            if (res?.error) this.logger.warn("Failed to update SC/wins/losses", { playerId: participant.playerId, error: res.error.message });
          });
      }

      this.logger.info("TCP RR SC awarded", {
        raceId: race.id,
        winnerPlayerId,
        scWin: SC_WIN,
        scLoss: SC_LOSS,
      });
    }

    this.sendMessage(conn, '"ac", "RR", "s", 1');

    // Build and broadcast the race result XML to both players
    // Format from decompiled Flash: <r wid='' r1id='' r2id='' rt1='' et1='' ts1='' rt2='' et2='' ts2='' c1='' c2='' h1='0' h2='0' td='0'/>
    if (race) {
      const [p1, p2] = race.players;
      const sc1Gain = winnerPlayerId && Number(p1.playerId) === winnerPlayerId ? SC_WIN : SC_LOSS;
      const sc2Gain = winnerPlayerId && Number(p2.playerId) === winnerPlayerId ? SC_WIN : SC_LOSS;
      const resultXml = `<r wid='${winnerPlayerId || 0}' r1id='${p1.playerId}' r2id='${p2.playerId}' rt1='-1' et1='-1' ts1='-1' rt2='-1' et2='-1' ts2='-1' c1='${sc1Gain}' c2='${sc2Gain}' h1='0' h2='0' td='0'/>`;
      const escapedXml = this.escapeForTcp(resultXml);
      for (const participant of race.players) {
        const participantConn = this.connections.get(participant.connId) || this.connections.get(participant.raceConnId);
        if (participantConn) {
          this.sendMessage(participantConn, `"ac", "UR", "d", "${escapedXml}"`);
          this.sendMessage(participantConn, '"ac", "OR", "s", 1');
        }
      }
    } else {
      this.sendMessage(conn, '"ac", "UR", "s", 1');
      this.sendMessage(conn, '"ac", "OR", "s", 1');
    }
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
    const sc1 = playerOne.sc ?? 0;
    const sc2 = playerTwo.sc ?? 0;
    return `"ac", "RRA", "d", "<r r1id='${playerOne.playerId}' r2id='${playerTwo.playerId}' r1cid='${playerOne.carId}' r2cid='${playerTwo.carId}' b1='-1' b2='-1' bt='0' sc1='${sc1}' sc2='${sc2}' t='32'/>"`;
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
      tcpErrors.inc({ category: "send" });
    }
  }

  /**
   * Send a message to a single player by their playerId.
   * Returns true if the message was sent, false if the player was not found.
   */
  sendToPlayer(playerId, message) {
    const conn = this.findConnectionByPlayerId(playerId);
    if (!conn) return false;
    this.sendMessage(conn, message);
    return true;
  }

  /**
   * Send a batch of messages to multiple players in a single write per player.
   * Each message is encrypted individually, then the frames are concatenated
   * into one buffer per socket so the kernel sends them in a single TCP segment.
   */
  broadcastToPlayers(playerIds, messages) {
    const msgList = Array.isArray(messages) ? messages : [messages];
    let sent = 0;

    for (const playerId of playerIds) {
      const conn = this.findConnectionByPlayerId(playerId);
      if (!conn) continue;

      try {
        const frames = msgList.map((msg) => {
          const seed = Math.floor(Math.random() * 90) + 10;
          return encryptPayload(msg, seed) + MESSAGE_DELIMITER;
        });
        const combined = Buffer.from(frames.join(""), "latin1");
        conn.socket.write(combined);
        sent++;
        this.logger.info("TCP batch sent", {
          connId: conn.id,
          playerId,
          messageCount: msgList.length,
          bytes: combined.length,
        });
      } catch (error) {
        this.logger.error("TCP batch send error", { connId: conn.id, playerId, error: error.message });
      }
    }

    return sent;
  }

  cleanupStaleState() {
    const now = Date.now();
    const challengeTtl = 2 * 60 * 1000;   // 2 minutes
    const raceTtl      = 10 * 60 * 1000;  // 10 minutes

    // --- Pending race challenges ---
    let cleanedChallenges = 0;
    for (const [guid, challenge] of this.pendingRaceChallenges.entries()) {
      if (now - challenge.createdAt > challengeTtl) {
        this.pendingRaceChallenges.delete(guid);
        cleanedChallenges++;
      }
    }

    // --- Active races that have gone stale (both players likely disconnected) ---
    let cleanedRaces = 0;
    const emptyRaceGraceMs = 2 * 60 * 1000; // 2 minutes reconnect grace
    const raceTimeoutMs = 3 * 60 * 1000; // 3 minutes for active race timeout
    
    for (const [raceId, race] of this.races.entries()) {
      let shouldCleanup = false;
      let reason = '';
      
      // Races that were emptied get a shorter grace period for reconnects
      if (race.emptiedAt && now - race.emptiedAt > emptyRaceGraceMs) {
        shouldCleanup = true;
        reason = 'empty race grace period expired';
      }
      // Races that were never emptied get the full TTL
      else if (!race.emptiedAt && now - race.createdAt > raceTtl) {
        shouldCleanup = true;
        reason = 'race TTL expired';
      }
      // Active races that have timed out due to inactivity
      else if (race.lastActivity && now - race.lastActivity > raceTimeoutMs) {
        shouldCleanup = true;
        reason = 'race activity timeout';
        
        // Send timeout messages to remaining players before cleanup
        for (const participant of race.players) {
          const participantConn = this.connections.get(participant.connId);
          if (participantConn) {
            this.sendMessage(participantConn, '"ac", "RTO", "s", 1'); // Race Timeout
            this.sendMessage(participantConn, '"ac", "RR", "s", 1');
            this.sendMessage(participantConn, '"ac", "UR", "s", 1');
            this.sendMessage(participantConn, '"ac", "OR", "s", 1');
            participantConn.raceId = null;
          }
        }
      }
      
      if (shouldCleanup) {
        this.logger.info("Cleaning up race", { raceId, reason });
        
        // Clean up reverse lookups for all players in this race
        for (const player of race.players) {
          if (player.playerId && this.raceIdByPlayerId.get(player.playerId) === raceId) {
            this.raceIdByPlayerId.delete(player.playerId);
          }
        }
        this.races.delete(raceId);
        this.raceCompletions.delete(raceId);
        cleanedRaces++;
      }
    }

    // --- Room members whose TCP connection is no longer alive ---
    let cleanedMembers = 0;
    for (const [roomId, members] of this.rooms.entries()) {
      const live = members.filter((m) => this.connections.has(m.connId));
      if (live.length !== members.length) {
        const dead = members.filter((m) => !this.connections.has(m.connId));
        cleanedMembers += dead.length;
        this.rooms.set(roomId, live);

        // Sync removals to the authoritative registry
        if (this.raceRoomRegistry) {
          for (const m of dead) {
            if (m.playerId) this.raceRoomRegistry.removePlayer(roomId, Number(m.playerId));
          }
        }

        // Notify surviving members of the updated roster
        for (const m of live) {
          const mc = this.connections.get(m.connId);
          if (mc) this.sendRoomUsers(mc, live);
        }
      }
    }

    if (cleanedChallenges > 0 || cleanedRaces > 0 || cleanedMembers > 0) {
      cleanupEvictionsTotal.inc({ type: "challenges" }, cleanedChallenges);
      cleanupEvictionsTotal.inc({ type: "races" }, cleanedRaces);
      cleanupEvictionsTotal.inc({ type: "room_members" }, cleanedMembers);
      tcpActiveRaces.set({}, this.races.size);
      tcpPendingChallenges.set({}, this.pendingRaceChallenges.size);
      this.logger.info("TCP stale state cleaned up", {
        challenges: cleanedChallenges,
        races: cleanedRaces,
        roomMembers: cleanedMembers,
      });
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
