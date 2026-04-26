import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginBody } from "./login-payload.js";

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test("login payload does not append tournament placeholder slots to the garage list", () => {
  const player = {
    id: 14,
    username: "Obi",
    money: 1000,
    points: 10,
    score: 1790,
    image_id: 0,
    active: 1,
    vip: 0,
    facebook_connected: 0,
    sponsor_rating: 0,
    driver_text: "",
    team_name: "",
    gender: "m",
    respect_level: 0,
    team_id: 0,
    track_rank: 0,
    location_id: 100,
    background_id: 0,
    default_car_game_id: 289,
  };

  const cars = [
    {
      game_car_id: 289,
      catalog_car_id: 102,
      selected: true,
      plate_name: "",
      locked: 0,
      color_code: "C0C0C0",
      image_index: 0,
      wheel_xml: "<ws><w wid='1' id='1001' ws='17'/></ws>",
      parts_xml: "",
      has_dyno: 0,
    },
  ];

  const body = buildLoginBody(player, cars, "", "session-key", createLogger());

  assert.match(body, /<n id='getallcars'><c\b/);
  assert.doesNotMatch(body, /<empty i=''\/>/, "garage login payload should not include tournament placeholder slots");
});
