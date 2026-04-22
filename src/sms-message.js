export function buildSmsMessage({ from = "System", subject = "", body = "" } = {}) {
  return {
    from: String(from),
    subject: String(subject),
    body: String(body),
    createdAt: new Date().toISOString(),
  };
}
