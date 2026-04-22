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

export const PAINT_CATS_FOR_LOC = (l) =>
  `<c i='-2' l='${l}' p='500' pp='5'>Full car paint job</c><c i='-1' l='${l}' p='500' pp='5'>Body panel specific</c>` +
  `<c i='65' l='${l}' p='500' pp='5'>Spoilers</c>` +
  `<c i='68' l='${l}' p='500' pp='5'>Roof Effect</c>` +
  `<c i='71' l='${l}' p='500' pp='5'>Hoods</c>` +
  `<c i='72' l='${l}' p='500' pp='5'>Hood Center Effect</c>` +
  `<c i='73' l='${l}' p='500' pp='5'>Side Effect</c>` +
  `<c i='74' l='${l}' p='500' pp='5'>Hood Front Effect</c>` +
  `<c i='75' l='${l}' p='500' pp='5'>Eyelids</c>` +
  `<c i='76' l='${l}' p='500' pp='5'>Headlights</c>` +
  `<c i='77' l='${l}' p='500' pp='5'>Tail Lights</c>` +
  `<c i='128' l='${l}' p='500' pp='5'>Front Bumper</c>` +
  `<c i='129' l='${l}' p='500' pp='5'>Side Skirts</c>` +
  `<c i='130' l='${l}' p='500' pp='5'>Rear Bumper</c>` +
  `<c i='140' l='${l}' p='500' pp='5'>Grille</c>` +
  `<c i='141' l='${l}' p='500' pp='5'>C-Pillar Effect</c>` +
  `<c i='142' l='${l}' p='500' pp='5'>Fender Effect</c>` +
  `<c i='143' l='${l}' p='500' pp='5'>Door Effect</c>` +
  `<c i='144' l='${l}' p='500' pp='5'>Trunk</c>` +
  `<c i='174' l='${l}' p='500' pp='5'>Top</c>`;

export const PAINT_CATEGORIES_XML = "<n id='getpaintcats'><s>" +
  PAINT_CATS_FOR_LOC(100) +
  PAINT_CATS_FOR_LOC(200) +
  PAINT_CATS_FOR_LOC(300) +
  PAINT_CATS_FOR_LOC(400) +
  PAINT_CATS_FOR_LOC(500) +
  "</s></n>";

const PAINT_COLOR_DEFS = [
  ["1", "Red", "FF0000"],
  ["2", "Blue", "0000FF"],
  ["3", "Black", "000000"],
  ["4", "White", "FFFFFF"],
  ["5", "Silver", "C0C0C0"],
  ["6", "Yellow", "FFD700"],
  ["7", "Green", "00AA00"],
  ["8", "Orange", "FF6600"],
  ["9", "Purple", "6600CC"],
  ["10", "Pink", "FF69B4"],
  ["11", "Midnight Blue", "191970"],
  ["12", "Burgundy", "800020"],
  ["13", "Gunmetal", "2C3539"],
  ["14", "Lime Green", "32CD32"],
  ["15", "Candy Red", "CC0000"],
  ["16", "Electric Blue", "0033FF"],
  ["17", "Matte Black", "1A1A1A"],
  ["18", "Chrome", "CCCCCC"],
  ["19", "Pearl White", "F5F5F5"],
  ["20", "Teal", "008080"],
  ["21", "Maroon", "800000"],
  ["22", "Gold", "DAA520"],
  ["23", "Burnt Orange", "CC5500"],
  ["24", "Forest Green", "228B22"],
  ["25", "Cobalt Blue", "0047AB"],
  ["26", "Hot Pink", "FF1493"],
  ["27", "Charcoal", "36454F"],
  ["28", "Cream", "FFFDD0"],
  ["29", "Copper", "B87333"],
  ["30", "Violet", "7F00FF"],
];

function renderPaintColorsForCategory(categoryId) {
  return PAINT_COLOR_DEFS
    .map(
      ([id, name, colorCode]) =>
        `<p i='${id}' pi='${categoryId}' ci='${categoryId}' n='${name}' c='${colorCode}' cd='${colorCode}' p='500' pp='5' l='LOC'/>`,
    )
    .join("");
}

export const ALL_COLORS =
  renderPaintColorsForCategory("-2") +
  renderPaintColorsForCategory("-1");

export const PAINTS_XML =
  "<n id='getpaints'><s>" +
  ALL_COLORS.replace(/LOC/g, "100") +
  ALL_COLORS.replace(/LOC/g, "200") +
  ALL_COLORS.replace(/LOC/g, "300") +
  ALL_COLORS.replace(/LOC/g, "400") +
  ALL_COLORS.replace(/LOC/g, "500") +
  "</s></n>";
