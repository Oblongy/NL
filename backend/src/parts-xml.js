export function normalizeOwnedPartsXmlValue(value) {
  const partsXml = String(value || "").trim();
  if (!partsXml) {
    return "";
  }

  return partsXml.replace(/<p\b([^>]*)\/>/gi, (fullMatch, rawAttrs) => {
    let attrs = String(rawAttrs || "");

    // Normalize double-quoted attributes to single quotes for safe embedding
    attrs = attrs.replace(/(\w+)="([^"]*)"/g, "$1='$2'");

    if (!/\bci=/.test(attrs) && /\bpi=/.test(attrs)) {
      attrs = attrs.replace(/\bpi=/, "ci=");
    }

    if (!/\bpt=/.test(attrs) && /\bt=/.test(attrs)) {
      attrs = attrs.replace(/\bt=/, "pt=");
    }

    return `<p${attrs}/>`;
  });
}
