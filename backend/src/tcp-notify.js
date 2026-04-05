export class TcpNotify {
  constructor({ logger, tcpServer }) {
    this.logger = logger;
    this.tcpServer = tcpServer;
  }

  notify(channel, payload) {
    this.logger.info("TCP notify", { channel, payload });
  }

  // Broadcast a message to all players in a room
  broadcastToRoom(roomId, room, messageType = "room_update") {
    if (!this.tcpServer) {
      this.logger.warn("TCP server not available for broadcast");
      return;
    }

    const playerCount = room.players?.length || 0;
    const playersXml = (room.players || []).map(p => 
      `<player id='${p.publicId}' name='${this.escapeXml(p.name)}' ready='${p.ready ? 1 : 0}'/>`
    ).join('');
    
    const roomXml = `<room id='${room.roomId}' name='${this.escapeXml(room.name)}' type='${room.type}' players='${playerCount}' max='${room.maxPlayers}' status='${room.status}'>${playersXml}</room>`;
    
    // Send to all players in the room
    const playerIds = (room.players || []).map(p => p.id);
    this.tcpServer.broadcastToPlayers(playerIds, `"ac", "RU", "d", "${this.escapeForTcp(roomXml)}"`);
    
    this.logger.info("Broadcast room update", { roomId, playerCount, messageType });
  }

  // Notify a specific player
  notifyPlayer(playerId, message) {
    if (!this.tcpServer) {
      this.logger.warn("TCP server not available for notify");
      return;
    }

    this.tcpServer.sendToPlayer(playerId, message);
  }

  escapeXml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  escapeForTcp(str) {
    if (!str) return "";
    // Escape quotes for TCP message format
    return String(str).replace(/"/g, '\\"');
  }
}
