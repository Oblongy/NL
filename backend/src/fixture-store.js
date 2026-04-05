import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function pickBody(record) {
  return (
    record.decoded_response_unescaped ||
    record.decoded_response ||
    record.response_body_ascii ||
    ""
  );
}

function deriveAction(record) {
  if (record.action_name) {
    return record.action_name;
  }

  const decodedQuery = record.decoded_query || "";
  if (decodedQuery.startsWith("action=")) {
    return decodedQuery.split("&", 1)[0].split("=", 2)[1];
  }

  return "";
}

export class FixtureStore {
  constructor({ fixturesRoot, logger }) {
    this.fixturesRoot = fixturesRoot;
    this.logger = logger;
    this.byKey = new Map();
    this.loaded = false;
  }

  ensureLoaded() {
    if (this.loaded) {
      return;
    }

    const names = readdirSync(this.fixturesRoot).filter((name) =>
      name.endsWith(".decoded_http_responses.json"),
    );

    for (const name of names.sort()) {
      const filePath = resolve(this.fixturesRoot, name);
      const records = JSON.parse(readFileSync(filePath, "utf8"));

      for (const record of records) {
        const body = pickBody(record);
        if (!body) {
          continue;
        }

        const decodedQuery = record.decoded_query || "";
        const action = deriveAction(record);
        const uri = record.uri || "";
        const keys = [decodedQuery, action, uri].filter(Boolean);

        for (const key of keys) {
          const current = this.byKey.get(key);
          if (!current || body.length > current.body.length) {
            this.byKey.set(key, {
              key,
              body,
              file: name,
            });
          }
        }
      }
    }

    this.loaded = true;
    this.logger.info("Loaded fixture records", { keys: this.byKey.size, files: names.length });
  }

  find(...keys) {
    this.ensureLoaded();
    for (const key of keys.filter(Boolean)) {
      const hit = this.byKey.get(key);
      if (hit) {
        return hit;
      }
    }
    return null;
  }
}
