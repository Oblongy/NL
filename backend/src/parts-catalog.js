import { getFixturePartsCatalogXml, getFixturePartsCategoriesBody } from "./fixture-catalogs.js";

const PART_LOCATIONS = ["100", "200", "300", "400", "500"];

function getAttrValue(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}='([^']*)'`));
  return match ? match[1] : "";
}

function setLocation(attrs, locationId) {
  return /\bl='[^']*'/.test(attrs)
    ? attrs.replace(/\bl='[^']*'/, `l='${locationId}'`)
    : `${attrs} l='${locationId}'`;
}

function rebalancePartNeighborhoods(partsCatalogXml) {
  const sourceXml = String(partsCatalogXml || "");
  const wrapperMatch = sourceXml.match(/^<p>([\s\S]*?)<\/p>$/);
  const innerXml = wrapperMatch ? wrapperMatch[1] : sourceXml;

  const parts = [...innerXml.matchAll(/<p\b([^>]*)\/>/g)].map(([fullMatch, attrs], index) => ({
    fullMatch,
    attrs,
    index,
    groupKey: `${getAttrValue(attrs, "t")}:${getAttrValue(attrs, "pi") || getAttrValue(attrs, "mn") || "misc"}`,
  }));

  if (parts.length === 0) {
    return sourceXml;
  }

  const groups = new Map();
  for (const part of parts) {
    const bucket = groups.get(part.groupKey) || [];
    bucket.push(part);
    groups.set(part.groupKey, bucket);
  }

  const locationCounts = new Map(PART_LOCATIONS.map((locationId) => [locationId, 0]));
  const assignments = new Map();
  let nextPreferredStart = 0;

  const sortedGroups = [...groups.values()].sort((left, right) => {
    if (right.length !== left.length) {
      return right.length - left.length;
    }
    return left[0].index - right[0].index;
  });

  for (const group of sortedGroups) {
    const orderedLocations = [...PART_LOCATIONS].sort((left, right) => {
      const leftCount = locationCounts.get(left);
      const rightCount = locationCounts.get(right);
      if (leftCount !== rightCount) {
        return leftCount - rightCount;
      }

      const leftIndex = PART_LOCATIONS.indexOf(left);
      const rightIndex = PART_LOCATIONS.indexOf(right);
      const leftDistance = (leftIndex - nextPreferredStart + PART_LOCATIONS.length) % PART_LOCATIONS.length;
      const rightDistance = (rightIndex - nextPreferredStart + PART_LOCATIONS.length) % PART_LOCATIONS.length;
      return leftDistance - rightDistance;
    });

    for (let index = 0; index < group.length; index += 1) {
      const locationId = orderedLocations[index % orderedLocations.length];
      assignments.set(group[index].index, locationId);
      locationCounts.set(locationId, locationCounts.get(locationId) + 1);
    }

    nextPreferredStart = (nextPreferredStart + 1) % PART_LOCATIONS.length;
  }

  const rebalancedInnerXml = parts
    .map((part) => `<p${setLocation(part.attrs, assignments.get(part.index))}/>`)
    .join("");

  return wrapperMatch ? `<p>${rebalancedInnerXml}</p>` : rebalancedInnerXml;
}

export const PARTS_CATALOG_XML = rebalancePartNeighborhoods(getFixturePartsCatalogXml());

export const PARTS_CATEGORIES_BODY = getFixturePartsCategoriesBody();
