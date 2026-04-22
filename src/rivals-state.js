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

  /**
   * Remove rivals entries that have not been updated within `ttlMs` milliseconds.
   * Returns the number of evicted entries.
   */
  cleanup(ttlMs = 30 * 60 * 1000) {
    const cutoff = Date.now() - ttlMs;
    let evicted = 0;
    for (const [key, entry] of this.rivals) {
      if ((entry.updatedAt || 0) < cutoff) {
        this.rivals.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}
