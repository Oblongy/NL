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

test("broadcasts rivals-ready after staged settle window and starts without client ready echoes", async () => {
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

test("already-armed rivals-ready path clears the settle timer without throwing", () => {
  const server = createServer();
  const race = createRace("race-stage-already-armed");
  race.rivalsReadyBroadcasted = true;
  race.stageSettleTimer = setTimeout(() => {}, 10_000);

  assert.doesNotThrow(() => server.maybeBroadcastRivalsReady(race));
  assert.equal(race.stageSettleTimer, null);
});

test("newbie rivals does not arm from RO fallback without actual staging", () => {
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

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.equal(race.phase, "LOADED");
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [[], []]);
});

test("team rivals also waits for actual staging before arming the tree", () => {
  const server = createServer();
  const race = createRace("race-open-fallback-team", 1);
  race.players.forEach((player) => {
    player.isStaged = false;
  });

  server.maybeBroadcastRivalsReady(race, {
    allowUnstagedFallback: true,
    trigger: "race-open-fallback",
  });

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.equal(race.phase, "LOADED");
  assert.equal(race.stageSettleTimer, null);
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [[], []]);
});

test("koth rooms do not arm from RO fallback without actual staging either", () => {
  const server = createServer();
  const race = createRace("race-open-fallback-koth", 3);
  race.players.forEach((player) => {
    player.isStaged = false;
  });

  server.maybeBroadcastRivalsReady(race, {
    allowUnstagedFallback: true,
    trigger: "race-open-fallback",
  });

  assert.equal(race.rivalsReadyBroadcasted, false);
  assert.equal(race.phase, "LOADED");
  assert.equal(race.stageSettleTimer, null);
  assert.deepEqual(race.players.map((player) => player.mockConn.messages), [[], []]);
});
