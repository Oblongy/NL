import { escapeXml, renderOwnedGarageCars, wrapSuccessData } from "./game-xml.js";
import { getPublicIdForPlayer } from "./public-id.js";
import { buildStaticCarsXml } from "./car-catalog.js";
import {
  PAINT_CATEGORIES_XML as STATIC_PAINT_CATS_XML,
  PAINTS_XML as STATIC_PAINTS_XML,
} from "./paint-catalog-source.js";

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

const STATIC_BANNERS_XML = "<n id='banners'><w></w></n>";

function renderDynoNode(player) {
  const hasDyno = player.has_dyno === 1 || player.has_dyno === true;
  if (hasDyno) {
    return "<n id='dyno'/>";
  }
  return "<n id='dyno' p='500'/>";
}

const STATIC_GEARS_XML = "<n id='gears' p='0' pp='0'/>";

const STATIC_BROADCAST_XML =
  "<n id='broadcast'><w><b i='1' m='Welcome to Nitto Legends!'/></w></n>";

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

export function buildLoginBody(player, cars, _templateBody, sessionKey, logger, options = {}) {
  const ini =
    "<ini>" +
    renderLoginNode(player) +
    STATIC_LOCATIONS_XML +
    STATIC_SCLEVELS_XML +
    STATIC_LICENSE_PLATES_XML +
    STATIC_PAINT_CATS_XML +
    STATIC_PAINTS_XML +
    STATIC_BANNERS_XML +
    renderOwnedCarsNode(cars) +
    renderDynoNode(player) +
    STATIC_BADGES_XML +
    STATIC_GEARS_XML +
    STATIC_BROADCAST_XML +
    buildStaticCarsXml() +
    renderImpoundNodes(options.testDriveCar || null) +
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
