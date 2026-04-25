export const COLOR_TO_PAINT_ID = Object.freeze({
  FF0000: "1",
  "0000FF": "2",
  "000000": "3",
  FFFFFF: "4",
  C0C0C0: "5",
  FFD700: "6",
  "00AA00": "7",
  FF6600: "8",
  "6600CC": "9",
  FF69B4: "10",
  "191970": "11",
  "800020": "12",
  "2C3539": "13",
  "32CD32": "14",
  CC0000: "15",
  "0033FF": "16",
  "1A1A1A": "17",
  CCCCCC: "18",
  F5F5F5: "19",
  "008080": "20",
  "800000": "21",
  DAA520: "22",
  CC5500: "23",
  "228B22": "24",
  "0047AB": "25",
  FF1493: "26",
  "36454F": "27",
  FFFDD0: "28",
  B87333: "29",
  "7F00FF": "30",
});

export function getPaintIdForColorCode(colorCode) {
  const normalized = String(colorCode || "")
    .replace(/[^0-9A-F]/gi, "")
    .toUpperCase()
    .slice(0, 6);
  return COLOR_TO_PAINT_ID[normalized] || "5";
}

const PAINT_PRICE_BY_LOCATION = Object.freeze({
  100: { price: 500, pointsPrice: 5 },
  200: { price: 1000, pointsPrice: 10 },
  300: { price: 1500, pointsPrice: 15 },
  400: { price: 2500, pointsPrice: 25 },
  500: { price: 5000, pointsPrice: 50 },
});

function normalizePaintLocationId(locationId) {
  const numericLocationId = Number(locationId || 100);
  if (numericLocationId >= 500) {
    return 500;
  }
  if (numericLocationId >= 400) {
    return 400;
  }
  if (numericLocationId >= 300) {
    return 300;
  }
  if (numericLocationId >= 200) {
    return 200;
  }
  return 100;
}

function getPaintPriceForLocation(locationId) {
  return PAINT_PRICE_BY_LOCATION[normalizePaintLocationId(locationId)] || PAINT_PRICE_BY_LOCATION[100];
}

export const PAINT_CATS_FOR_LOC = (l) =>
  (() => {
    const { price, pointsPrice } = getPaintPriceForLocation(l);
    return `<c i='-2' l='${l}' p='${price}' pp='${pointsPrice}'/><c i='-1' l='${l}' p='${price}' pp='${pointsPrice}'/>` +
      `<c i='65' l='${l}' p='${price}' pp='${pointsPrice}'>Spoilers</c>` +
      `<c i='68' l='${l}' p='${price}' pp='${pointsPrice}'>Roof Effect</c>` +
      `<c i='71' l='${l}' p='${price}' pp='${pointsPrice}'>Hoods</c>` +
      `<c i='72' l='${l}' p='${price}' pp='${pointsPrice}'>Hood Center Effect</c>` +
      `<c i='73' l='${l}' p='${price}' pp='${pointsPrice}'>Side Effect</c>` +
      `<c i='74' l='${l}' p='${price}' pp='${pointsPrice}'>Hood Front Effect</c>` +
      `<c i='75' l='${l}' p='${price}' pp='${pointsPrice}'>Eyelids</c>` +
      `<c i='76' l='${l}' p='${price}' pp='${pointsPrice}'>Headlights</c>` +
      `<c i='77' l='${l}' p='${price}' pp='${pointsPrice}'>Tail Lights</c>` +
      `<c i='128' l='${l}' p='${price}' pp='${pointsPrice}'>Front Bumper</c>` +
      `<c i='129' l='${l}' p='${price}' pp='${pointsPrice}'>Side Skirts</c>` +
      `<c i='130' l='${l}' p='${price}' pp='${pointsPrice}'>Rear Bumper</c>` +
      `<c i='140' l='${l}' p='${price}' pp='${pointsPrice}'>Grille</c>` +
      `<c i='141' l='${l}' p='${price}' pp='${pointsPrice}'>C-Pillar Effect</c>` +
      `<c i='142' l='${l}' p='${price}' pp='${pointsPrice}'>Fender Effect</c>` +
      `<c i='143' l='${l}' p='${price}' pp='${pointsPrice}'>Door Effect</c>` +
      `<c i='144' l='${l}' p='${price}' pp='${pointsPrice}'>Trunk</c>` +
      `<c i='174' l='${l}' p='${price}' pp='${pointsPrice}'>Top</c>`;
  })();

export const PAINT_CATEGORIES_XML = "<n id='getpaintcats'><s>" +
  PAINT_CATS_FOR_LOC(100) +
  PAINT_CATS_FOR_LOC(200) +
  PAINT_CATS_FOR_LOC(300) +
  PAINT_CATS_FOR_LOC(400) +
  PAINT_CATS_FOR_LOC(500) +
  "</s></n>";

const PAINT_COLOR_DEFS = [
  ["1", "Red", "FF0000", 100],
  ["2", "Blue", "0000FF", 100],
  ["3", "Black", "000000", 100],
  ["4", "White", "FFFFFF", 100],
  ["5", "Silver", "C0C0C0", 100],
  ["7", "Green", "00AA00", 100],
  ["6", "Yellow", "FFD700", 200],
  ["8", "Orange", "FF6600", 200],
  ["9", "Purple", "6600CC", 200],
  ["10", "Pink", "FF69B4", 200],
  ["14", "Lime Green", "32CD32", 200],
  ["11", "Midnight Blue", "191970", 300],
  ["12", "Burgundy", "800020", 300],
  ["13", "Gunmetal", "2C3539", 300],
  ["19", "Pearl White", "F5F5F5", 400],
  ["15", "Candy Red", "CC0000", 400],
  ["16", "Electric Blue", "0033FF", 400],
  ["17", "Matte Black", "1A1A1A", 500],
  ["18", "Chrome", "CCCCCC", 500],
];

function renderPaintColorsForCategory(categoryId, locationId) {
  const normalizedLocationId = normalizePaintLocationId(locationId);
  const { price } = getPaintPriceForLocation(normalizedLocationId);
  return PAINT_COLOR_DEFS
    .filter(([, , , requiredLocationId]) => normalizedLocationId >= requiredLocationId)
    .map(
      ([id, name, colorCode]) =>
        `<p i='${id}' ci='${categoryId}' n='${name}' c='${colorCode}' p='${price}' l='${normalizedLocationId}'/>`,
    )
    .join("");
}

export function getPaintColorsForLocation(locationId) {
  const normalizedLocationId = normalizePaintLocationId(locationId);
  return renderPaintColorsForCategory("-2", normalizedLocationId);
}

export const PAINTS_XML =
  "<n id='getpaints'><s>" +
  getPaintColorsForLocation(100) +
  getPaintColorsForLocation(200) +
  getPaintColorsForLocation(300) +
  getPaintColorsForLocation(400) +
  getPaintColorsForLocation(500) +
  "</s></n>";
