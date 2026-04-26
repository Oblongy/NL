import assert from "node:assert/strict";
import test from "node:test";

import { getMostRecentActiveSession } from "./session.js";

function createSupabaseStub(sessionRows = []) {
  return {
    from(table) {
      let rows = [...sessionRows];
      const filters = [];
      let orderField = "";
      let orderAscending = true;
      let limitCount = null;

      const query = {
        select() {
          return query;
        },
        gte(field, value) {
          filters.push({ type: "gte", field, value });
          return query;
        },
        order(field, options = {}) {
          orderField = field;
          orderAscending = options.ascending !== false;
          return query;
        },
        limit(value) {
          limitCount = Number(value || 0);
          return query;
        },
        async maybeSingle() {
          if (table !== "game_sessions") {
            return { data: null, error: null };
          }

          rows = rows.filter((row) => filters.every((filter) => {
            if (filter.type === "gte") {
              return String(row?.[filter.field] || "") >= String(filter.value || "");
            }
            return true;
          }));

          if (orderField) {
            rows.sort((left, right) => {
              const leftValue = String(left?.[orderField] || "");
              const rightValue = String(right?.[orderField] || "");
              return orderAscending ? leftValue.localeCompare(rightValue) : rightValue.localeCompare(leftValue);
            });
          }

          if (Number.isFinite(limitCount) && limitCount > 0) {
            rows = rows.slice(0, limitCount);
          }

          return {
            data: rows[0] || null,
            error: null,
          };
        },
      };

      return query;
    },
  };
}

test("getMostRecentActiveSession returns the freshest unexpired session", async () => {
  const recent = new Date("2026-04-26T12:00:00.000Z").toISOString();
  const older = new Date("2026-04-25T12:00:00.000Z").toISOString();

  const session = await getMostRecentActiveSession({
    supabase: createSupabaseStub([
      {
        session_key: "older-session",
        player_id: 14,
        created_at: older,
        last_seen_at: older,
      },
      {
        session_key: "latest-session",
        player_id: 17,
        created_at: recent,
        last_seen_at: recent,
      },
    ]),
  });

  assert.ok(session);
  assert.equal(session.session_key, "latest-session");
  assert.equal(session.player_id, 17);
});
