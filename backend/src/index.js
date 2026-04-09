import { config } from "./config.js";
import { logger } from "./logger.js";
import { createGameSupabase } from "./supabase-client.js";
import { createHttpServer } from "./http-server.js";
import { RaceRoomRegistry } from "./race-room-registry.js";
import { RivalsState } from "./rivals-state.js";
import { TeamState } from "./team-state.js";
import { TcpNotify } from "./tcp-notify.js";
import { TcpProxy } from "./tcp-proxy.js";
import { TcpServer } from "./tcp-server.js";
import { purgeExpiredSessions } from "./session.js";

const supabase = await createGameSupabase(config, logger);
const raceRoomRegistry = new RaceRoomRegistry();
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
  rivalsState,
  teamState,
  tcpNotify,
  tcpServer,
};

const server = createHttpServer({
  config,
  logger,
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

// Periodic in-process cleanup (rivals: 30 min TTL, teams: 60 min TTL, sessions: 7 day TTL)
setInterval(() => {
  const evictedRivals = rivalsState.cleanup();
  const evictedTeams  = teamState.cleanup();
  if (evictedRivals > 0 || evictedTeams > 0) {
    logger.info("In-process state cleaned up", { evictedRivals, evictedTeams });
  }
}, 15 * 60 * 1000); // every 15 minutes

setInterval(async () => {
  try {
    const deleted = await purgeExpiredSessions({ supabase });
    if (deleted > 0) logger.info("Expired sessions purged", { deleted });
  } catch (err) {
    logger.error("Session purge failed", { error: err.message });
  }
}, 60 * 60 * 1000); // every hour

server.listen(config.port, config.httpHost, () => {
  logger.info("Backend listening", {
    host: config.httpHost,
    port: config.port,
    tcpHost: config.tcpHost,
    tcpPort: config.tcpPort,
    supabase: Boolean(supabase),
  });
});
