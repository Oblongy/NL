import { config } from "./config.js";
import { logger } from "./logger.js";
import { FixtureStore } from "./fixture-store.js";
import { createGameSupabase } from "./supabase-client.js";
import { createHttpServer } from "./http-server.js";
import { RaceRoomRegistry } from "./race-room-registry.js";
import { RaceManager } from "./race-manager.js";
import { RivalsState } from "./rivals-state.js";
import { TeamState } from "./team-state.js";
import { TcpNotify } from "./tcp-notify.js";
import { TcpProxy } from "./tcp-proxy.js";
import { TcpServer } from "./tcp-server.js";

const fixtureStore = new FixtureStore({
  fixturesRoot: config.fixturesRoot,
  logger,
});

const supabase = await createGameSupabase(config, logger);
const raceRoomRegistry = new RaceRoomRegistry();
const raceManager = new RaceManager();
const rivalsState = new RivalsState();
const teamState = new TeamState();
const tcpProxy = new TcpProxy({ logger });

// Create TCP server first (without notify)
const tcpServer = new TcpServer({ 
  logger, 
  notify: null, // Will be set after tcpNotify is created
  proxy: tcpProxy,
  supabase,
  raceRoomRegistry,
  port: config.tcpPort,
  host: config.tcpHost,
});

// Create tcpNotify with reference to tcpServer
const tcpNotify = new TcpNotify({ logger, tcpServer });

// Now set the notify reference in tcpServer
tcpServer.notify = tcpNotify;

// Set services in tcpProxy so it can access race room registry on disconnect
tcpProxy.services = {
  raceRoomRegistry,
  raceManager,
  rivalsState,
  teamState,
  tcpNotify,
  tcpServer,
};

const server = createHttpServer({
  config,
  logger,
  fixtureStore,
  supabase,
  services: {
    raceRoomRegistry,
    rivalsState,
    teamState,
    tcpNotify,
    tcpProxy,
    tcpServer,
  },
});

await tcpServer.start();

server.listen(config.port, config.httpHost, () => {
  logger.info("Backend listening", {
    host: config.httpHost,
    port: config.port,
    tcpHost: config.tcpHost,
    tcpPort: config.tcpPort,
    supabase: Boolean(supabase),
  });
});
