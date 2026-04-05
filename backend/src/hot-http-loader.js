import { FixtureStore } from "./fixture-store.js";

export function createHotHttpLoader(options) {
  return new FixtureStore(options);
}

export { FixtureStore };
