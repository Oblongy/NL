const PART_XML_ENTRY_REGEX = /<p\b[^>]*\/>/g;
const PART_XML_ATTR_REGEX = /(\w+)=['"]([^'"]*)['"]/g;

function parseXmlAttributes(rawEntry) {
  const attrs = {};
  let match;
  while ((match = PART_XML_ATTR_REGEX.exec(String(rawEntry || ""))) !== null) {
    attrs[match[1]] = match[2];
  }
  PART_XML_ATTR_REGEX.lastIndex = 0;
  return attrs;
}

function listInstalledPartEntries(partsXml) {
  const entries = [];
  let match;
  while ((match = PART_XML_ENTRY_REGEX.exec(String(partsXml || ""))) !== null) {
    entries.push({
      raw: match[0],
      attrs: parseXmlAttributes(match[0]),
    });
  }
  PART_XML_ENTRY_REGEX.lastIndex = 0;
  return entries;
}

function isInstalledEnginePart(attrs = {}) {
  const partType = String(attrs.pt || attrs.t || "").toLowerCase();
  const installedFlag = String(attrs.in ?? "1");
  return (partType === "e" || partType === "m") && installedFlag !== "0";
}

function toMetricValue(value) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

export function summarizeInstalledEnginePartStats(partsXml) {
  let horsepower = 0;
  let torque = 0;
  let weight = 0;

  for (const { attrs } of listInstalledPartEntries(partsXml)) {
    if (!isInstalledEnginePart(attrs)) {
      continue;
    }
    horsepower += toMetricValue(attrs.hp);
    torque += toMetricValue(attrs.tq);
    weight += toMetricValue(attrs.wt);
  }

  return {
    horsepower,
    torque,
    weight,
  };
}
