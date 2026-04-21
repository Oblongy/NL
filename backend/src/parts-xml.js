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

    return `<p${attrs}/>`;
  });
}
