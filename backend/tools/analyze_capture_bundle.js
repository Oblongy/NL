import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(repoRoot, "src");

function usage() {
  console.error("Usage: node tools/analyze_capture_bundle.js <bundle-dir-or-zip> [gap-report.md]");
  process.exit(1);
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? "";
    }
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        current += "\"";
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function collectHandlerActions(gameActionsSource) {
  const marker = "const handlers = {";
  const start = gameActionsSource.indexOf(marker);
  const end = gameActionsSource.indexOf("export async function handleGameAction", start);
  if (start === -1 || end === -1) {
    return new Set();
  }

  const block = gameActionsSource.slice(start, end);
  const actions = new Set();
  const regex = /^\s*([a-z0-9]+):/gm;
  let match;
  while ((match = regex.exec(block)) !== null) {
    actions.add(match[1]);
  }
  return actions;
}

function collectTcpHandledMessageTypes(tcpSource) {
  const handled = new Set();
  const regex = /messageType === "([A-Z0-9]+)"/g;
  let match;
  while ((match = regex.exec(tcpSource)) !== null) {
    handled.add(match[1]);
  }
  return handled;
}

function collectTcpSentMessageTypes(tcpSource) {
  const sent = new Set();
  const regex = /"ac",\s*"([A-Z0-9]+)"/g;
  let match;
  while ((match = regex.exec(tcpSource)) !== null) {
    sent.add(match[1]);
  }
  return sent;
}

function extractGapReportSection(reportText, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`## ${escaped}\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`);
  const match = reportText.match(regex);
  return match ? match[1].trim() : "";
}

function collectObservedHttpActions(reportText) {
  const section = extractGapReportSection(reportText, "Observed Surface");
  if (!section) {
    return [];
  }

  const marker = "Main HTTP actions seen:";
  const start = section.indexOf(marker);
  if (start === -1) {
    return [];
  }

  const lines = section
    .slice(start + marker.length)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const actions = [];
  for (const line of lines) {
    if (!line.startsWith("- ")) {
      if (actions.length > 0) {
        break;
      }
      continue;
    }

    const backticked = [...line.matchAll(/`([a-z0-9]+)`/gi)].map((match) => match[1].toLowerCase());
    if (backticked.length > 0) {
      backticked.forEach((value) => actions.push(value));
      continue;
    }

    const match = line.match(/^- ([a-z0-9]+)/i);
    if (match) {
      actions.push(match[1].toLowerCase());
    }
  }

  return [...new Set(actions)];
}

function collectGapReportClaims(reportText, heading) {
  const section = extractGapReportSection(reportText, heading);
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").replace(/`/g, ""));
}

function collectObservedAssetExamples(reportText) {
  const section = extractGapReportSection(reportText, "Definite Static Asset Gaps");
  return section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- /, "").replace(/`/g, ""))
    .filter((line) => line.startsWith("/"));
}

function collectRaceSideMissingClaims(reportText) {
  const section = extractGapReportSection(reportText, "Useful Decoded Examples");
  if (!section.includes("Observed race-side messages missing locally:")) {
    return [];
  }

  const lines = section
    .slice(section.indexOf("Observed race-side messages missing locally:"))
    .split(/\r?\n/)
    .map((line) => line.trim());

  return lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^- (?:client|server) /, "").replace(/`/g, ""))
    .filter(Boolean);
}

function summarizeCounts(rows, direction) {
  return rows
    .filter((row) => row.direction === direction)
    .map((row) => ({
      messageType: row.message_type,
      count: Number(row.count || 0),
    }))
    .sort((left, right) => right.count - left.count || left.messageType.localeCompare(right.messageType));
}

function collectIoHeuristics(tcpSource, countRows) {
  const clientCounts = new Map(summarizeCounts(countRows, "c2s").map((row) => [row.messageType, row.count]));
  const serverCounts = new Map(summarizeCounts(countRows, "s2c").map((row) => [row.messageType, row.count]));
  const hasOpponentOnlyRelay = tcpSource.includes("if (participant.connId === conn.id) continue;");

  const sendInitialMatch = tcpSource.match(/sendInitialIoFrames\(conn\)\s*{[\s\S]*?const frames = \[([\s\S]*?)\];/);
  const initialIoFrameCount = sendInitialMatch ? (sendInitialMatch[1].match(/{/g) || []).length : 0;

  return {
    c2sS: clientCounts.get("S") || 0,
    c2sI: clientCounts.get("I") || 0,
    s2cIo: serverCounts.get("IO") || 0,
    hasOpponentOnlyRelay,
    initialIoFrameCount,
  };
}

function collectHttpRaceSetupRoutes(bundleDir) {
  const filePath = resolve(bundleDir, "wireshark_http_race_setup.csv");
  if (!existsSync(filePath)) {
    return [];
  }
  return parseCsv(readText(filePath));
}

function findGapReport(bundleDir, explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  const inBundle = resolve(bundleDir, "friend_capture_gap_report.md");
  if (existsSync(inBundle)) {
    return inBundle;
  }

  const sibling = resolve(bundleDir, "..", "friend_capture_gap_report.md");
  if (existsSync(sibling)) {
    return sibling;
  }

  return null;
}

function formatList(items) {
  return items.length > 0 ? items.join(", ") : "(none)";
}

function resolveBundleInput(inputPath) {
  const resolvedInput = resolve(inputPath);
  if (!existsSync(resolvedInput)) {
    console.error(`Missing ${resolvedInput}`);
    process.exit(1);
  }

  const inputStats = statSync(resolvedInput);
  if (inputStats.isDirectory()) {
    return {
      bundleDir: resolvedInput,
      cleanup() {},
    };
  }

  if (!inputStats.isFile() || !resolvedInput.toLowerCase().endsWith(".zip")) {
    console.error(`Expected a bundle directory or .zip capture bundle: ${resolvedInput}`);
    process.exit(1);
  }

  const tempRoot = mkdtempSync(resolve(tmpdir(), "nitto-capture-"));
  const extract = spawnSync("tar", ["-xf", resolvedInput, "-C", tempRoot], {
    encoding: "utf8",
  });

  if (extract.status !== 0) {
    console.error(`Failed to extract ${resolvedInput}`);
    if (extract.stderr) {
      console.error(extract.stderr.trim());
    }
    rmSync(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  const entries = readdirSync(tempRoot, { withFileTypes: true });
  const candidateDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => resolve(tempRoot, entry.name));
  const directMatch = candidateDirs.find((candidateDir) =>
    existsSync(resolve(candidateDir, "wireshark_message_counts.csv")),
  );

  const bundleDir = directMatch || (existsSync(resolve(tempRoot, "wireshark_message_counts.csv")) ? tempRoot : null);
  if (!bundleDir) {
    console.error(`Could not locate an extracted bundle inside ${resolvedInput}`);
    rmSync(tempRoot, { recursive: true, force: true });
    process.exit(1);
  }

  return {
    bundleDir,
    cleanup() {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

const bundleInput = process.argv[2] ? resolveBundleInput(process.argv[2]) : null;
const explicitGapReport = process.argv[3] ? resolve(process.argv[3]) : null;

if (!bundleInput) {
  usage();
}

const { bundleDir, cleanup } = bundleInput;

try {
  const messageCountsPath = resolve(bundleDir, "wireshark_message_counts.csv");
  if (!existsSync(messageCountsPath)) {
    console.error(`Missing ${messageCountsPath}`);
    process.exit(1);
  }

  const gapReportPath = findGapReport(bundleDir, explicitGapReport);
  const gapReportText = gapReportPath && existsSync(gapReportPath) ? readText(gapReportPath) : "";

  const gameActionsPath = resolve(sourceRoot, "game-actions.js");
  const tcpServerPath = resolve(sourceRoot, "tcp-server.js");
  const httpServerPath = resolve(sourceRoot, "http-server.js");

  const gameActionsSource = readText(gameActionsPath);
  const tcpSource = readText(tcpServerPath);
  const httpSource = readText(httpServerPath);

  const handlerActions = collectHandlerActions(gameActionsSource);
  const handledTcpTypes = collectTcpHandledMessageTypes(tcpSource);
  const sentTcpTypes = collectTcpSentMessageTypes(tcpSource);
  const messageCounts = parseCsv(readText(messageCountsPath));
  const httpRaceSetup = collectHttpRaceSetupRoutes(bundleDir);
  const observedHttpActions = collectObservedHttpActions(gapReportText);
  const staleHttpClaims = collectGapReportClaims(gapReportText, "Definite HTTP Gaps In Local Server");
  const staleTcpClaims = collectGapReportClaims(gapReportText, "Definite TCP 3724 Gaps");
  const assetExamples = collectObservedAssetExamples(gapReportText);
  const raceSideMissingClaims = collectRaceSideMissingClaims(gapReportText);
  const ioHeuristics = collectIoHeuristics(tcpSource, messageCounts);

  const missingObservedHttpActions = observedHttpActions.filter((action) => !handlerActions.has(action));
  const missingClientTcpTypes = summarizeCounts(messageCounts, "c2s")
    .filter((row) => !handledTcpTypes.has(row.messageType))
    .map((row) => `${row.messageType} (${row.count})`);
  const missingServerTcpTypes = summarizeCounts(messageCounts, "s2c")
    .filter((row) => !sentTcpTypes.has(row.messageType))
    .map((row) => `${row.messageType} (${row.count})`);

  const staleHttpClaimsNowCovered = staleHttpClaims.filter((claim) => {
    const match = claim.match(/^([a-z0-9]+)/i);
    return match ? handlerActions.has(match[1].toLowerCase()) : false;
  });

  const staleTcpClaimsNowCovered = staleTcpClaims.filter((claim) => {
    const match = claim.match(/^observed (?:client|server) ([A-Z0-9]+)/i)
      || claim.match(/^([A-Z0-9]+)/);
    return match ? handledTcpTypes.has(match[1]) || sentTcpTypes.has(match[1]) : false;
  });

  const raceSideClaimsNowCovered = raceSideMissingClaims.filter(
    (messageType) => handledTcpTypes.has(messageType) || sentTcpTypes.has(messageType),
  );

  const hasPathNormalization =
    httpSource.includes(".replace(/\\\\/g, \"/\")") &&
    httpSource.includes(".replace(/\\/+/g, \"/\")");
  const hasAvatarShardSupport =
    /avatarMatch\s*=\s*normalizedPath\.match\(\s*\/\^\\\/\(\?:cache\\\/\)\?avatars/i.test(httpSource) &&
    httpSource.includes("avatarMatch[1]") &&
    httpSource.includes("avatarMatch[2]") &&
    httpSource.includes("avatarMatch[3]");
  const hasTeamAvatarCaseFallback =
    httpSource.includes("teamAvatars") &&
    httpSource.includes("teamavatars");
  const hasFlatAvatarCacheSupport =
    httpSource.includes('resolve(process.cwd(), "../cache/avatars", `${playerId}.jpg`)');

  console.log("Capture Bundle Analysis");
  console.log(`bundle: ${bundleDir}`);
  console.log("analysis_mode: capture-only-reference (does not read backend/fixtures)");
  console.log(`gap_report: ${gapReportPath || "(not found)"}`);
  console.log("");

  console.log("HTTP");
  console.log(`observed_actions_from_capture_report: ${formatList(observedHttpActions)}`);
  console.log(`missing_actions_in_current_code: ${formatList(missingObservedHttpActions)}`);
  if (httpRaceSetup.length > 0) {
    const routes = [...new Set(httpRaceSetup.map((row) => row.path).filter(Boolean))];
    console.log(`race_setup_routes_from_wireshark: ${formatList(routes)}`);
  }
  console.log("");

  console.log("TCP");
  console.log(`observed_client_types_missing_handlers: ${formatList(missingClientTcpTypes)}`);
  console.log(`observed_server_types_missing_emitters: ${formatList(missingServerTcpTypes)}`);
  console.log(
    `telemetry_counts: c2s S=${ioHeuristics.c2sS}, c2s I=${ioHeuristics.c2sI}, s2c IO=${ioHeuristics.s2cIo}, initial_local_io_frames=${ioHeuristics.initialIoFrameCount}`,
  );
  console.log(
    `telemetry_model_review: ${
      ioHeuristics.hasOpponentOnlyRelay && ioHeuristics.s2cIo > ioHeuristics.initialIoFrameCount
        ? "manual-review-needed (current code relays IO only to the opponent connection; live capture shows a long server-originated IO stream)"
        : "no obvious mismatch detected"
    }`,
  );
  console.log("");

  console.log("Static Assets");
  console.log(`observed_asset_examples: ${formatList(assetExamples)}`);
  console.log(
    `path_support_signals: normalize_backslashes=${hasPathNormalization}, avatar_shards=${hasAvatarShardSupport}, flat_avatar_cache=${hasFlatAvatarCacheSupport}, teamavatar_case_fallback=${hasTeamAvatarCaseFallback}`,
  );
  console.log("");

  console.log("Stale Report Checks");
  console.log(`gap_report_http_claims_now_covered: ${formatList(staleHttpClaimsNowCovered)}`);
  console.log(`gap_report_tcp_claims_now_covered: ${formatList(staleTcpClaimsNowCovered)}`);
  console.log(`gap_report_race_side_claims_now_covered: ${formatList(raceSideClaimsNowCovered)}`);
} finally {
  cleanup();
}
