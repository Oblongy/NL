export const DEFAULT_RACE_ROOMS = [
  { id: 1, name: "Team Rivals Strip",              type: "team",         maxPlayers: 8,  tcpRoomType: 5, systemMessages: 0, stripId: 8 },
  { id: 2, name: "Tournament Strip",               type: "tournament",   maxPlayers: 32, tcpRoomType: 5, systemMessages: 0, stripId: 7 },
  { id: 3, name: "Bracket King of the Hill Strip", type: "bracket_koth", maxPlayers: 16, tcpRoomType: 3, systemMessages: 0, stripId: 3 },
  { id: 4, name: "H2H King of the Hill Strip",     type: "h2h_koth",     maxPlayers: 8,  tcpRoomType: 6, systemMessages: 0, stripId: 6 },
  { id: 5, name: "Newbie Rivals Strip",            type: "newbie",       maxPlayers: 20, tcpRoomType: 5, systemMessages: 1, stripId: 5 },
];

export function getDefaultRaceRoom(roomId) {
  return DEFAULT_RACE_ROOMS.find((room) => Number(room.id) === Number(roomId)) || null;
}

export function ensureDefaultRaceRooms(raceRoomRegistry) {
  if (!raceRoomRegistry) {
    return [...DEFAULT_RACE_ROOMS];
  }

  for (const room of DEFAULT_RACE_ROOMS) {
    const existingRoom = raceRoomRegistry.get(room.id) || {};
    raceRoomRegistry.upsert(room.id, {
      ...existingRoom,
      name: room.name,
      type: room.type,
      maxPlayers: room.maxPlayers,
      tcpRoomType: room.tcpRoomType,
      systemMessages: Number(room.systemMessages ?? 0),
      stripId: room.stripId,
      players: existingRoom.players || [],
      status: existingRoom.status || "waiting",
    });
  }

  return raceRoomRegistry.list();
}
