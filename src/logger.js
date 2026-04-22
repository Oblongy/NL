function stamp() {
  return new Date().toISOString();
}

function write(level, message, extra) {
  const parts = [`[${stamp()}]`, `[${level}]`, message];
  if (extra !== undefined) {
    parts.push(typeof extra === "string" ? extra : JSON.stringify(extra));
  }
  console.log(parts.join(" "));
}

export const logger = {
  info(message, extra) {
    write("info", message, extra);
  },
  warn(message, extra) {
    write("warn", message, extra);
  },
  error(message, extra) {
    write("error", message, extra);
  },
};
