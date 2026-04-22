/**
 * Lightweight in-process metrics.
 *
 * Provides Prometheus-compatible text exposition at GET /metrics.
 * No external dependencies required.
 */

class Counter {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.values = new Map(); // label-string → number
  }

  inc(labels = {}, delta = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + delta);
  }

  collect() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key} ${value}`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  constructor(name, help, collectFn) {
    this.name = name;
    this.help = help;
    this.values = new Map();
    this._collectFn = collectFn || null;
  }

  set(labels = {}, value) {
    this.values.set(labelKey(labels), value);
  }

  inc(labels = {}, delta = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) || 0) + delta);
  }

  dec(labels = {}, delta = 1) {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) || 0) - delta);
  }

  collect() {
    if (this._collectFn) this._collectFn(this);
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key} ${value}`);
    }
    return lines.join("\n");
  }
}

function labelKey(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const inner = entries.map(([k, v]) => `${k}="${v}"`).join(",");
  return `{${inner}}`;
}

// ── Counters ────────────────────────────────────────────────────────────

export const tcpConnectionsTotal = new Counter(
  "nitto_tcp_connections_total",
  "Total TCP connections opened",
);

export const tcpMessagesReceived = new Counter(
  "nitto_tcp_messages_received_total",
  "TCP messages received by type",
);

export const tcpMessagesSent = new Counter(
  "nitto_tcp_messages_sent_total",
  "TCP messages sent",
);

export const tcpErrors = new Counter(
  "nitto_tcp_errors_total",
  "TCP errors by category",
);

export const tcpMalformedFrames = new Counter(
  "nitto_tcp_malformed_frames_total",
  "Malformed TCP frames that failed decode",
);

export const httpRequestsTotal = new Counter(
  "nitto_http_requests_total",
  "HTTP requests by method and path",
);

export const loginAttemptsTotal = new Counter(
  "nitto_login_attempts_total",
  "Login attempts by result",
);

export const uploadsTotal = new Counter(
  "nitto_uploads_total",
  "File uploads by type and result",
);

export const racesStartedTotal = new Counter(
  "nitto_races_started_total",
  "Races started",
);

export const racesCompletedTotal = new Counter(
  "nitto_races_completed_total",
  "Races completed (both players sent RD)",
);

export const cleanupEvictionsTotal = new Counter(
  "nitto_cleanup_evictions_total",
  "Stale state evictions by type",
);

// ── Gauges ──────────────────────────────────────────────────────────────

export const tcpActiveConnections = new Gauge(
  "nitto_tcp_active_connections",
  "Current active TCP connections",
);

export const tcpActiveRaces = new Gauge(
  "nitto_tcp_active_races",
  "Current active races",
);

export const tcpPendingChallenges = new Gauge(
  "nitto_tcp_pending_challenges",
  "Current pending race challenges",
);

// ── Registry ────────────────────────────────────────────────────────────

const allMetrics = [
  tcpConnectionsTotal,
  tcpMessagesReceived,
  tcpMessagesSent,
  tcpErrors,
  tcpMalformedFrames,
  httpRequestsTotal,
  loginAttemptsTotal,
  uploadsTotal,
  racesStartedTotal,
  racesCompletedTotal,
  cleanupEvictionsTotal,
  tcpActiveConnections,
  tcpActiveRaces,
  tcpPendingChallenges,
];

/**
 * Returns all metrics in Prometheus text exposition format.
 */
export function collectMetrics() {
  return allMetrics.map((m) => m.collect()).join("\n\n") + "\n";
}
