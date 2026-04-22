import { getPaintIdForColorCode } from "./paint-catalog-source.js";

export function normalizeOwnedPartsXmlValue(value) {
  const partsXml = String(value || "").trim();
  if (!partsXml) {
    return "";
  }

  return partsXml.replace(/<p\b([^>]*)\/>/gi, (fullMatch, rawAttrs) => {
    let attrs = String(rawAttrs || "");

    // Normalize double-quoted attributes to single quotes for safe embedding
    attrs = attrs.replace(/(\w+)="([^"]*)"/g, "$1='$2'");

    if (/\bcd=/.test(attrs) && !/\bi=/.test(attrs)) {
      const paintColorMatch = attrs.match(/\bcd='([^']*)'/i);
      if (paintColorMatch) {
        attrs = ` i='${getPaintIdForColorCode(paintColorMatch[1])}'${attrs}`;
      }
    }

    const slotMatch = attrs.match(/\b(?:ci|pi)='([^']*)'/i);
    if (slotMatch) {
      if (!/\bci=/.test(attrs)) {
        attrs += ` ci='${slotMatch[1]}'`;
      }
      if (!/\bpi=/.test(attrs)) {
        attrs += ` pi='${slotMatch[1]}'`;
      }
    }

    const partTypeMatch = attrs.match(/\b(?:pt|t)='([^']*)'/i);
    if (partTypeMatch) {
      if (!/\bpt=/.test(attrs)) {
        attrs += ` pt='${partTypeMatch[1]}'`;
      }
      if (!/\bt=/.test(attrs)) {
        attrs += ` t='${partTypeMatch[1]}'`;
      }
    }

    return `<p${attrs}/>`;
  });
}
