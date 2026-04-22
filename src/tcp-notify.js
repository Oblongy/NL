import { escapeXml } from "./game-xml.js";

export class TcpNotify {
  constructor({ logger, tcpServer }) {
    this.logger = logger;
    this.tcpServer = tcpServer;
  }

  notify(channel, payload) {
    this.logger.info("TCP notify", { channel, payload });
  }

  // Broadcast a message to all players in a room (batched — one write per socket)
  broadcastToRoom(roomId, room, messageType = "room_update") {
    if (!this.tcpServer) {
      this.logger.warn("TCP server not available for broadcast");
      return;
    }

    const playerCount = room.players?.length || 0;
    const playersXml = (room.players || []).map(p => 
      `<player id='${p.publicId}' name='${escapeXml(p.name)}' ready='${p.ready ? 1 : 0}'/>`
    ).join('');
    
    const roomXml = `<room id='${room.roomId}' name='${escapeXml(room.name)}' type='${room.type}' players='${playerCount}' max='${room.maxPlayers}' status='${room.status}'>${playersXml}</room>`;
    
    const playerIds = (room.players || []).map(p => p.id);
    const message = `"ac", "RU", "d", "${this.escapeForTcp(roomXml)}"`;

    const sent = this.tcpServer.broadcastToPlayers(playerIds, message);
    this.logger.info("Broadcast room update", { roomId, playerCount, sent, messageType });
  }

  // Notify a specific player
  notifyPlayer(playerId, message) {
    if (!this.tcpServer) {
      this.logger.warn("TCP server not available for notify");
      return false;
    }

    const sent = this.tcpServer.sendToPlayer(playerId, message);
    if (!sent) {
      this.logger.warn("TCP notify failed (player not connected)", { playerId });
    }
    return sent;
  }

  escapeForTcp(str) {
    if (!str) return "";
    return String(str).replace(/"/g, '\\"');
  }
}
