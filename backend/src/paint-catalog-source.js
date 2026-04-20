export const PAINT_CATS_FOR_LOC = (l) =>
  `<c i='-2' l='${l}' p='500' pp='5'/><c i='-1' l='${l}' p='500' pp='5'/>` +
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

export const ALL_COLORS =
  "<p i='1' ci='-2' n='Red' c='FF0000' p='500' l='LOC'/>" +
  "<p i='2' ci='-2' n='Blue' c='0000FF' p='500' l='LOC'/>" +
  "<p i='3' ci='-2' n='Black' c='000000' p='500' l='LOC'/>" +
  "<p i='4' ci='-2' n='White' c='FFFFFF' p='500' l='LOC'/>" +
  "<p i='5' ci='-2' n='Silver' c='C0C0C0' p='500' l='LOC'/>" +
  "<p i='6' ci='-2' n='Yellow' c='FFD700' p='500' l='LOC'/>" +
  "<p i='7' ci='-2' n='Green' c='00AA00' p='500' l='LOC'/>" +
  "<p i='8' ci='-2' n='Orange' c='FF6600' p='500' l='LOC'/>" +
  "<p i='9' ci='-2' n='Purple' c='6600CC' p='500' l='LOC'/>" +
  "<p i='10' ci='-2' n='Pink' c='FF69B4' p='500' l='LOC'/>" +
  "<p i='11' ci='-2' n='Midnight Blue' c='191970' p='500' l='LOC'/>" +
  "<p i='12' ci='-2' n='Burgundy' c='800020' p='500' l='LOC'/>" +
  "<p i='13' ci='-2' n='Gunmetal' c='2C3539' p='500' l='LOC'/>" +
  "<p i='14' ci='-2' n='Lime Green' c='32CD32' p='500' l='LOC'/>" +
  "<p i='15' ci='-2' n='Candy Red' c='CC0000' p='500' l='LOC'/>" +
  "<p i='16' ci='-2' n='Electric Blue' c='0033FF' p='500' l='LOC'/>" +
  "<p i='17' ci='-2' n='Matte Black' c='1A1A1A' p='500' l='LOC'/>" +
  "<p i='18' ci='-2' n='Chrome' c='CCCCCC' p='500' l='LOC'/>" +
  "<p i='19' ci='-2' n='Pearl White' c='F5F5F5' p='500' l='LOC'/>" +
  "<p i='20' ci='-2' n='Teal' c='008080' p='500' l='LOC'/>" +
  "<p i='21' ci='-2' n='Maroon' c='800000' p='500' l='LOC'/>" +
  "<p i='22' ci='-2' n='Gold' c='DAA520' p='500' l='LOC'/>" +
  "<p i='23' ci='-2' n='Burnt Orange' c='CC5500' p='500' l='LOC'/>" +
  "<p i='24' ci='-2' n='Forest Green' c='228B22' p='500' l='LOC'/>" +
  "<p i='25' ci='-2' n='Cobalt Blue' c='0047AB' p='500' l='LOC'/>" +
  "<p i='26' ci='-2' n='Hot Pink' c='FF1493' p='500' l='LOC'/>" +
  "<p i='27' ci='-2' n='Charcoal' c='36454F' p='500' l='LOC'/>" +
  "<p i='28' ci='-2' n='Cream' c='FFFDD0' p='500' l='LOC'/>" +
  "<p i='29' ci='-2' n='Copper' c='B87333' p='500' l='LOC'/>" +
  "<p i='30' ci='-2' n='Violet' c='7F00FF' p='500' l='LOC'/>";

export const PAINTS_XML =
  "<n id='getpaints'><s>" +
  ALL_COLORS.replace(/LOC/g, "100") +
  ALL_COLORS.replace(/LOC/g, "200") +
  ALL_COLORS.replace(/LOC/g, "300") +
  ALL_COLORS.replace(/LOC/g, "400") +
  ALL_COLORS.replace(/LOC/g, "500") +
  "</s></n>";
