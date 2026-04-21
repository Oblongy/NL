import { escapeXml, renderOwnedGarageCars, wrapSuccessData } from "./game-xml.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { buildStaticCarsXml } from "./car-catalog.js";
import {
  PAINT_CATEGORIES_XML as STATIC_PAINT_CATS_XML,
  PAINTS_XML as STATIC_PAINTS_XML,
  PAINT_CATS_FOR_LOC,
  ALL_COLORS,
} from "./paint-catalog-source.js";
import { getClientRoleForPlayer } from "./player-role.js";

// ---------------------------------------------------------------------------
// Static game data - these never change per-player, sourced from game data
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
  "<n id='sclevels'><s>" +
  // Toreno: 0–499 SC (4 sub-stages at 125, 250, 375, 499)
  "<x sc='500' id='Toreno' c='AAAAAA'>" +
    "<x sc='125'/><x sc='250'/><x sc='375'/><x sc='499'/>" +
  "</x>" +
  // Newburge: 500–1999 SC (4 sub-stages evenly spaced)
  "<x sc='2000' id='Newburge' c='66CCFF'>" +
    "<x sc='875'/><x sc='1250'/><x sc='1625'/><x sc='1999'/>" +
  "</x>" +
  // Creek Side: 2000–4999 SC
  "<x sc='5000' id='Creek Side' c='00CC00'>" +
    "<x sc='2750'/><x sc='3500'/><x sc='4250'/><x sc='4999'/>" +
  "</x>" +
  // Vista Heights: 5000–9999 SC
  "<x sc='10000' id='Vista Heights' c='FF8800'>" +
    "<x sc='6250'/><x sc='7500'/><x sc='8750'/><x sc='9999'/>" +
  "</x>" +
  // Diamond Point: 10000+ SC (no upper bound)
  "<x sc='999999999' id='Diamond Point' c='FFD700'>" +
    "<x sc='20000'/><x sc='40000'/><x sc='70000'/><x sc='100000'/>" +
  "</x>" +
  "</s></n>";

const STATIC_LICENSE_PLATES_XML =
  "<n id='getlicenseplates'>" +
  "<p i='1' d='Toreno' c='us' m='0' p='0' vm='500' vp='500' ml='100' ms='0' mc='0'/>" +
  "<p i='2' d='Newburge' c='us' m='1000' p='10' vm='500' vp='500' ml='200' ms='0' mc='0'/>" +
  "<p i='3' d='Creek Side' c='us' m='2500' p='25' vm='1000' vp='1000' ml='300' ms='0' mc='0'/>" +
  "<p i='4' d='Vista Heights' c='us' m='5000' p='50' vm='2000' vp='2000' ml='400' ms='0' mc='0'/>" +
  "<p i='5' d='Diamond Point' c='us' m='10000' p='100' vm='3000' vp='3000' ml='500' ms='0' mc='0'/>" +
  "</n>";

const STATIC_BADGES_XML = "<n id='badges'><b></b></n>";

const STATIC_BANNERS_XML = "<n id='banners'><w></w></n>";

const STATIC_GEARS_XML = "<n id='gears' p='2500' pp='25'/>";

const STATIC_BROADCAST_XML =
  "<n id='broadcast'><w><b i='1' m='Welcome to Nitto Legends!'/></w></n>";

const STATIC_CARS_XML =
  "<n id='cars'>" +
  "<c id='1' c='Acura Integra GSR' l='100'/><c id='6' c='Acura RSX Type-S' l='200'/>" +
  "<c id='28' c='Acura NSX' l='400'/><c id='117' c='AMC Javelin' l='300'/>" +
  "<c id='72' c='Buick Grand National' l='400'/><c id='7' c='Chevy Corvette C6' l='400'/>" +
  "<c id='18' c='Chevy Camaro' l='300'/><c id='52' c='Chevy Cobalt SS' l='200'/>" +
  "<c id='82' c='Chevy C-10' l='200'/><c id='100' c='Chevy Impala SS' l='300'/>" +
  "<c id='46' c='Chevy Camaro SS' l='300'/><c id='48' c='Chevy Camaro SS' l='400'/>" +
  "<c id='83' c='Chevy S-10' l='100'/><c id='10' c='Dodge Viper SRT-10' l='500'/>" +
  "<c id='15' c='Dodge Neon SRT-4' l='200'/><c id='59' c='Dodge Challenger SRT-8' l='400'/>" +
  "<c id='60' c='Dodge Charger SRT-8' l='300'/><c id='63' c='Dodge Challenger R/T' l='300'/>" +
  "<c id='75' c='Dodge Charger R/T' l='300'/><c id='81' c='Dodge Ram SRT-10' l='300'/>" +
  "<c id='97' c='Dodge Charger SRT-8' l='400'/><c id='109' c='Dodge Viper ACR-X' l='500'/>" +
  "<c id='124' c='Dodge Viper' l='500'/><c id='3' c='Ford Mustang GT' l='300'/>" +
  "<c id='5' c='Ford GT' l='500'/><c id='78' c='Ford F-150 SVT Lightning' l='300'/>" +
  "<c id='45' c='Ford SVT Cobra R' l='300'/><c id='68' c='Ford Shelby GT500' l='500'/>" +
  "<c id='127' c='Ford Focus RS' l='300'/><c id='141' c='Ford RS200' l='500'/>" +
  "<c id='143' c='Ford Falcon GT' l='300'/><c id='144' c='Ford Deuce Coupe' l='200'/>" +
  "<c id='149' c='Ford Taurus SHO' l='400'/><c id='138' c='Ford Fiesta ST' l='200'/>" +
  "<c id='8' c='Honda Integra Type R' l='200'/><c id='9' c='Honda S2000' l='300'/>" +
  "<c id='31' c='Honda Civic Si' l='100'/><c id='37' c='Honda Civic Si' l='100'/>" +
  "<c id='44' c='Honda Prelude DOHC VTEC' l='200'/><c id='74' c='Honda CR-X Si' l='100'/>" +
  "<c id='76' c='Honda Civic Si' l='200'/><c id='105' c='Honda Civic Type R' l='200'/>" +
  "<c id='4' c='Infiniti G35 Coupe' l='300'/><c id='51' c='Infiniti G37S' l='400'/>" +
  "<c id='57' c='Mazda Furai' l='200'/><c id='19' c='Mazdaspeed 6 Bergenholtz' l='200'/>" +
  "<c id='23' c='Mazdaspeed 3' l='300'/><c id='142' c='Mazdaspeed 3' l='300'/>" +
  "<c id='24' c='Mazda RX-8' l='300'/><c id='16' c='Mazda RX-7' l='300'/>" +
  "<c id='73' c='Mazda RX-3' l='100'/><c id='107' c='Mazda MX-5 Miata' l='100'/>" +
  "<c id='2' c='Mitsubishi Lancer Evo VIII' l='400'/><c id='87' c='Mitsubishi Lancer Evo X' l='400'/>" +
  "<c id='88' c='Mitsubishi Eclipse GSX' l='200'/><c id='55' c='Nissan 370Z' l='400'/>" +
  "<c id='38' c='Nissan Skyline GT-R' l='400'/><c id='35' c='Nissan 300ZX' l='300'/>" +
  "<c id='47' c='Nissan Sentra SE-R' l='100'/><c id='41' c='Nissan 240SX' l='100'/>" +
  "<c id='25' c='Nissan 350Z' l='300'/><c id='125' c='Nissan Skyline GT-R' l='400'/>" +
  "<c id='106' c='Nissan Cube' l='100'/><c id='21' c='Nissan GT-R' l='400'/>" +
  "<c id='79' c='Plymouth &apos;Cuda' l='300'/><c id='80' c='Plymouth Road Runner' l='400'/>" +
  "<c id='33' c='Pontiac Solstice GXP' l='200'/><c id='43' c='Pontiac GTO' l='300'/>" +
  "<c id='49' c='Pontiac Trans Am' l='300'/><c id='50' c='Pontiac GTO' l='400'/>" +
  "<c id='56' c='Pontiac GTO Judge' l='300'/><c id='85' c='Pontiac Firebird Trans Am' l='300'/>" +
  "<c id='13' c='Scion tC' l='100'/><c id='22' c='Scion xB' l='100'/><c id='95' c='Scion tC' l='100'/>" +
  "<c id='113' c='Scion FR-S' l='300'/><c id='89' c='Subaru Impreza WRX STI' l='400'/>" +
  "<c id='92' c='Subaru Impreza WRX STI' l='400'/><c id='91' c='Subaru Impreza WRX STI' l='400'/>" +
  "<c id='14' c='Toyota Supra' l='400'/><c id='145' c='Toyota Celica GT 2000' l='100'/>" +
  "<c id='61' c='Toyota MR2' l='200'/><c id='65' c='Toyota Celica GT-S' l='200'/>" +
  "<c id='99' c='Toyota Corolla GT-S' l='100'/><c id='122' c='Toyota Starlet' l='100'/>" +
  "<c id='114' c='Toyota MR2 Spyder Widebody' l='200'/><c id='115' c='Toyota MR2 Spyder' l='200'/>" +
  "<c id='58' c='VW Golf R32' l='300'/><c id='62' c='VW Beetle' l='100'/><c id='67' c='VW Golf GTI' l='100'/>" +
  "<c id='64' c='VW Golf GTI' l='200'/><c id='77' c='VW Corrado' l='200'/><c id='84' c='VW Jetta GLI' l='200'/>" +
  "<c id='128' c='Hyundai Genesis Coupe' l='300'/><c id='137' c='Hyundai Veloster Turbo' l='200'/>" +
  "<c id='136' c='Porsche 911 GT3 RS' l='500'/><c id='140' c='Porsche Panamera Turbo' l='500'/>" +
  "<c id='90' c='McLaren MP4-12C' l='500'/></n>";

function renderTestDriveCarNode(testDriveCar) {
  if (!testDriveCar) {
    return "<n id='testdrivecar'/>";
  }

  return `<n id='testdrivecar' acid='${escapeXml(testDriveCar.gameCarId)}' tid='${escapeXml(testDriveCar.invitationId)}' m='${escapeXml(testDriveCar.moneyPrice)}' p='${escapeXml(testDriveCar.pointPrice)}' rh='${escapeXml(testDriveCar.hoursRemaining)}' e='${escapeXml(testDriveCar.expired)}'/>`;
}

function renderImpoundNodes(testDriveCar) {
  return (
    "<n id='impound' p='500' pd='100'/>" +
    "<n id='usedcar' p='0' mp='0' c='0' mc='0' t='0' mt='0'/>" +
    renderTestDriveCarNode(testDriveCar) +
    "<n id='userDecalBans'><b s='0'/></n>"
  );
}

function renderDynoNode(player) {
  const hasDyno = player.has_dyno === 1 || player.has_dyno === true;
  if (hasDyno) {
    return "<n id='dyno'/>";
  }

  return "<n id='dyno' p='500'/>";
}

const STATIC_EMPTY_POLL_XML = "<n id='poll'><s/></n>";

function renderIntroXml(options = {}) {
  const pollXml = options.pollXml || STATIC_EMPTY_POLL_XML;

  return (
    "<n id='intro'>" +
    "<n id='dailyLogin'><s><d a='0'/><d a='0'/><d a='0'/><d a='0'/><d a='0'/><d i=''/></s></n>" +
    "<n id='pwc'><x/></n>" +
    "<n id='banner'><outer><inner/></outer></n>" +
    pollXml +
    "<n id='dailyChallenge'><s>" +
      "<x ct='5' w='3' c='0' et='2027-01-01 23:59:59' tt='0' tr='0' bp='5000' mp='5000' pp='50' ptp='0' eptp='0' sc='100' pn='Daily Win Bonus' imf='' ci='0' pa='500'/>" +
    "</s></n>" +
    "<s/></n>"
  );
}

// ---------------------------------------------------------------------------
// Per-player nodes
// ---------------------------------------------------------------------------

function renderLoginNode(player) {
  const publicId = getPublicIdForPlayer(player);
  const genderValue =
    player.gender === 1 || player.gender === "1" || /^f/i.test(String(player.gender || ""))
      ? 1
      : 0;

  const clientRole = getClientRoleForPlayer(player);

  return (
    "<n id='login'>" +
    `<r u='${escapeXml(player.username)}' i='${publicId}' r='${clientRole}' m='${player.money}' p='${player.points}' ` +
    `sc='${player.score}' im='${player.image_id ?? 0}' act='${player.active ? 1 : 0}' vip='${player.vip ? 1 : 0}' ` +
    `fbc='${player.facebook_connected ? 1 : 0}' alr='1' bpr='1' ` +
    `sr='${player.sponsor_rating}' dt='${escapeXml(player.driver_text || "")}' tn='${escapeXml(player.team_name || "")}' ` +
    `em='' me='' g='${genderValue}' rl='${player.respect_level}' mb='${player.vip ? 1 : 0}' ` +
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
// Main export - fully self-contained, no runtime capture dependency
// ---------------------------------------------------------------------------

export function buildLoginBody(player, cars, _templateBody, sessionKey, logger, options = {}) {
  // Build paint data for the player's current location only (keeps login body small)
  const playerLid = Number(player.location_id || 100);
  const paintCatsXml = "<n id='getpaintcats'><s>" + PAINT_CATS_FOR_LOC(playerLid) + "</s></n>";
  const paintColorsXml = "<n id='getpaints'><s>" + ALL_COLORS.replace(/LOC/g, String(playerLid)) + "</s></n>";

  const ini =
    "<ini>" +
    renderLoginNode(player) +
    STATIC_LOCATIONS_XML +
    STATIC_SCLEVELS_XML +
    STATIC_LICENSE_PLATES_XML +
    paintCatsXml +
    paintColorsXml +
    STATIC_BANNERS_XML +
    renderOwnedCarsNode(cars) +
    renderDynoNode(player) +
    STATIC_BADGES_XML +
    STATIC_GEARS_XML +
    STATIC_BROADCAST_XML +
    buildStaticCarsXml() +
    renderImpoundNodes(options.testDriveCar || null) +
    renderIntroXml({ pollXml: options.pollXml }) +
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
