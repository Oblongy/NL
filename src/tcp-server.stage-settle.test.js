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
  clearInterval(server.challengeCleanupInterval);
  server.challengeCleanupInterval = null;

  server.sendMessage = (conn, message) => {
    conn.messages.push(message);
  };
  server.recordRaceDebugEvent = () => {};
  server.getRaceParticipantConnection = (participant) => participant.mockConn || null;

  return server;
}

function createRace(id = "race-stage-test", roomId = 5) {
  return {
    id,
    roomId,
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
    stagedCount: 2,
    rivalsReadyAcks: new Map(),
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

test("defers RO fallback until both racers send telemetry or meta", () => {
  const server = createServer();
  const race = createRace("race-open-fallback-deferred");
  race.players.forEach((player) => {
    player.isStaged = false;
  });

  server.maybeBroadcastRivalsReady(race, {
    allowUnstagedFallback: true,
    trigger: "race-open-fallback",
  });

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.equal(race.phase, "LOADED");

  race.telemetryCountsByPlayer = new Map([
    [1, 1],
    [2, 1],
  ]);

  server.maybeBroadcastRivalsReady(race, {
    allowUnstagedFallback: true,
    trigger: "race-open-fallback",
  });

  assert.equal(race.rivalsReadyBroadcasted, true);
  assert.equal(race.phase, "TREE_ARMED");
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [
    ['"ac", "RIVRDY", "s", 1'],
    ['"ac", "RIVRDY", "s", 1'],
  ]);
});

test("team rivals keeps the legacy unstaged fallback without telemetry evidence", () => {
  const server = createServer();
  const race = createRace("race-open-fallback-team", 1);
  race.players.forEach((player) => {
    player.isStaged = false;
  });

  server.maybeBroadcastRivalsReady(race, {
    allowUnstagedFallback: true,
    trigger: "race-open-fallback",
  });

  assert.equal(race.rivalsReadyBroadcasted, true);
  assert.equal(race.phase, "TREE_ARMED");
  assert.equal(race.stageSettleTimer, null);
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [
    ['"ac", "RIVRDY", "s", 1'],
    ['"ac", "RIVRDY", "s", 1'],
  ]);
});
