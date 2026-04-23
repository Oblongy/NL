import test from "node:test";
import assert from "node:assert/strict";
import { TcpServer } from "./tcp-server.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createServer() {
  const server = new TcpServer({
    logger: createLogger(),
    notify() {},
    proxy: null,
    supabase: null,
  });

  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };
  server.recordRaceDebugEvent = () => {};
  server.getRaceParticipantConnection = (participant) => participant.mockConn || null;

  return server;
}

function createRace(id = "race-stage-test") {
  return {
    id,
    phase: "LOADED",
    players: [
      {
        playerId: 1,
        opened: true,
        isStaged: true,
        mockConn: { id: 101, messages: [] },
      },
      {
        playerId: 2,
        opened: true,
        isStaged: true,
        mockConn: { id: 102, messages: [] },
      },
    ],
    allStagedSince: 0,
    rivalsReadyBroadcasted: false,
    resultBroadcasted: false,
    sequenceStarted: false,
    stageSettleTimer: null,
  };
}

test("broadcasts rivals-ready after staged settle window without extra packets", async () => {
  const server = createServer();
  const race = createRace("race-stage-timer");
  server.races.set(race.id, race);

  server.maybeBroadcastRivalsReady(race);

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.ok(race.stageSettleTimer);

  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.equal(race.rivalsReadyBroadcasted, true);
  assert.equal(race.sequenceStarted, true);
  assert.equal(race.phase, "RACING");
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [
    ['"ac", "RIVRDY", "s", 1'],
    ['"ac", "RIVRDY", "s", 1'],
  ]);
});

test("cancels staged settle timer when a racer leaves the staged state", async () => {
  const server = createServer();
  const race = createRace("race-stage-cancel");
  server.races.set(race.id, race);

  server.maybeBroadcastRivalsReady(race);
  race.players[1].isStaged = false;
  server.maybeBroadcastRivalsReady(race);

  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.equal(race.sequenceStarted, false);
  assert.equal(race.stageSettleTimer, null);
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [[], []]);
});
