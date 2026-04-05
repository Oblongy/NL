import { getClientRoleForPlayer } from "./player-role.js";
import { renderVisibleBadgesXml } from "./profile-badges.js";

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
  const attrs = attrsToString({
    i: publicId,
    u: player.username,
    r: getClientRoleForPlayer(player),
    sc: player.score,
    ti: player.title_id,
    tn: player.team_name,
  });
  const badgesXml = renderVisibleBadgesXml(player);

  if (!badgesXml) {
    return `<p ${attrs}/>`;
  }

  return `<p ${attrs}>${badgesXml}</p>`;
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
  const wheelXml = String(car.wheel_xml || "").trim();
  if (!wheelXml) {
    // Return default wheels instead of empty string to prevent <Void> errors
    return "<ws><w wid='1' id='1001' ws='17'/></ws>";
  }

  // Repair legacy/bad starter wheels that cause invisible cars or rimless renders.
  // Known-good default from reference payloads: <ws><w wid='1' id='1001' ws='17'/></ws>
  // We previously created: <w wid='1000' id='1' ws='17'/> (or wrapped)
  if (/<w\b[^>]*\bwid='1000'[^>]*\bid='1'[^>]*\bws='17'[^>]*\/?>/i.test(wheelXml)) {
    return "<ws><w wid='1' id='1001' ws='17'/></ws>";
  }

  if (/^<ws[\s>]/i.test(wheelXml)) {
    return wheelXml;
  }

  if (/^<w\b/i.test(wheelXml)) {
    return `<ws>${wheelXml}</ws>`;
  }

  return wheelXml;
}

function normalizePartsXml(car) {
  const partsXml = String(car.parts_xml || "").trim();
  if (!partsXml) {
    return "";
  }
  return partsXml;
}

function renderFallbackWheelPartXml(car, wheelXml, partsXml) {
  if (/\bci='14'\b/i.test(partsXml)) {
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

  return `<p i='${normalizedPartId}' ci='14' n='Stock 15&quot;' in='1' cc='' pdi='1' di='${normalizedWheelId}' pt='c' ps='${normalizedWheelSize}'/>`;
}

function renderFallbackPaintStateXml(car, partsXml) {
  if (/<ps[\s>]/i.test(partsXml)) {
    return "";
  }

  const colorCode = String(car.color_code || "C0C0C0").replace(/[^0-9A-F]/gi, "").toUpperCase() || "C0C0C0";
  return `<ps><p cd='${colorCode}'/></ps>`;
}

function renderCarBody(car) {
  const wheelXml = normalizeWheelXml(car);
  const partsXml = normalizePartsXml(car);
  const wheelPartXml = renderFallbackWheelPartXml(car, wheelXml, partsXml);
  const paintStateXml = renderFallbackPaintStateXml(car, partsXml);
  return `${wheelXml}${wheelPartXml}${partsXml}${paintStateXml}`;
}

function renderCarNode(car, extraAttrs = {}) {
  const attrs = attrsToString({
    ...extraAttrs,
    i: car.game_car_id,
    ci: car.catalog_car_id,
    sel: car.selected ? 1 : 0,
    pi: car.paint_index ?? 4,
    pn: car.plate_name ?? "",
    lk: car.locked ?? 0,
    ae: car.aero ?? 0,
    cc: car.color_code ?? "C0C0C0",
    ii: car.image_index ?? 0,
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
