export class TeamState {
  constructor() {
    this.teams = new Map();
  }

  set(teamId, payload) {
    const value = { teamId: Number(teamId), ...payload, updatedAt: Date.now() };
    this.teams.set(String(teamId), value);
    return value;
  }

  get(teamId) {
    return this.teams.get(String(teamId)) || null;
  }

  list() {
    return [...this.teams.values()];
  }

  remove(teamId) {
    return this.teams.delete(String(teamId));
  }

  /**
   * Remove team entries that have not been updated within `ttlMs` milliseconds.
   * Returns the number of evicted entries.
   */
  cleanup(ttlMs = 60 * 60 * 1000) {
    const cutoff = Date.now() - ttlMs;
    let evicted = 0;
    for (const [key, entry] of this.teams) {
      if ((entry.updatedAt || 0) < cutoff) {
        this.teams.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}
