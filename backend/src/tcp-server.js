import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { handleGameAction } from "./game-actions.js";
import { decodePayload, encryptPayload } from "./nitto-cipher.js";
import { advanceEngineConditionForCars } from "./engine-state.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { getClientRoleForPlayer } from "./player-role.js";
import { ensureDefaultRaceRooms, getDefaultRaceRoom } from "./race-room-catalog.js";
import { getSessionPlayerId } from "./session.js";
import {
  applyPlayerRaceResult,
  getPlayerById,
  getTeamMembershipByPlayerId,
  listPlayersByIds,
} from "./user-service.js";
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
const RACE_STAGE_SETTLE_MS = 750;

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
      this.cleanupConnection(conn);
    });

    socket.on("close", () => {
      this.logger.info("TCP connection closed", { connId, remoteAddr });
      this.cleanupConnection(conn);
    });

    socket.on("error", (error) => {
      this.logger.error("TCP socket error", { connId, error: error.message });
      this.cleanupConnection(conn, { countSocketError: true });
    });
  }

  cleanupConnection(conn, { countSocketError = false } = {}) {
    if (!conn || !this.connections.has(conn.id)) {
      return;
    }

    tcpActiveConnections.dec();
    if (countSocketError) {
      tcpErrors.inc({ category: "socket" });
    }

    this.leaveRoom(conn);
    if (conn.playerId) {
      const siblingConn = [...this.connections.values()].find(
        (candidate) => candidate.id !== conn.id && Number(candidate.playerId || 0) === Number(conn.playerId),
      );
      if (siblingConn) {
        if (this.connIdByPlayerId.get(conn.playerId) === conn.id) {
          this.connIdByPlayerId.set(conn.playerId, siblingConn.id);
        }
      } else {
        this.connIdByPlayerId.delete(conn.playerId);
        this.raceIdByPlayerId.delete(conn.playerId);
      }
    }
    this.connections.delete(conn.id);
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

      // --- S / I: In-race position sync --- sanitize and relay to opponent, don't ack
      } else if (messageType === "S" || messageType === "I") {
        this.handleRaceTelemetry(conn, messageType, parts);
        // no ack - per protocol spec

      // --- RD: Race done / result data ---
      } else if (messageType === "RD") {
        this.logger.info("TCP RD received", { connId: conn.id, parts: parts.length });
        
        // Apply engine wear even if race is missing (per protocol spec)
        const race = conn.raceId ? this.races.get(conn.raceId) : null;
        const playerId = Number(conn.playerId || 0);
        
        if (race) {
          const participant = this.findRaceParticipant(race, conn, { bindRaceConn: true });
          if (participant) {
            if (!race.finishResults) {
              race.finishResults = new Map();
            }
            race.finishResults.set(Number(participant.playerId), this.parseRaceDoneMetrics(parts));
            this.broadcastRaceDone(race, participant.playerId);
          }
          const completionPlayerId = Number(participant?.playerId || playerId || 0);

          // Track completion for cleanup
          if (!this.raceCompletions.has(race.id)) {
            this.raceCompletions.set(race.id, new Set());
          }
          if (completionPlayerId > 0) {
            this.raceCompletions.get(race.id).add(completionPlayerId);
          } else {
            this.logger.warn("TCP RD missing completion player id", {
              connId: conn.id,
              raceId: race.id,
              connPlayerId: conn.playerId,
            });
          }
          
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
            const computedWinnerPlayerId = this.determineRaceWinnerFromResults(race);
            this.logger.info("TCP RD winner resolution", {
              raceId: race.id,
              reportedWinnerPlayerId: race.reportedWinnerPlayerId || 0,
              computedWinnerPlayerId,
            });
            this.tryBroadcastRaceResult(
              race,
              computedWinnerPlayerId,
            );
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
        this.sendRoomSnapshot(conn, filtered);

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
          this.sendRoomSnapshot(conn, roomPlayers);
        }

      // --- TC: Team / title channel selection ---
      } else if (messageType === "TC") {
        this.logger.info("TCP TC received", {
          connId: conn.id,
          channelName: parts[1] || "",
        });
        this.sendMessage(conn, '"ac", "TC", "s", 1');

      // --- TEAMCREATE: Legacy Director team create command ---
      } else if (messageType === "TEAMCREATE") {
        await this.handleLegacyTeamCreate(conn, parts);

      // --- RRQ: Live race request / matchmaking handshake ---
      } else if (messageType === "RRQ") {
        this.handleRaceRequest(conn, parts);

      // --- RRSP: Rivals challenge response (accept/decline) ---
      } else if (messageType === "RRSP") {
        this.handleRaceResponse(conn, parts);

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
            // Ack to sender with target ID so sendNimCB can update the conversation
            this.sendMessage(conn, `"ac", "NIM", "s", 1, "rid", "${targetPlayerId}"`);
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
              // before adopting this new race-channel socket. The lobby
              // connection stays bound to a room, so only destroy sockets that
              // are race-only channels.
              for (const [existingConnId, existingConn] of this.connections.entries()) {
                const isExistingRaceChannel = Boolean(existingConn.raceId) && !existingConn.roomId;
                if (existingConnId !== conn.id &&
                    existingConn.playerId === playerId &&
                    isExistingRaceChannel) {
                  this.logger.info("SRC closing stale race connection for player", { staleConnId: existingConnId, playerId, newConnId: conn.id, staleRaceId: existingConn.raceId });
                  this.leaveRoom(existingConn);
                  existingConn.socket?.destroy();
                  this.connections.delete(existingConnId);
                  // Clean up reverse lookups for stale connection
                  if (this.connIdByPlayerId.get(playerId) === existingConnId) {
                    this.connIdByPlayerId.delete(playerId);
                  }
                }
              }
              conn.playerId = playerId;
              conn.sessionKey = srcSessionKey;
              // Set reverse lookup for O(1) player->connection mapping
              this.connIdByPlayerId.set(playerId, conn.id);

              const player = await getPlayerById(this.supabase, playerId);
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
          
          // Keep connId bound to the lobby socket. RR/RD and room messages
          // still flow through the lobby connection; telemetry uses raceConnId.
          const racePlayer = srcRace.players.find(p => Number(p.playerId) === Number(conn.playerId));
          if (racePlayer) {
            const oldRaceConnId = racePlayer.raceConnId || null;
            const isRaceChannelReconnect = Boolean(oldRaceConnId && oldRaceConnId !== conn.id);
            racePlayer.raceConnId = conn.id;
            this.raceIdByPlayerId.set(conn.playerId, srcRace.id);
            this.logger.info("TCP SRC race channel established", { 
              connId: conn.id,
              lobbyConnId: racePlayer.connId,
              oldRaceConnId,
              raceId: srcRace.id, 
              playerId: conn.playerId,
              playerLane: racePlayer.lane
            });

            if (isRaceChannelReconnect) {
              srcRace.sequenceStarted = false;
              srcRace.rivalsReadyBroadcasted = false;
              srcRace.stagedCount = 0;
              srcRace.metaByPlayer = new Map();
              srcRace.rivalsReadyAcks = new Map();
              srcRace.reactionTimes = new Map();
              for (const participant of srcRace.players) {
                participant.opened = false;
              }
              this.setRacePhase(srcRace, "LOADED", "race-channel-reconnected");
              this.logger.info("TCP race handshake reset after race channel reconnect", {
                raceId: srcRace.id,
                playerId: conn.playerId,
                oldRaceConnId,
                newRaceConnId: conn.id,
              });
            }
          }
          
          const [p1, p2] = srcRace.players;
          if (!p1 || !p2) {
            // Race not fully populated yet — ack and wait
            this.sendMessage(conn, '"ac", "SRC", "s", 1');
            this.logger.warn("TCP SRC ack sent (race not fully populated)", {
              connId: conn.id,
              raceId: srcRace.id,
              playerCount: srcRace.players.length,
            });
            return;
          }
          // Acknowledge the race channel only. The client opens the tree
          // sequence with a later RO message; sending RO/IO early leaves both
          // racers stuck staged.
          this.sendMessage(conn, '"ac", "SRC", "s", 1');
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

      // --- RIVRT: Rivals reaction time ---
      } else if (messageType === "RIVRT") {
        this.handleRivalsReactionTime(conn, parts);

      // --- RIVRDY: Rivals ready ack ---
      } else if (messageType === "RIVRDY") {
        this.handleRivalsReady(conn);

      // --- M: Race meta / lane state ---
      } else if (messageType === "M") {
        this.handleRaceMeta(conn, parts);

      // --- RKA: Race keepalive ---
      } else if (messageType === "RKA") {
        this.handleRaceKeepAlive(conn);

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

  getRaceParticipantConnectionId(participant) {
    return participant?.raceConnId || participant?.connId || null;
  }

  getRaceParticipantConnection(participant) {
    for (const connectionId of [participant?.raceConnId, participant?.connId]) {
      if (!connectionId) {
        continue;
      }
      const connection = this.connections.get(connectionId);
      if (connection) {
        return connection;
      }
    }
    return null;
  }

  findRaceParticipant(race, conn, { bindRaceConn = false } = {}) {
    if (!race || !conn) {
      return null;
    }

    let participant = race.players.find((entry) => entry.raceConnId === conn.id);
    if (!participant) {
      participant = race.players.find((entry) => entry.connId === conn.id);
    }
    if (!participant && conn.playerId) {
      participant = race.players.find((entry) => Number(entry.playerId) === Number(conn.playerId));
    }

    if (participant && bindRaceConn && !participant.raceConnId) {
      participant.raceConnId = conn.id;
    }

    return participant || null;
  }

  parseRaceDoneMetrics(parts) {
    const elapsedTime = this.normalizeNumericToken(parts[1], "-1");
    const trapSpeed = this.normalizeNumericToken(parts[2], "-1");
    const reportedTotal = this.normalizeNumericToken(parts[16], "0");
    const elapsedValue = Number(elapsedTime);
    const reportedTotalValue = Number(reportedTotal);
    const totalTime = Number.isFinite(reportedTotalValue) && reportedTotalValue > 0
      ? reportedTotalValue
      : (
        Number.isFinite(elapsedValue) && elapsedValue >= 0
          ? elapsedValue
          : Number.POSITIVE_INFINITY
      );

    return {
      rt: "-1",
      et: elapsedTime,
      ts: trapSpeed,
      totalTime,
    };
  }

  getRaceReactionTime(race, playerId) {
    if (!race?.reactionTimes || !playerId) {
      return "-1";
    }

    const reactionTime = race.reactionTimes.get(Number(playerId));
    return reactionTime ?? "-1";
  }

  isStagedDistance(distance) {
    const numericDistance = Number(distance);
    return Number.isFinite(numericDistance) && numericDistance > -2 && numericDistance < 1;
  }

  determineRaceWinnerFromResults(race) {
    if (!race?.finishResults || race.finishResults.size < race.players.length) {
      return 0;
    }

    const racers = race.players
      .map((participant) => {
        const playerId = Number(participant.playerId || 0);
        const result = race.finishResults.get(playerId);
        const reactionTime = Number(this.getRaceReactionTime(race, playerId));
        const elapsedTime = Number(result?.et ?? Number.POSITIVE_INFINITY);
        const bracketTime = Number(participant.bracketTime ?? -1);
        const breakoutMargin =
          Number.isFinite(bracketTime) && bracketTime > 0 && Number.isFinite(elapsedTime)
            ? bracketTime - elapsedTime
            : Number.NEGATIVE_INFINITY;
        const brokeOut = breakoutMargin > 0;
        const validReaction = Number.isFinite(reactionTime) && reactionTime >= 0;
        const validElapsed = Number.isFinite(elapsedTime) && elapsedTime >= 0;
        const validRun = validReaction && validElapsed;
        const reportedTotal = Number(result?.totalTime ?? Number.POSITIVE_INFINITY);
        const totalTime = Number.isFinite(reportedTotal) && reportedTotal > 0
          ? reportedTotal
          : (
            validRun
              ? reactionTime + elapsedTime
              : Number.POSITIVE_INFINITY
          );
        const bracketScore =
          validRun && Number.isFinite(bracketTime) && bracketTime > 0
            ? reactionTime + Math.max(elapsedTime - bracketTime, 0)
            : Number.POSITIVE_INFINITY;

        return {
          playerId,
          reactionTime,
          elapsedTime,
          totalTime,
          bracketTime,
          bracketScore,
          breakoutMargin,
          brokeOut,
          validRun,
        };
      })
      .filter((entry) => entry.playerId > 0);

    if (racers.length < 2) {
      return 0;
    }

    const [left, right] = racers;
    const isBracketRace =
      racers.some((entry) => Number.isFinite(entry.bracketTime) && entry.bracketTime > 0);

    if (!left.validRun && !right.validRun) {
      return -2;
    }
    if (!left.validRun) {
      return right.playerId;
    }
    if (!right.validRun) {
      return left.playerId;
    }

    if (isBracketRace) {
      if (left.brokeOut && !right.brokeOut) {
        return right.playerId;
      }
      if (right.brokeOut && !left.brokeOut) {
        return left.playerId;
      }
      if (left.brokeOut && right.brokeOut) {
        if (left.breakoutMargin !== right.breakoutMargin) {
          return left.breakoutMargin < right.breakoutMargin ? left.playerId : right.playerId;
        }
        if (left.reactionTime !== right.reactionTime) {
          return left.reactionTime < right.reactionTime ? left.playerId : right.playerId;
        }
        return left.playerId < right.playerId ? left.playerId : right.playerId;
      }

      if (left.bracketScore !== right.bracketScore) {
        return left.bracketScore < right.bracketScore ? left.playerId : right.playerId;
      }
      if (left.elapsedTime !== right.elapsedTime) {
        return left.elapsedTime < right.elapsedTime ? left.playerId : right.playerId;
      }
      return left.playerId < right.playerId ? left.playerId : right.playerId;
    }

    if (left.totalTime !== right.totalTime) {
      return left.totalTime < right.totalTime ? left.playerId : right.playerId;
    }
    if (left.elapsedTime !== right.elapsedTime) {
      return left.elapsedTime < right.elapsedTime ? left.playerId : right.playerId;
    }
    return left.playerId < right.playerId ? left.playerId : right.playerId;
  }

  buildRaceSummaryXml(race, winnerPlayerId) {
    const [p1, p2] = race.players;
    const p1Result = race.finishResults?.get(Number(p1?.playerId)) || null;
    const p2Result = race.finishResults?.get(Number(p2?.playerId)) || null;
    const p1ReactionTime = this.getRaceReactionTime(race, p1?.playerId);
    const p2ReactionTime = this.getRaceReactionTime(race, p2?.playerId);
    return `<r r1id='${p1?.playerId || 0}' r2id='${p2?.playerId || 0}' wid='${winnerPlayerId || 0}' rt1='${p1ReactionTime}' et1='${p1Result?.et ?? "-1"}' ts1='${p1Result?.ts ?? "-1"}' rt2='${p2ReactionTime}' et2='${p2Result?.et ?? "-1"}' ts2='${p2Result?.ts ?? "-1"}' m1='0' m2='0' c1='0' c2='0' h1='0' h2='0'/>`;
  }

  buildRaceDoneXml(playerId, result) {
    return `<r i='${Number(playerId || 0)}' et='${result?.et ?? "-1"}' ts='${result?.ts ?? "-1"}'/>`;
  }

  maybeAwardRaceScore(race, winnerPlayerId) {
    if (!(winnerPlayerId && this.supabase && !race.scAwarded)) {
      return;
    }

    const scWin = 50;
    const scLoss = 10;
    race.scAwarded = true;

    for (const participant of race.players) {
      const isWinner = Number(participant.playerId) === Number(winnerPlayerId);
      const scGain = isWinner ? scWin : scLoss;
      applyPlayerRaceResult(this.supabase, participant.playerId, {
        scoreDelta: scGain,
        won: isWinner,
        lost: !isWinner,
      }).catch((error) => {
        this.logger.warn("Failed to update SC/wins/losses", {
          playerId: participant.playerId,
          error: error.message,
        });
      });
    }

    this.logger.info("TCP race SC awarded", {
      raceId: race.id,
      winnerPlayerId,
      scWin,
      scLoss,
    });
  }

  broadcastRaceDone(race, playerId) {
    if (!race) {
      return;
    }
    const result = race.finishResults?.get(Number(playerId)) || null;
    if (!result) {
      return;
    }
    const escapedXml = this.escapeForTcp(this.buildRaceDoneXml(playerId, result));
    for (const participant of race.players) {
      const connectionIds = [...new Set([participant.connId, participant.raceConnId].filter(Boolean))];
      for (const connectionId of connectionIds) {
        const participantConn = this.connections.get(connectionId);
        if (!participantConn) {
          continue;
        }
        this.sendMessage(participantConn, `"ac", "RD", "d", "${escapedXml}"`);
      }
    }
  }

  broadcastRaceResult(race, winnerPlayerId) {
    if (!race || race.resultBroadcasted) {
      return;
    }

    race.resultBroadcasted = true;
    race.winnerPlayerId = winnerPlayerId || race.winnerPlayerId || 0;
    this.maybeAwardRaceScore(race, race.winnerPlayerId);

    const escapedXml = this.escapeForTcp(this.buildRaceSummaryXml(race, race.winnerPlayerId));
    for (const participant of race.players) {
      const connectionIds = [...new Set([participant.connId, participant.raceConnId].filter(Boolean))];
      for (const connectionId of connectionIds) {
        const participantConn = this.connections.get(connectionId);
        if (!participantConn) {
          continue;
        }
        this.sendMessage(participantConn, `"ac", "RW", "d", "${escapedXml}"`);
      }
    }
  }

  tryBroadcastRaceResult(race, winnerPlayerId) {
    if (!race || race.resultBroadcasted) {
      return false;
    }
    this.broadcastRaceResult(race, winnerPlayerId);
    return true;
  }

  isRaceReadyForTelemetry(race) {
    return race.players.length === 2 && race.players.every((participant) => this.getRaceParticipantConnectionId(participant) && participant.opened);
  }

  hasAllRaceMeta(race) {
    return Boolean(race?.metaByPlayer instanceof Map) && race.metaByPlayer.size >= race.players.length;
  }

  hasAllRivalsReadyAcks(race) {
    return Boolean(race?.rivalsReadyAcks instanceof Map) && race.rivalsReadyAcks.size >= race.players.length;
  }

  setRacePhase(race, phase, reason = "") {
    if (!race) return;
    const previous = race.phase || "LOADED";
    race.phase = phase;
    if (previous !== phase) {
      this.logger.info("TCP race phase changed", {
        raceId: race.id,
        previousPhase: previous,
        phase,
        reason,
      });
    }
  }

  buildRaceMetaRelayMessage(metaParts) {
    const payload = (metaParts || [])
      .map((part) => {
        const token = String(part ?? "").trim();
        if (!token) return '""';
        if (/^-?\d+(\.\d+)?$/.test(token)) return token;
        return `"${this.escapeForTcp(token)}"`;
      })
      .join(", ");

    return payload ? `"ac", "MO", ${payload}` : '"ac", "MO"';
  }

  maybeBroadcastRivalsReady(race) {
    if (!race) return;
    if (!race.players.every((entry) => entry.opened)) return;
    if (race.rivalsReadyBroadcasted) return;
    if (!race.players.every((entry) => entry.isStaged)) {
      race.allStagedSince = 0;
      return;
    }

    const now = Date.now();
    if (!race.allStagedSince) {
      race.allStagedSince = now;
      this.setRacePhase(race, "STAGED", "both-staged-hold");
      return;
    }

    if (now - race.allStagedSince < RACE_STAGE_SETTLE_MS) {
      return;
    }

    race.rivalsReadyBroadcasted = true;
    this.setRacePhase(race, "TREE_ARMED", "staged-hold-complete");
    for (const participant of race.players) {
      const participantConn = this.getRaceParticipantConnection(participant);
      if (participantConn) {
        this.sendMessage(participantConn, '"ac", "RIVRDY", "s", 1');
      }
    }
    this.logger.info("TCP race rivals-ready broadcast sent", { raceId: race.id });
  }

  maybeStartRaceSequence(race, trigger = "") {
    if (!race || race.sequenceStarted) return;
    if (!race.players.every((entry) => entry.opened)) return;
    if (!race.rivalsReadyBroadcasted) return;

    race.sequenceStarted = true;
    this.setRacePhase(race, "RACING", trigger || "both-opened");
    this.logger.info("TCP race sequence started", {
      raceId: race.id,
      trigger: trigger || "both-opened",
      stagedCount: race.stagedCount || 0,
      rivalsReadyAcks: Array.from(race.rivalsReadyAcks.keys()),
    });
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
      // The exported client chat UI only needs username + message text, and
      // the live capture shows visible inbound chat using the GC envelope.
      // Room chat reaching the client as TE has not rendered in testing.
      const roomChatMsg =
        `"ac", "GC", "u", "${this.escapeForTcp(conn.username)}", "m", "${this.escapeForTcp(chatText)}", "c", ${chatClass}`;
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

    const sender = this.findRaceParticipant(race, conn, { bindRaceConn: true });
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

    if (!this.isRaceReadyForTelemetry(race)) {
      return;
    }

    // Update race activity timestamp
    race.lastActivity = Date.now();

    // Parse the decoded fields for server-side staging/state tracking, but relay
    // the original race packet bytes to the opponent unchanged.
    const rawDistance = String(parts[1] ?? "").trim();
    const rawVelocity = String(parts[2] ?? "").trim();
    const rawAcceleration = String(parts[3] ?? "").trim();
    const rawTick = String(parts[4] ?? "0").trim();
    
    // Normalize values but preserve original if valid
    const distance = this.normalizeNumericToken(rawDistance, "0");
    const velocity = this.normalizeNumericToken(rawVelocity, "0");
    const acceleration = this.normalizeNumericToken(rawAcceleration, "0");
    const tick = this.normalizeNumericToken(rawTick, "0");

    if (
      distance !== rawDistance ||
      velocity !== rawVelocity ||
      acceleration !== rawAcceleration ||
      tick !== rawTick
    ) {
      this.logger.warn("TCP telemetry normalized invalid tokens", {
        connId: conn.id,
        raceId: race.id,
        playerId: conn.playerId,
        messageType,
        rawDistance,
        rawVelocity,
        rawAcceleration,
        rawTick,
        distance,
        velocity,
        acceleration,
        tick,
      });
    }

    sender.lastDistance = Number(distance);
    sender.isStaged = this.isStagedDistance(sender.lastDistance);
    if (!sender.isStaged) {
      sender.stagedSince = 0;
      race.allStagedSince = 0;
    } else if (!sender.stagedSince) {
      sender.stagedSince = Date.now();
    }
    this.maybeBroadcastRivalsReady(race);
    this.maybeStartRaceSequence(race, "staging-complete");

    const rawTelemetryFrame =
      typeof conn._lastRaw === "string" && conn._lastRaw.length > 0
        ? conn._lastRaw + MESSAGE_DELIMITER
        : null;

    for (const participant of race.players) {
      if (Number(participant.playerId) === Number(sender.playerId)) continue;
      const participantConn = this.getRaceParticipantConnection(participant);
      if (participantConn && participantConn.socket && !participantConn.socket.destroyed) {
        try {
          if (rawTelemetryFrame) {
            participantConn.socket.write(Buffer.from(rawTelemetryFrame, "latin1"));
          } else {
            // Defensive fallback: keep the race moving even if the raw frame is unavailable.
            this.sendMessage(
              participantConn,
              `${messageType}${FIELD_DELIMITER}${distance}${FIELD_DELIMITER}${velocity}${FIELD_DELIMITER}${acceleration}${FIELD_DELIMITER}${tick}`,
            );
          }
          
          // Debug logging (can be disabled in production for performance)
          if (this.debugTelemetry) {
            this.logger.info("TCP forwarded telemetry raw", {
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
          opponentConnId: this.getRaceParticipantConnectionId(participant),
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
        const participantConn = this.getRaceParticipantConnection(participant);
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

    const sender = this.findRaceParticipant(race, conn, { bindRaceConn: true });
    for (const participant of race.players) {
      const participantConn = this.getRaceParticipantConnection(participant);
      if (!participantConn) continue;
      if (!sender || Number(participant.playerId) !== Number(sender.playerId)) {
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

    const sender = this.findRaceParticipant(race, conn, { bindRaceConn: true });
    if (!sender) {
      this.logger.info("TCP M ignored from unknown race participant", {
        connId: conn.id,
        raceId: race.id,
      });
      return;
    }

    if (!race.metaByPlayer) {
      race.metaByPlayer = new Map();
    }
    const metaParts = parts.slice(1);
    race.metaByPlayer.set(Number(conn.playerId), metaParts);
    race.stagedCount = race.metaByPlayer.size;

    for (const participant of race.players) {
      if (Number(participant.playerId) === Number(sender.playerId)) continue;
      const participantConn = this.getRaceParticipantConnection(participant);
      if (participantConn) {
        this.sendMessage(participantConn, this.buildRaceMetaRelayMessage(metaParts));
      }
    }

    if (this.hasAllRaceMeta(race) && !race.sequenceStarted) {
      this.setRacePhase(race, "STAGED", "meta-from-both");
    }
    this.maybeBroadcastRivalsReady(race);
    this.maybeStartRaceSequence(race, "meta-update");
  }

  handleRivalsReady(conn) {
    const race = this.findRaceForConnection(conn);
    if (!race || !conn.playerId) {
      this.logger.info("TCP RIVRDY received without race", { connId: conn.id });
      return;
    }

    const sender = this.findRaceParticipant(race, conn, { bindRaceConn: true });
    if (!sender) {
      this.logger.info("TCP RIVRDY ignored from unknown race participant", {
        connId: conn.id,
        raceId: race.id,
      });
      return;
    }

    if (!race.rivalsReadyAcks) {
      race.rivalsReadyAcks = new Map();
    }
    race.rivalsReadyAcks.set(Number(sender.playerId), true);
    this.logger.info("TCP RIVRDY ack received", {
      connId: conn.id,
      raceId: race.id,
      playerId: sender.playerId,
      ackCount: race.rivalsReadyAcks.size,
    });

    this.maybeStartRaceSequence(race, "rivrdy-acks");
  }

  handleRaceKeepAlive(conn) {
    const race = this.findRaceForConnection(conn);
    if (!race) {
      this.logger.info("TCP RKA received without race", { connId: conn.id });
      return;
    }
    race.lastActivity = Date.now();
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
        for (const player of race.players) {
          if (player.raceConnId === conn.id) {
            player.raceConnId = null;
          }
          if (player.connId === conn.id) {
            const fallbackConnId =
              player.raceConnId &&
              player.raceConnId !== conn.id &&
              this.connections.has(player.raceConnId)
                ? player.raceConnId
                : null;
            player.connId = fallbackConnId;
          }
        }
        race.players = race.players.filter((player) => Boolean(player.connId || player.raceConnId));
        if (race.players.length === 0) {
          this.races.delete(conn.raceId);
          this.raceCompletions.delete(conn.raceId);
          this.logger.info("TCP race cleaned up (all players left)", { raceId: conn.raceId });
        }
      }
      conn.raceId = null;
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

    const queueXml = roomPlayers
      .filter((player) => Number(player.playerId || 0) > 0)
      .map((player) =>
        `<r i='${player.playerId}' icid='${player.carId}' ci='${player.playerId}' cicid='${player.carId}' bt='0' b='0'/>`
      ).join("");
    return `<q>${queueXml}</q>`;
  }

  getUserNameColor(clientRole) {
    const normalizedRole = Number(clientRole || 0);
    if (normalizedRole === 1) return "FF0000"; // Admin
    if (normalizedRole === 2) return "66CCFF"; // Mod
    if (normalizedRole === 8) return "0000FF"; // Senior Mod
    if (normalizedRole === 6) return "00AA00"; // Team Member Green
    return "7D7D7D"; // Default user grey
  }

  buildRoomUsersXml(roomPlayers) {
    const usersXml = roomPlayers
      .filter((player) => Number(player.playerId || 0) > 0 && player.username)
      .map((player) => {
      const color = this.getUserNameColor(player.clientRole);
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
    const [player, teamMember] = await Promise.all([
      getPlayerById(this.supabase, numericPlayerId),
      getTeamMembershipByPlayerId(this.supabase, numericPlayerId),
    ]);

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

    // Use excludeRaceChannels to get the lobby connection for the target
    const targetConn = this.findConnectionByPlayerId(targetPlayerId, true);
    if (!targetConn) {
      this.sendMessage(conn, '"ac", "RRQ", "s", -1');
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
    this.sendMessage(conn, `"ac", "RRQ", "s", 1, "d", "${raceGuid}"`);

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
    //
    // Do not invent a separate UCU user-add packet here. Both racers are already
    // present in the same room snapshot, and the synthetic UCU caused the client
    // to create a ghost/invisible duplicate user entry on challenge send.
    const rclgXml = this.buildRclgXml({
      challengerPlayerId: requesterPlayerId,
      challengerCarId: requesterCarId,
      challengedPlayerId: targetPlayerId,
      challengedCarId: targetCarId,
      bracketTime,
      raceGuid,
    });
    this.sendMessage(targetConn, `"ac", "RCLG", "d", "${this.escapeForTcp(rclgXml)}"`);
    
    this.logger.info("TCP RRQ challenge sent to target", {
      targetConnId: targetConn.id,
      targetPlayerId,
      raceGuid
    });
  }

  findConnectionByPlayerId(playerId, excludeRaceChannels = false) {
    if (!playerId) return null;
    const normalizedPlayerId = Number(playerId);

    const cachedConnId = this.connIdByPlayerId.get(normalizedPlayerId);
    if (cachedConnId) {
      const cachedConn = this.connections.get(cachedConnId);
      if (cachedConn && Number(cachedConn.playerId || 0) === normalizedPlayerId) {
        if (!excludeRaceChannels || cachedConn.roomId) {
          return cachedConn;
        }
      }
    }

    const matches = [];
    for (const [, candidate] of this.connections) {
      if (Number(candidate.playerId || 0) === normalizedPlayerId) {
        matches.push(candidate);
      }
    }
    
    if (matches.length === 0) return null;
    
    // If we have multiple connections for the same player, prefer the lobby connection
    // (the one that has roomId set) unless the caller is explicitly filtering.
    if (matches.length === 1) return matches[0];
    const lobbyConn = matches.find(c => c.roomId);
    
    if (excludeRaceChannels) {
      return lobbyConn || matches[0];
    }
    
    return lobbyConn || matches[matches.length - 1];
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

  buildUcuXml({ playerId, username, teamId = 2, clientRole = 5 }) {
    const color = this.getUserNameColor(clientRole);
    const normalizedTeamId = Number(teamId || 0);
    return `<ul><u ul='0' i='${Number(playerId)}' un='${this.escapeXml(username)}' ti='${normalizedTeamId}' tid='${normalizedTeamId}' tf='${color}' ms='5' iv='0'/></ul>`;
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

  buildRraXml({
    challengerPlayerId,
    challengerCarId,
    challengedPlayerId,
    challengedCarId,
    trackId,
    sc1 = 0,
    sc2 = 0,
    challengerBracketTime = -1,
    challengedBracketTime = -1,
    betType = 0,
  }) {
    return (
      `<r r1id='${Number(challengerPlayerId)}' r2id='${Number(challengedPlayerId)}' ` +
      `r1cid='${Number(challengerCarId)}' r2cid='${Number(challengedCarId)}' ` +
      `b1='${challengerBracketTime}' b2='${challengedBracketTime}' bt='${betType}' ` +
      `sc1='${Number(sc1)}' sc2='${Number(sc2)}' t='${Number(trackId)}'/>`
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
        const players = await listPlayersByIds(this.supabase, [
          requestA.requesterPlayerId,
          requestB.requesterPlayerId,
        ]);
        const playersById = new Map(players.map((player) => [Number(player.id), player]));
        scA = Number(playersById.get(Number(requestA.requesterPlayerId))?.score ?? 0);
        scB = Number(playersById.get(Number(requestB.requesterPlayerId))?.score ?? 0);
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
          isStaged: false,
          stagedSince: 0,
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
          isStaged: false,
          stagedSince: 0,
        },
      ],
      announced: false,
      trackId: 32,
      createdAt: Date.now(),
      phase: "LOADED",
      stagedCount: 0,
      allStagedSince: 0,
      sequenceStarted: false,
      metaByPlayer: new Map(),
      rivalsReadyAcks: new Map(),
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
          const participantConn = this.findConnectionByPlayerId(participant.playerId, true);
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
                challengerBracketTime: existingRace.players[0].bracketTime ?? -1,
                challengedBracketTime: existingRace.players[1].bracketTime ?? -1,
                betType: existingRace.betType ?? 0,
              })
            )}"`
          );
          // RO and IO frames are sent on the SRC (race channel) connection, not here.
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

    const responderPlayerId = Number(conn.playerId || 0);
    const accepted = Number(parts[1] || 1) === 1;
    const responderBracketTime = Number(parts[2] ?? -1);

    if (responderPlayerId === pending.challenger.playerId) {
      pending.ready.challenger = accepted;
      if (Number.isFinite(responderBracketTime) && responderBracketTime > 0) {
        pending.bracketTime = responderBracketTime;
      }
      this.sendMessage(conn, `"ac", "RRS", "s", ${accepted ? 1 : 0}, "i", "${pending.id}"`);
      this.logger.info("TCP RRS updated challenger pending challenge state", {
        connId: conn.id,
        raceGuid: pending.id,
        accepted,
        responderBracketTime,
        challengerReady: pending.ready.challenger,
        challengedReady: pending.ready.challenged,
      });
    } else if (responderPlayerId === pending.challenged.playerId) {
      if (!accepted) {
        this.pendingRaceChallenges.delete(pending.id);
        this.sendMessage(conn, `"ac", "RRS", "s", 1, "i", "${pending.id}"`);
        const challengerConn = this.connections.get(pending.challenger.connId);
        if (challengerConn) {
          this.sendMessage(challengerConn, `"ac", "RRS", "s", 0, "i", "${pending.id}"`);
        }
        this.logger.info("TCP RRS declined pending challenge", {
          connId: conn.id,
          raceGuid: pending.id,
          responderPlayerId,
        });
        return;
      }

      pending.ready.challenged = true;
      if (pending.bracketTime > -1) {
        pending.challenged.bracketTime = Number.isFinite(responderBracketTime) && responderBracketTime > 0
          ? responderBracketTime
          : -1;
      }
      this.sendMessage(conn, `"ac", "RRS", "s", 1, "i", "${pending.id}"`);
      this.logger.info("TCP RRS accepted pending challenge", {
        connId: conn.id,
        raceGuid: pending.id,
        responderPlayerId,
        challengerReady: pending.ready.challenger,
        challengedReady: pending.ready.challenged,
        challengerBracketTime: pending.bracketTime,
        challengedBracketTime: pending.challenged.bracketTime ?? -1,
      });
    } else {
      this.logger.warn("TCP RRS ignored from non-participant on pending challenge", {
        connId: conn.id,
        responderPlayerId,
        raceGuid: pending.id,
      });
      return;
    }

    if (!pending.ready.challenger || !pending.ready.challenged) {
      return;
    }

    this.startPendingRace(pending);
  }

  handleRaceOpen(conn) {
    const race = conn.raceId ? this.races.get(conn.raceId) : null;
    if (!race) {
      this.logger.info("TCP RO received without race", { connId: conn.id });
      return;
    }

    const player = race.players.find((entry) => entry.connId === conn.id || entry.raceConnId === conn.id);
    if (!player) {
      this.logger.info("TCP RO received from unknown race player", { connId: conn.id, raceId: race.id });
      return;
    }

    if (!player.raceConnId) {
      player.raceConnId = conn.id;
    }
    player.opened = true;
    this.logger.info("TCP RO received", { connId: conn.id, raceId: race.id, openedCount: race.players.filter((entry) => entry.opened).length });

    // Ack the tree-open event only after the client explicitly sends RO.
    this.sendMessage(conn, '"ac", "RO", "t", 32');

    if (race.players.every((entry) => entry.opened)) {
      this.maybeBroadcastRivalsReady(race);
      this.maybeStartRaceSequence(race, "race-open");
    }
  }

  handleRaceResponse(conn, parts) {
    const accepted = Number(parts[1] || 0) === 1;
    const challengedBracketTime = Number(parts[2] ?? -1);
    const guid = parts.find((part) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) || "";
    const pending = guid ? this.pendingRaceChallenges.get(guid) : null;
    if (!pending) {
      this.sendMessage(conn, `"ac", "RRSP", "s", -3, "i", "${guid}"`);
      this.logger.info("TCP RRSP received without pending challenge", { connId: conn.id, parts });
      return;
    }

    const responderPlayerId = Number(conn.playerId || 0);
    if (responderPlayerId !== pending.challenged.playerId) {
      this.sendMessage(conn, `"ac", "RRSP", "s", -7, "i", "${pending.id}"`);
      this.logger.warn("TCP RRSP ignored from non-challenged player", {
        connId: conn.id,
        responderPlayerId,
        raceGuid: pending.id,
        challengedPlayerId: pending.challenged.playerId,
      });
      return;
    }

    if (!accepted) {
      this.pendingRaceChallenges.delete(pending.id);
      this.sendMessage(conn, `"ac", "RRSP", "s", 1, "i", "${pending.id}"`);
      const challengerConn = this.connections.get(pending.challenger.connId);
      if (challengerConn) {
        this.sendMessage(challengerConn, `"ac", "RRSP", "s", 1, "i", "${pending.id}"`);
      }
      this.logger.info("TCP RRSP declined challenge", {
        connId: conn.id,
        responderPlayerId,
        raceGuid: pending.id,
      });
      return;
    }

    if (pending.bracketTime > -1 && challengedBracketTime <= 0) {
      this.sendMessage(conn, `"ac", "RRSP", "s", -11, "i", "${pending.id}"`);
      this.logger.info("TCP RRSP rejected invalid bracket dial-in", {
        connId: conn.id,
        responderPlayerId,
        raceGuid: pending.id,
        challengedBracketTime,
      });
      return;
    }

    pending.ready.challenged = true;
    pending.challenged.bracketTime = pending.bracketTime > -1 ? challengedBracketTime : -1;
    this.sendMessage(conn, `"ac", "RRSP", "s", 1, "i", "${pending.id}"`);
    this.logger.info("TCP RRSP accepted challenge", {
      connId: conn.id,
      responderPlayerId,
      raceGuid: pending.id,
      challengerBracketTime: pending.bracketTime,
      challengedBracketTime: pending.challenged.bracketTime,
    });

    if (!pending.ready.challenger || !pending.ready.challenged) {
      return;
    }

    this.startPendingRace(pending);
  }

  startPendingRace(pending) {
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

    const challengerBracketTime = Number(pending.bracketTime ?? -1);
    const challengedBracketTime = Number(pending.challenged.bracketTime ?? -1);
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
          isStaged: false,
          stagedSince: 0,
          bracketTime: challengerBracketTime,
        },
        {
          connId: pending.challenged.connId,
          playerId: pending.challenged.playerId,
          carId: pending.challenged.carId,
          lane: 2,
          bet: 0,
          ready: true,
          opened: false,
          isStaged: false,
          stagedSince: 0,
          bracketTime: challengedBracketTime,
        },
      ],
      announced: true,
      trackId: pending.trackId || 32,
      betType: 0,
      createdAt: Date.now(),
      phase: "LOADED",
      stagedCount: 0,
      allStagedSince: 0,
      sequenceStarted: false,
      metaByPlayer: new Map(),
      rivalsReadyAcks: new Map(),
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
      challengerBracketTime,
      challengedBracketTime,
      betType: 0,
    });

    for (const participantConn of [challengerConn, challengedConn]) {
      this.sendMessage(participantConn, `"ac", "RN", "d", "${this.escapeForTcp(rnXml)}"`);
      this.sendMessage(participantConn, `"ac", "RRA", "d", "${this.escapeForTcp(rraXml)}"`);
      // RO and IO frames are sent on the SRC (race channel) connection, not here.
    }

    this.logger.info("TCP race started from pending challenge", {
      raceGuid: race.id,
      challengerPlayerId: pending.challenger.playerId,
      challengedPlayerId: pending.challenged.playerId,
      challengerBracketTime,
      challengedBracketTime,
    });
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

    const winnerPlayerId = Number(parts[1] || 0);
    if (winnerPlayerId) {
      race.reportedWinnerPlayerId = winnerPlayerId;
    }

    this.sendMessage(conn, '"ac", "RR", "s", 1, "t", 0, "t2", 0');
    this.sendMessage(conn, `"ac", "UR", "td", 0, "guid", "${this.escapeForTcp(String(race.id || `${conn.playerId || 0}:${race.trackId || 32}`))}"`);
    this.sendMessage(conn, '"ac", "OR", "td", 0');

    if (race.finishResults?.size >= race.players.length) {
      const computedWinnerPlayerId = this.determineRaceWinnerFromResults(race);
      this.logger.info("TCP RR winner resolution", {
        raceId: race.id,
        reportedWinnerPlayerId: race.reportedWinnerPlayerId || 0,
        computedWinnerPlayerId,
      });
      this.tryBroadcastRaceResult(race, computedWinnerPlayerId);
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

  buildRacePairKey(playerAId, playerBId) {
    return [playerAId, playerBId].sort((left, right) => left - right).join(":");
  }

  decodeLegacyTcpValue(value) {
    const rawValue = String(value || "");
    if (!rawValue) {
      return "";
    }

    try {
      return decodeURIComponent(rawValue);
    } catch {
      try {
        return unescape(rawValue);
      } catch {
        return rawValue;
      }
    }
  }

  buildLegacyActionServices() {
    return {
      ...(this.proxy?.services || {}),
      raceRoomRegistry: this.raceRoomRegistry,
      tcpServer: this,
    };
  }

  async handleLegacyTeamCreate(conn, parts) {
    const sessionKey = String(conn.sessionKey || "");
    const decodedTeamName = this.decodeLegacyTcpValue(parts[1] || "");
    const params = new URLSearchParams();
    params.set("action", "teamcreate");
    params.set("n", decodedTeamName);
    if (sessionKey) {
      params.set("sk", sessionKey);
    }

    this.logger.info("TCP TEAMCREATE received", {
      connId: conn.id,
      playerId: conn.playerId || 0,
      hasSessionKey: Boolean(sessionKey),
      teamName: decodedTeamName,
    });

    try {
      const result = await handleGameAction({
        action: "teamcreate",
        params,
        rawQuery: `legacy:TEAMCREATE:${decodedTeamName}`,
        decodedQuery: `action=teamcreate&n=${decodedTeamName}`,
        supabase: this.supabase,
        logger: this.logger,
        services: this.buildLegacyActionServices(),
      });

      const responseBody = result?.body || '"s", 0';
      this.sendMessage(conn, `"ac", "TEAMCREATE", ${responseBody}`);
      this.logger.info("TCP TEAMCREATE handled", {
        connId: conn.id,
        playerId: conn.playerId || 0,
        source: result?.source || "tcp:TEAMCREATE:unknown",
        responseBody,
      });
    } catch (error) {
      this.logger.error("TCP TEAMCREATE error", {
        connId: conn.id,
        playerId: conn.playerId || 0,
        error: error?.message || String(error),
      });
      this.sendMessage(conn, '"ac", "TEAMCREATE", "s", 0');
    }
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
