import { createServer } from "node:net";
import { encryptPayload, decodePayload } from "./nitto-cipher.js";
import { getSessionPlayerId } from "./session.js";

export class TcpServer {
  constructor({ logger, notify, proxy, supabase, port = 3724, host = "127.0.0.1" }) {
    this.logger = logger;
    this.notify = notify;
    this.proxy = proxy;
    this.supabase = supabase;
    this.port = port;
    this.host = host;
    this.started = false;
    this.server = null;
    this.connections = new Map();
    this.nextConnId = 1;
    // Room state: roomId -> [{ connId, playerId, username, carId }]
    this.rooms = new Map();
    this.rooms.set(1, []); // Newbie Rivals room
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

    const conn = { id: connId, socket, buffer: "", playerId: null, sessionKey: null };
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
    conn.buffer += data.toString("latin1");
    const messages = conn.buffer.split("\x04");
    conn.buffer = messages.pop() || "";
    for (const message of messages) {
      if (message.trim()) {
        this.handleMessage(conn, message.trim()).catch((error) => {
          this.logger.error("Async message handling error", { connId: conn.id, error: error.message });
        });
      }
    }
  }

  async handleMessage(conn, encryptedMessage) {
    try {
      const { decoded, seed } = decodePayload(encryptedMessage);
      const parts = decoded.split(/[~\u001e]/);
      const messageType = parts[0];

      this.logger.info("TCP message received", { connId: conn.id, messageType, seed, parts: parts.length });

      // --- L: Login ---
      if (messageType === "L") {
        const sessionKey = parts[1];
        conn.sessionKey = sessionKey;

        if (this.supabase && sessionKey) {
          try {
            const playerId = await getSessionPlayerId({ supabase: this.supabase, sessionKey });
            if (playerId) {
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

      // --- LRCR2: Get room list ---
      } else if (messageType === "LRCR2") {
        // Python server: single room with rc='1' cy='20' rt='5'
        this.sendMessage(conn, `"ac", "LRCR2", "d", "<rooms><r rc='1' cy='20' rt='5' cid='1' rn='Newbie Rivals' ip='0' mo='0' sm='1' pro='0'/></rooms>"`);
        this.logger.info("Sent LRCR2 room list", { connId: conn.id });

      // --- JRC: Join room (create) ---
      } else if (messageType === "JRC") {
        const playerId = conn.playerId || 0;
        const carId = conn.carId || 0;
        const username = conn.username || "Player";
        const roomId = 1; // Newbie Rivals
        conn.roomId = roomId;

        // Add player to room
        const room = this.rooms.get(roomId) || [];
        // Remove any stale entry for this player
        const filtered = room.filter(p => p.connId !== conn.id);
        filtered.push({ connId: conn.id, playerId, username, carId });
        this.rooms.set(roomId, filtered);

        // Build LRCU with ALL players in room
        const allUsersXml = filtered.map(p =>
          `<u i='${p.playerId}' un='${p.username}' ti='1' tid='1' tf='7D7D7D' ms='5' iv='0'/>`
        ).join('');
        const lrcuXml = `<ul>${allUsersXml}</ul>`;

        // Send JR, LR, LRCU x2 to joining player
        this.sendMessage(conn, '"ac", "JR", "s", 1');
        this.sendMessage(conn, `"ac", "LR", "s", "<q><r i='${playerId}' icid='${carId}' ci='${playerId}' cicid='${carId}'/></q>"`);
        this.sendMessage(conn, `"ac", "LRCU", "d", "${lrcuXml}"`);
        this.sendMessage(conn, `"ac", "LRCU", "d", "${lrcuXml}"`);

        // Notify all OTHER players in room that someone joined (send updated LRCU)
        for (const member of filtered) {
          if (member.connId === conn.id) continue;
          const otherConn = this.connections.get(member.connId);
          if (otherConn) {
            this.sendMessage(otherConn, `"ac", "LRCU", "d", "${lrcuXml}"`);
          }
        }

        this.logger.info("Player joined room", { connId: conn.id, playerId, username, roomSize: filtered.length });

      // --- GR: Get race (after JRC, triggers race announcement) ---
      } else if (messageType === "GR") {
        this.logger.info("TCP GR received", { connId: conn.id });
        // Race announcement handled separately when opponent connects

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

      // --- SRC: Status/ready change ---
      } else if (messageType === "SRC") {
        this.logger.info("TCP SRC received", { connId: conn.id });

      // --- RRS: Race ready status ---
      } else if (messageType === "RRS") {
        this.logger.info("TCP RRS received", { connId: conn.id });

      // --- RO: Race open ---
      } else if (messageType === "RO") {
        this.logger.info("TCP RO received", { connId: conn.id });

      // --- RR: Race result ---
      } else if (messageType === "RR") {
        this.logger.info("TCP RR received", { connId: conn.id });

      } else {
        this.logger.info("TCP unhandled message", { connId: conn.id, messageType });
      }

    } catch (error) {
      this.logger.error("TCP message decode error", {
        connId: conn.id,
        error: error.message,
        message: encryptedMessage.substring(0, 50),
      });
    }
  }

  leaveRoom(conn) {
    if (!conn.roomId) return;
    const room = this.rooms.get(conn.roomId) || [];
    const updated = room.filter(p => p.connId !== conn.id);
    this.rooms.set(conn.roomId, updated);
    // Notify remaining players
    if (updated.length > 0) {
      const allUsersXml = updated.map(p =>
        `<u i='${p.playerId}' un='${p.username}' ti='1' tid='1' tf='7D7D7D' ms='5' iv='0'/>`
      ).join('');
      const lrcuXml = `<ul>${allUsersXml}</ul>`;
      for (const member of updated) {
        const otherConn = this.connections.get(member.connId);
        if (otherConn) this.sendMessage(otherConn, `"ac", "LRCU", "d", "${lrcuXml}"`);
      }
    }
    this.logger.info("Player left room", { connId: conn.id, roomId: conn.roomId, remaining: updated.length });
  }

  sendMessage(conn, message) {
    try {
      const seed = Math.floor(Math.random() * 90) + 10;
      const encrypted = encryptPayload(message, seed);
      conn.socket.write(Buffer.from(encrypted + "\x04", "latin1"));
      this.logger.info("TCP message sent", { connId: conn.id, seed, bytes: encrypted.length + 1, rawMessage: message });
    } catch (error) {
      this.logger.error("TCP send error", { connId: conn.id, error: error.message });
    }
  }
}
