export function normalizeOwnedPartsXmlValue(value) {
  const partsXml = String(value || "").trim();
  if (!partsXml) {
    return "";
  }

  return partsXml.replace(/<p\b([^>]*)\/>/gi, (fullMatch, rawAttrs) => {
    let attrs = String(rawAttrs || "");

    if (!/\bci=/.test(attrs) && /\bpi=/.test(attrs)) {
      attrs = attrs.replace(/\bpi=/, "ci=");
    }

    if (!/\bpt=/.test(attrs) && /\bt=/.test(attrs)) {
      attrs = attrs.replace(/\bt=/, "pt=");
    }

    return `<p${attrs}/>`;
  });
}
