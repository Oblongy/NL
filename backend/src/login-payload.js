import { escapeXml, renderOwnedGarageCars, wrapSuccessData } from "./game-xml.js";
import { getPublicIdForPlayer } from "./public-id.js";

const LEGACY_LOGIN_ROLE = 5;

// ---------------------------------------------------------------------------
// Static game data — these never change per-player, sourced from game data
// ---------------------------------------------------------------------------

const STATIC_LOCATIONS_XML =
  "<n id='locations'>" +
  "<loc lid='100' ln='Toreno' f='0' pf='0' r='0' ps='3' sc='0'/>" +
  "<loc lid='200' ln='Newburge' f='10000' pf='100' r='500' ps='5' sc='500'/>" +
  "<loc lid='300' ln='Creek Side' f='50000' pf='500' r='2000' ps='8' sc='2000'/>" +
  "<loc lid='400' ln='Vista Heights' f='150000' pf='1500' r='5000' ps='12' sc='5000'/>" +
  "<loc lid='500' ln='Diamond Point' f='500000' pf='5000' r='10000' ps='20' sc='10000'/>" +
  "</n>";

const STATIC_SCLEVELS_XML =
  "<n id='sclevels'><s><x sc='999999999' id='' c='FFFFFF'/></s></n>";

const STATIC_LICENSE_PLATES_XML =
  "<n id='getlicenseplates'>" +
  "<p i='1' d='Toreno' c='us' m='0' p='0' vm='500' vp='500' ml='100' ms='0' mc='0'/>" +
  "<p i='2' d='Newburge' c='us' m='1000' p='10' vm='500' vp='500' ml='200' ms='0' mc='0'/>" +
  "<p i='3' d='Creek Side' c='us' m='2500' p='25' vm='1000' vp='1000' ml='300' ms='0' mc='0'/>" +
  "<p i='4' d='Vista Heights' c='us' m='5000' p='50' vm='2000' vp='2000' ml='400' ms='0' mc='0'/>" +
  "<p i='5' d='Diamond Point' c='us' m='10000' p='100' vm='3000' vp='3000' ml='500' ms='0' mc='0'/>" +
  "</n>";

const STATIC_BADGES_XML = "<n id='badges'><b></b></n>";

// Paint categories per location tier — sourced directly from game data
const STATIC_PAINT_CATS_XML = "<n id='getpaintcats'><s>" +
  // Toreno (l=100)
  "<c i='-2' l='100' p='500' pp='5'/><c i='-1' l='100' p='500' pp='5'/>" +
  "<c i='65' l='100' p='500' pp='5'>Spoilers</c><c i='68' l='100' p='500' pp='5'>Roof Effect</c>" +
  "<c i='71' l='100' p='500' pp='5'>Hoods</c><c i='72' l='100' p='500' pp='5'>Hood Center Effect</c>" +
  "<c i='73' l='100' p='500' pp='5'>Side Effect</c><c i='74' l='100' p='500' pp='5'>Hood Front Effect</c>" +
  "<c i='75' l='100' p='500' pp='5'>Eyelids</c><c i='76' l='100' p='500' pp='5'>Headlights</c>" +
  "<c i='77' l='100' p='500' pp='5'>Tail Lights</c><c i='128' l='100' p='500' pp='5'>Front Bumper</c>" +
  "<c i='129' l='100' p='500' pp='5'>Side Skirts</c><c i='130' l='100' p='500' pp='5'>Rear Bumper</c>" +
  "<c i='140' l='100' p='500' pp='5'>Grille</c><c i='141' l='100' p='500' pp='5'>C-Pillar Effect</c>" +
  "<c i='142' l='100' p='500' pp='5'>Fender Effect</c><c i='143' l='100' p='500' pp='5'>Door Effect</c>" +
  "<c i='144' l='100' p='500' pp='5'>Trunk</c><c i='174' l='100' p='500' pp='5'>Top</c>" +
  // Newburge (l=200)
  "<c i='-2' l='200' p='1000' pp='10'/><c i='-1' l='200' p='1000' pp='10'/>" +
  "<c i='65' l='200' p='1000' pp='10'>Spoilers</c><c i='68' l='200' p='1000' pp='10'>Roof Effect</c>" +
  "<c i='71' l='200' p='1000' pp='10'>Hoods</c><c i='72' l='200' p='1000' pp='10'>Hood Center Effect</c>" +
  "<c i='73' l='200' p='1000' pp='10'>Side Effect</c><c i='74' l='200' p='1000' pp='10'>Hood Front Effect</c>" +
  "<c i='75' l='200' p='1000' pp='10'>Eyelids</c><c i='76' l='200' p='1000' pp='10'>Headlights</c>" +
  "<c i='77' l='200' p='1000' pp='10'>Tail Lights</c><c i='128' l='200' p='1000' pp='10'>Front Bumper</c>" +
  "<c i='129' l='200' p='1000' pp='10'>Side Skirts</c><c i='130' l='200' p='1000' pp='10'>Rear Bumper</c>" +
  "<c i='140' l='200' p='1000' pp='10'>Grille</c><c i='141' l='200' p='1000' pp='10'>C-Pillar Effect</c>" +
  "<c i='142' l='200' p='1000' pp='10'>Fender Effect</c><c i='143' l='200' p='1000' pp='10'>Door Effect</c>" +
  "<c i='144' l='200' p='1000' pp='10'>Trunk</c><c i='174' l='200' p='1000' pp='10'>Top</c>" +
  // Creek Side (l=300)
  "<c i='-2' l='300' p='1500' pp='15'/><c i='-1' l='300' p='1500' pp='15'/>" +
  "<c i='65' l='300' p='1500' pp='15'>Spoilers</c><c i='68' l='300' p='1500' pp='15'>Roof Effect</c>" +
  "<c i='71' l='300' p='1500' pp='15'>Hoods</c><c i='72' l='300' p='1500' pp='15'>Hood Center Effect</c>" +
  "<c i='73' l='300' p='1500' pp='15'>Side Effect</c><c i='74' l='300' p='1500' pp='15'>Hood Front Effect</c>" +
  "<c i='75' l='300' p='1500' pp='15'>Eyelids</c><c i='76' l='300' p='1500' pp='15'>Headlights</c>" +
  "<c i='77' l='300' p='1500' pp='15'>Tail Lights</c><c i='128' l='300' p='1500' pp='15'>Front Bumper</c>" +
  "<c i='129' l='300' p='1500' pp='15'>Side Skirts</c><c i='130' l='300' p='1500' pp='15'>Rear Bumper</c>" +
  "<c i='140' l='300' p='1500' pp='15'>Grille</c><c i='141' l='300' p='1500' pp='15'>C-Pillar Effect</c>" +
  "<c i='142' l='300' p='1500' pp='15'>Fender Effect</c><c i='143' l='300' p='1500' pp='15'>Door Effect</c>" +
  "<c i='144' l='300' p='1500' pp='15'>Trunk</c><c i='174' l='300' p='1500' pp='15'>Top</c>" +
  // Vista Heights (l=400)
  "<c i='-2' l='400' p='2500' pp='25'/><c i='-1' l='400' p='2500' pp='25'/>" +
  "<c i='65' l='400' p='2500' pp='25'>Spoilers</c><c i='68' l='400' p='2500' pp='25'>Roof Effect</c>" +
  "<c i='71' l='400' p='2500' pp='25'>Hoods</c><c i='72' l='400' p='2500' pp='25'>Hood Center Effect</c>" +
  "<c i='73' l='400' p='2500' pp='25'>Side Effect</c><c i='74' l='400' p='2500' pp='25'>Hood Front Effect</c>" +
  "<c i='75' l='400' p='2500' pp='25'>Eyelids</c><c i='76' l='400' p='2500' pp='25'>Headlights</c>" +
  "<c i='77' l='400' p='2500' pp='25'>Tail Lights</c><c i='128' l='400' p='2500' pp='25'>Front Bumper</c>" +
  "<c i='129' l='400' p='2500' pp='25'>Side Skirts</c><c i='130' l='400' p='2500' pp='25'>Rear Bumper</c>" +
  "<c i='140' l='400' p='2500' pp='25'>Grille</c><c i='141' l='400' p='2500' pp='25'>C-Pillar Effect</c>" +
  "<c i='142' l='400' p='2500' pp='25'>Fender Effect</c><c i='143' l='400' p='2500' pp='25'>Door Effect</c>" +
  "<c i='144' l='400' p='2500' pp='25'>Trunk</c><c i='174' l='400' p='2500' pp='25'>Top</c>" +
  // Diamond Point (l=500)
  "<c i='-2' l='500' p='5000' pp='50'/><c i='-1' l='500' p='5000' pp='50'/>" +
  "<c i='65' l='500' p='5000' pp='50'>Spoilers</c><c i='68' l='500' p='5000' pp='50'>Roof Effect</c>" +
  "<c i='71' l='500' p='5000' pp='50'>Hoods</c><c i='72' l='500' p='5000' pp='50'>Hood Center Effect</c>" +
  "<c i='73' l='500' p='5000' pp='50'>Side Effect</c><c i='74' l='500' p='5000' pp='50'>Hood Front Effect</c>" +
  "<c i='75' l='500' p='5000' pp='50'>Eyelids</c><c i='76' l='500' p='5000' pp='50'>Headlights</c>" +
  "<c i='77' l='500' p='5000' pp='50'>Tail Lights</c><c i='128' l='500' p='5000' pp='50'>Front Bumper</c>" +
  "<c i='129' l='500' p='5000' pp='50'>Side Skirts</c><c i='130' l='500' p='5000' pp='50'>Rear Bumper</c>" +
  "<c i='140' l='500' p='5000' pp='50'>Grille</c><c i='141' l='500' p='5000' pp='50'>C-Pillar Effect</c>" +
  "<c i='142' l='500' p='5000' pp='50'>Fender Effect</c><c i='143' l='500' p='5000' pp='50'>Door Effect</c>" +
  "<c i='144' l='500' p='5000' pp='50'>Trunk</c><c i='174' l='500' p='5000' pp='50'>Top</c>" +
  "</s></n>";

const STATIC_IMPOUND_XML =
  "<n id='impound' p='500' pd='100'/>" +
  "<n id='usedcar' p='0' mp='0' c='0' mc='0' t='0' mt='0'/>" +
  "<n id='testdrivecar'/>" +
  "<n id='userDecalBans'><b s='0'/></n>";

const STATIC_INTRO_XML =
  "<n id='intro'>" +
  "<n id='dailyLogin'><s><d a='0'/><d a='0'/><d a='0'/><d a='0'/><d a='0'/><d i=''/></s></n>" +
  "<n id='pwc'><x/></n>" +
  "<n id='banner'><outer><inner/></outer></n>" +
  "<n id='poll'><s/></n>" +
  "<n id='dailyChallenge'><s><x ct='0' w='0' c='0' et='' tt='0' tr='0' bp='0' mp='0' pp='0' ptp='0' eptp='0' sc='0' pn='' imf='' ci='0' pa='0'/></s></n>" +
  "<s/></n>";

// ---------------------------------------------------------------------------
// Per-player nodes
// ---------------------------------------------------------------------------

function renderLoginNode(player) {
  const publicId = getPublicIdForPlayer(player);
  const genderValue =
    player.gender === 1 || player.gender === "1" || /^f/i.test(String(player.gender || ""))
      ? 1
      : 0;

  return (
    "<n id='login'>" +
    `<r u='${escapeXml(player.username)}' i='${publicId}' r='${LEGACY_LOGIN_ROLE}' m='${player.money}' p='${player.points}' ` +
    `sc='${player.score}' im='${player.image_id ?? 0}' act='${player.active}' vip='${player.vip}' ` +
    `fbc='${player.facebook_connected}' alr='${player.alert_flag}' bpr='${player.blackcard_progress}' ` +
    `sr='${player.sponsor_rating}' dt='${escapeXml(player.driver_text || "")}' tn='${escapeXml(player.team_name || "")}' ` +
    `em='' me='' g='${genderValue}' rl='${player.respect_level}' mb='${player.message_badge}' ` +
    `ti='${player.title_id}' tr='${player.track_rank}' lid='${player.location_id}' ` +
    `bg='${player.background_id}' dc='${player.default_car_game_id || 0}'/>` +
    "</n>"
  );
}

function renderOwnedCarsNode(cars) {
  return `<n id='getallcars'>${renderOwnedGarageCars(cars)}</n>`;
}

// ---------------------------------------------------------------------------
// Tail (session tokens after the XML)
// ---------------------------------------------------------------------------

function buildLoginTail(player, sessionKey) {
  const publicId = getPublicIdForPlayer(player);
  return `, "aid", ${publicId}, "guid", "${escapeXml(sessionKey)}", "at", 0, "am", 0, "cp", "none", "cw", "none", "cwc", "none"`;
}

// ---------------------------------------------------------------------------
// Main export — fully self-contained, no fixture dependency
// ---------------------------------------------------------------------------

export function buildLoginBody(player, cars, _templateBody, sessionKey, logger) {
  const ini =
    "<ini>" +
    renderLoginNode(player) +
    STATIC_LOCATIONS_XML +
    STATIC_SCLEVELS_XML +
    STATIC_LICENSE_PLATES_XML +
    STATIC_BADGES_XML +
    renderOwnedCarsNode(cars) +
    STATIC_PAINT_CATS_XML +
    STATIC_IMPOUND_XML +
    STATIC_INTRO_XML +
    "</ini>";

  const body = `"s", 1, "d", "${ini}"` + buildLoginTail(player, sessionKey);

  if (logger) {
    logger.info("buildLoginBody", {
      bodyLength: body.length,
      carsCount: cars.length,
      playerPublicId: getPublicIdForPlayer(player),
    });
  }

  return body;
}
