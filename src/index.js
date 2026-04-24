import { config } from "./config.js";
import { logger } from "./logger.js";
import { createGameSupabase } from "./supabase-client.js";
import { checkSupabaseHealth } from "./supabase-health.js";
import { purgeExpiredSessions } from "./session.js";
import { createHttpServer } from "./http-server.js";
import { RaceRoomRegistry } from "./race-room-registry.js";
import { RaceManager } from "./race-manager.js";
import { RivalsState } from "./rivals-state.js";
import { TeamState } from "./team-state.js";
import { createHomePollState } from "./home-poll-state.js";
import { TcpNotify } from "./tcp-notify.js";
import { TcpProxy } from "./tcp-proxy.js";
import { TcpServer } from "./tcp-server.js";
import { logShowroomSpecCoverage } from "./showroom-spec-audit.js";
import { createApiRouter } from "./api-routes.js";
import { createWsServer } from "./ws-server.js";

const supabase = await createGameSupabase(config, logger);
// Startup health check for Supabase when credentials are provided.
if (config.supabaseUrl) {
  const health = await checkSupabaseHealth({ supabase, logger });
  if (!health.ok) {
    logger.error("Critical Supabase health check failed; exiting.");
    process.exit(1);
  } else {
    logger.info("Supabase health check passed");
  }
} else {
  logger.info("Supabase not configured; running in local/fixture mode");
}
logShowroomSpecCoverage(logger);
const raceRoomRegistry = new RaceRoomRegistry();
const rivalsState = new RivalsState();
const teamState = new TeamState();
const homePollState = createHomePollState({ logger });
const tcpProxy = new TcpProxy({ logger });

// Create TCP server first
const tcpServer = new TcpServer({ 
  logger, 
  notify: null, // Will be set after tcpNotify is created
  proxy: tcpProxy,
  supabase,
  raceRoomRegistry,
  port: config.tcpPort,
  host: config.tcpHost,
});

// Create race manager with tcpServer reference
const raceManager = new RaceManager(tcpServer);

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
  homePollState,
  tcpNotify,
  tcpServer,
};

const server = createHttpServer({
  config,
  logger,
  supabase,
  services: {
    raceRoomRegistry,
    raceManager,
    rivalsState,
    teamState,
    homePollState,
    tcpNotify,
    tcpProxy,
    tcpServer,
  },
});

// Mount the custom-client JSON API router additively.
// The apiRouter calls next() for non-/api/* paths so the existing handler takes over.
const jwtSecret = process.env.JWT_SECRET || config.jwtSecret || "change-me-in-production";
const apiRouter = createApiRouter({
  supabase,
  logger,
  services: {
    raceRoomRegistry,
    raceManager,
    rivalsState,
    teamState,
    homePollState,
    tcpNotify,
    tcpProxy,
    tcpServer,
  },
  jwtSecret,
});

// Wrap the server's request listener so apiRouter runs first.
const originalListeners = server.listeners("request");
server.removeAllListeners("request");
server.on("request", async (req, res) => {
  await apiRouter(req, res, () => {
    for (const listener of originalListeners) {
      listener.call(server, req, res);
    }
  });
});

// Attach the WebSocket server for the custom client.
createWsServer(server, { tcpServer, logger }, jwtSecret);

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
    useFixtures: config.useFixtures,
    supabase: Boolean(supabase),
  });
});
