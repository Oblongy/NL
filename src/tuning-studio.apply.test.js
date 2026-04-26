import assert from "node:assert/strict";
import test from "node:test";

import { mergePartsXmlBySlotIds } from "./tuning-studio.js";

test("mergePartsXmlBySlotIds updates only the requested tune carrier slots", () => {
  const basePartsXml = [
    "<p ai='base_10' i='100' pi='10' n='Intake'/>",
    "<p ai='base_23' i='101' pi='23' n='BoostCtl' bs='5' mp='10'/>",
    "<p ai='base_81' i='102' pi='81' n='Supercharger'/>",
  ].join("");
  const incomingPartsXml = [
    "<p ai='next_10' i='100' pi='10' n='Intake'/>",
    "<p ai='next_23' i='101' pi='23' n='BoostCtl' bs='9' mp='10'/>",
    "<p ai='next_87' i='103' pi='87' n='Turbo Kit'/>",
  ].join("");

  const merged = mergePartsXmlBySlotIds(basePartsXml, incomingPartsXml, ["23"]);

  assert.match(merged, /pi='10'/);
  assert.match(merged, /pi='23'[^>]*bs='9'/);
  assert.match(merged, /pi='81'/);
  assert.doesNotMatch(merged, /pi='87'/);
});

test("mergePartsXmlBySlotIds swaps engine induction slots without touching other slots", () => {
  const basePartsXml = [
    "<p ai='base_10' i='100' pi='10' n='Intake'/>",
    "<p ai='base_81' i='102' pi='81' n='Supercharger'/>",
  ].join("");
  const incomingPartsXml = [
    "<p ai='next_10' i='100' pi='10' n='Intake'/>",
    "<p ai='next_87' i='103' pi='87' n='Turbo Kit'/>",
  ].join("");

  const merged = mergePartsXmlBySlotIds(basePartsXml, incomingPartsXml, ["81", "87"]);

  assert.match(merged, /pi='10'/);
  assert.match(merged, /pi='87'/);
  assert.doesNotMatch(merged, /pi='81'/);
});

test("mergePartsXmlBySlotIds removes scoped parts when the preview clears that slot", () => {
  const basePartsXml = [
    "<p ai='base_10' i='100' pi='10' n='Intake'/>",
    "<p ai='base_11' i='101' pi='11' n='Header'/>",
  ].join("");
  const incomingPartsXml = "<p ai='next_10' i='100' pi='10' n='Intake'/>";

  const merged = mergePartsXmlBySlotIds(basePartsXml, incomingPartsXml, ["11"]);

  assert.match(merged, /pi='10'/);
  assert.doesNotMatch(merged, /pi='11'/);
});
