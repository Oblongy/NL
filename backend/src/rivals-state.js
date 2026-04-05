export class RivalsState {
  constructor() {
    this.rivals = new Map();
  }

  set(playerId, rivalData) {
    const value = { playerId: Number(playerId), ...rivalData, updatedAt: Date.now() };
    this.rivals.set(String(playerId), value);
    return value;
  }

  get(playerId) {
    return this.rivals.get(String(playerId)) || null;
  }

  list() {
    return [...this.rivals.values()];
  }

  remove(playerId) {
    return this.rivals.delete(String(playerId));
  }
}
