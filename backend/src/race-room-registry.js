export class RaceRoomRegistry {
  constructor() {
    this.rooms = new Map();
  }

  upsert(roomId, payload) {
    const nextValue = { roomId, ...payload, updatedAt: Date.now() };
    this.rooms.set(String(roomId), nextValue);
    return nextValue;
  }

  get(roomId) {
    return this.rooms.get(String(roomId)) || null;
  }

  list() {
    return [...this.rooms.values()];
  }

  remove(roomId) {
    return this.rooms.delete(String(roomId));
  }

  removePlayerFromOtherRooms(roomId, playerId) {
    const removedFrom = [];
    for (const room of this.rooms.values()) {
      if (Number(room.roomId) === Number(roomId)) {
        continue;
      }

      const result = this.removePlayer(room.roomId, playerId);
      if (result.removed) {
        removedFrom.push(room.roomId);
      }
    }
    return removedFrom;
  }

  // Add a player to a room
  addPlayer(roomId, player) {
    const room = this.get(roomId);
    if (!room) return { success: false, error: "room_not_found" };
    
    if (!room.players) room.players = [];

    const playerId = Number(player.id);
    const existingPlayer = room.players.find((entry) => Number(entry.id) === playerId);

    // A player can only belong to one room at a time. Normalize stale multi-room
    // state by pruning every other membership before we return the target room.
    const movedFrom = this.removePlayerFromOtherRooms(roomId, playerId);

    if (existingPlayer) {
      existingPlayer.publicId = player.publicId;
      existingPlayer.name = player.name;
      this.upsert(roomId, room);
      return { success: true, room, alreadyPresent: true, movedFrom };
    }
    
    // Check if room is full
    if (room.players.length >= room.maxPlayers) {
      return { success: false, error: "room_full" };
    }

    room.players.push({
      id: playerId,
      publicId: player.publicId,
      name: player.name,
      ready: false,
      joinedAt: Date.now(),
    });
    
    this.upsert(roomId, room);
    return { success: true, room, movedFrom };
  }

  // Remove a player from a room
  removePlayer(roomId, playerId) {
    const room = this.get(roomId);
    if (!room) return { success: false, error: "room_not_found" };
    
    if (!room.players) room.players = [];
    
    const initialLength = room.players.length;
    room.players = room.players.filter(p => p.id !== playerId);
    
    this.upsert(roomId, room);
    return { 
      success: true, 
      removed: initialLength !== room.players.length,
      room 
    };
  }

  // Remove a player from all rooms
  removePlayerFromAllRooms(playerId) {
    const removedFrom = [];
    for (const room of this.rooms.values()) {
      const result = this.removePlayer(room.roomId, playerId);
      if (result.removed) {
        removedFrom.push(room.roomId);
      }
    }
    return removedFrom;
  }

  // Get room by player ID
  getRoomByPlayer(playerId) {
    for (const room of this.rooms.values()) {
      if (room.players?.some(p => p.id === playerId)) {
        return room;
      }
    }
    return null;
  }

  // Set player ready status
  setPlayerReady(roomId, playerId, ready = true) {
    const room = this.get(roomId);
    if (!room) return { success: false, error: "room_not_found" };
    
    const player = room.players?.find(p => p.id === playerId);
    if (!player) return { success: false, error: "player_not_in_room" };
    
    player.ready = ready;
    this.upsert(roomId, room);
    return { success: true, room };
  }

  // Check if all players are ready
  areAllPlayersReady(roomId) {
    const room = this.get(roomId);
    if (!room || !room.players || room.players.length === 0) return false;
    return room.players.every(p => p.ready);
  }
}
