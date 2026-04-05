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
}
