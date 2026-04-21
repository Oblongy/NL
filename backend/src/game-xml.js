import { getClientRoleForPlayer } from "./player-role.js";
import { renderVisibleBadgesXml } from "./profile-badges.js";
import { normalizeOwnedPartsXmlValue } from "./parts-xml.js";
import {
  DEFAULT_COLOR_CODE,
  DEFAULT_PAINT_INDEX,
  getDefaultShowroomPartsXmlForCar,
  getDefaultWheelXmlForCar,
  normalizeOwnedWheelXmlValue,
} from "./car-defaults.js";
import { getCarEngineIdentity } from "./car-engine-state.js";
import { getPaintIdForColorCode } from "./paint-catalog-source.js";

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attrsToString(attrs) {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}='${escapeXml(value)}'`)
    .join(" ");
}

export function wrapSuccessData(xml) {
  return `"s", 1, "d", "${xml}"`;
}

export function failureBody() {
  return `"s", 0`;
}

function renderUserSummaryNode(player, options = {}) {
  const publicId = options.publicId ?? player.id;
  const attrs = {
    i: publicId,
    u: player.username,
    r: getClientRoleForPlayer(player),
    sc: player.score,
    ti: player.title_id,
  };
  
  // Only include team_name if player is actually on a team
  if (player.team_id || (player.team_name && player.team_name !== '')) {
    attrs.tn = player.team_name;
  }
  
  const attrsStr = attrsToString(attrs);
  const badgesXml = renderVisibleBadgesXml(player);

  if (!badgesXml) {
    return `<p ${attrsStr}/>`;
  }

  return `<p ${attrsStr}>${badgesXml}</p>`;
}

export function renderUserSummary(player, options = {}) {
  return `<u>${renderUserSummaryNode(player, options)}</u>`;
}

export function renderUserSummaries(players, optionsByPlayerId = new Map()) {
  const body = players.map((player) => {
    const key = Number(player?.id || 0);
    const options = optionsByPlayerId instanceof Map ? (optionsByPlayerId.get(key) || {}) : {};
    return renderUserSummaryNode(player, options);
  }).join("");

  return `<u>${body}</u>`;
}

function normalizeWheelXml(car) {
  return normalizeOwnedWheelXmlValue(car.wheel_xml, car.catalog_car_id);
}

function normalizePartsXml(car) {
  return normalizeOwnedPartsXmlValue(car.parts_xml);
}

function normalizeColorCode(value) {
  return String(value || DEFAULT_COLOR_CODE).replace(/[^0-9A-F]/gi, "").toUpperCase() || DEFAULT_COLOR_CODE;
}

function resolvePaintIdForCar(car) {
  return getPaintIdForColorCode(normalizeColorCode(car?.color_code));
}

function renderFallbackWheelPartXml(car, wheelXml, partsXml) {
  if (/\b(?:ci|pi)='14'\b/i.test(partsXml)) {
    return "";
  }

  const wheelMatch = String(wheelXml || "").match(/<w\b[^>]*\bwid='([^']*)'[^>]*\bid='([^']*)'[^>]*\bws='([^']*)'[^>]*\/?>/i);
  if (!wheelMatch) {
    return "";
  }

  const [, wid, wheelPartId, wheelSize] = wheelMatch;
  const normalizedWheelSize = String(wheelSize || "").replace(/[^0-9]/g, "") || "17";
  const normalizedWheelId = String(wid || "").replace(/[^0-9]/g, "") || "1";
  const normalizedPartId = String(wheelPartId || "").replace(/[^0-9]/g, "") || "1000";
  const isStockWheel = normalizedPartId === "1000" || normalizedWheelId === "1";
  const isFactoryWheel = normalizedPartId === "1003" || normalizedWheelId === "2";
  const partName = isStockWheel
    ? `Stock ${normalizedWheelSize}&quot;`
    : isFactoryWheel
    ? `Factory ${normalizedWheelSize}&quot;`
    : `Wheel ${normalizedWheelId} ${normalizedWheelSize}&quot;`;
  const partDesignId = isStockWheel
    ? "1"
    : isFactoryWheel
    ? "2"
    : normalizedWheelId;

  return `<p i='${normalizedPartId}' ci='14' pi='14' n='${partName}' in='1' cc='' pdi='${partDesignId}' di='${normalizedWheelId}' pt='c' t='c' ps='${normalizedWheelSize}'/>`;
}

function renderFallbackPaintStateXml(car, partsXml) {
  if (/<ps[\s>]/i.test(partsXml)) {
    return "";
  }

  const colorCode = normalizeColorCode(car.color_code);
  const paintId = resolvePaintIdForCar(car);

  // Include both paint ID and color code for compatibility
  return `<ps><p i='${paintId}' cd='${colorCode}'/></ps>`;
}

function renderCarBody(car) {
  const wheelXml = normalizeWheelXml(car);
  const partsXml = normalizePartsXml(car);
  const wheelPartXml = renderFallbackWheelPartXml(car, wheelXml, partsXml);
  const paintStateXml = renderFallbackPaintStateXml(car, partsXml);
  return `${wheelXml}${wheelPartXml}${partsXml}${paintStateXml}`;
}

function retagInstalledShowroomParts(xml) {
  return String(xml || "").replace(/<p\b([^>]*\bin='1'[^>]*)\/>/gi, "<sp$1/>");
}

function renderCarNode(car, extraAttrs = {}) {
  const colorCode = normalizeColorCode(car.color_code);
  const paintId = Number(resolvePaintIdForCar(car)) || DEFAULT_PAINT_INDEX;
  const engineIdentity = getCarEngineIdentity(car);
  const attrs = attrsToString({
    i: car.game_car_id,
    ci: car.catalog_car_id,
    sel: car.selected ? 1 : 0,
    pi: paintId,
    pn: car.plate_name ?? "",
    lk: car.locked ?? 0,
    ae: engineIdentity.ae,
    et: engineIdentity.et,
    cc: colorCode,
    ii: car.image_index ?? 0,
    td: car.test_drive_active,
    tdex: car.test_drive_expired,
    tid: car.test_drive_invitation_id,
    n: car.test_drive_name,
    p: car.test_drive_money_price,
    pp: car.test_drive_point_price,
    rh: car.test_drive_hours_remaining,
    ...extraAttrs,
  });

  return `<c ${attrs}>${renderCarBody(car)}</c>`;
}

export function renderCar(car) {
  return renderCarNode(car, { ai: car.account_car_id });
}

export function renderOwnedGarageCar(car) {
  return renderCarNode(car);
}

export function renderRacerCar(car) {
  return renderCarNode(car, { ai: car.owner_public_id });
}

export function renderCars(cars) {
  return `<cars>${cars.map(renderCar).join("")}</cars>`;
}

export function renderShowroomCarBody(catalogCarId, options = {}) {
  const syntheticCar = {
    catalog_car_id: Number(catalogCarId || 0),
    color_code: options.colorCode ?? DEFAULT_COLOR_CODE,
    paint_index: Number(options.paintIndex ?? DEFAULT_PAINT_INDEX),
    wheel_xml: getDefaultWheelXmlForCar(catalogCarId),
    parts_xml: getDefaultShowroomPartsXmlForCar(catalogCarId),
  };

  return retagInstalledShowroomParts(renderCarBody(syntheticCar));
}

export function renderRacerCars(cars) {
  return `<cars>${cars.map(renderRacerCar).join("")}</cars>`;
}

export function renderOwnedGarageCars(cars) {
  return cars.map(renderOwnedGarageCar).join("");
}

export function renderOwnedGarageCarsWrapper(cars, options = {}) {
  const selectedCar = cars.find((car) => car.selected);
  const defaultCarId = selectedCar ? selectedCar.game_car_id : (cars[0]?.game_car_id ?? "");
  const attrs = attrsToString({
    i: options.ownerPublicId,
    dc: defaultCarId,
  });

  return `<cars ${attrs}>${cars.map(renderOwnedGarageCar).join("")}</cars>`;
}

export function renderTwoRacerCars(cars) {
  return `<n2>${cars.map(renderOwnedGarageCar).join("")}</n2>`;
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function renderTeamMember(member, index, totalContribution) {
  const player = member.player || {};
  const contribution = Number(member.contribution_score || 0);
  const share = totalContribution > 0 ? ((contribution / totalContribution) * 100).toFixed(2) : "0";
  const attrs = attrsToString({
    i: player.id ?? member.player_id,
    un: player.username ?? "",
    sc: player.score ?? 0,
    et: 0,
    tr: index + 1,
    po: share,
    fu: contribution,
    mbp: -1,
  });

  return `<tm ${attrs}/>`;
}

export function renderTeams(teams) {
  const body = teams.map((team) => {
    const members = team.members || [];
    const totalContribution = members.reduce(
      (sum, member) => sum + Number(member.contribution_score || 0),
      0,
    );
    const attrs = attrsToString({
      i: team.id,
      n: team.name,
      sc: team.score ?? 0,
      bg: team.background_color ?? "7D7D7D",
      de: formatTimestamp(team.created_at),
      tf: team.team_fund ?? 0,
      lc: team.location_code ?? "",
      tw: team.wins ?? 0,
      tl: team.losses ?? 0,
      rt: team.recruitment_type ?? "open",
      v: team.vip ?? 0,
    });

    return `<t ${attrs}>${members.map((member, index) => renderTeamMember(member, index, totalContribution)).join("")}</t>`;
  }).join("");

  return `<teams>${body}</teams>`;
}
