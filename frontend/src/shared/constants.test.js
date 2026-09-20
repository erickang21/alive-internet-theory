import { test } from "node:test";
import assert from "node:assert/strict";

import {
  API_BASE_URL,
  VERDICTS,
  MESSAGE_TYPES,
  FILTER_STATES,
  DEFAULT_FILTER_STATE,
  FILTER_STORAGE_KEY,
  AI_FILTER_THRESHOLD,
  nextFilterState,
} from "./constants.js";

test("existing exports are untouched", () => {
  assert.equal(typeof API_BASE_URL, "string");
  // These assertions were written before the possibly_ai -> likely_ai and
  // GET_EVALUATION -> REQUEST_EVALUATION renames landed, and were never
  // updated, so this file has been failing against its own source.
  assert.deepEqual(Object.keys(VERDICTS).sort(), ["ai_slop", "likely_ai", "likely_human"]);
  assert.equal(MESSAGE_TYPES.REQUEST_EVALUATION, "ait:request-evaluation");
});

test("MESSAGE_TYPES gained the new keys without replacing the object", () => {
  assert.equal(MESSAGE_TYPES.SET_FILTER_STATE, "ait:set-filter-state");
  assert.equal(MESSAGE_TYPES.GET_EVALUATIONS, "ait:get-evaluations");
  // The pre-existing key must still be there alongside the new ones.
  assert.equal(MESSAGE_TYPES.REQUEST_EVALUATION, "ait:request-evaluation");
});

test("filter constants match the shared contract", () => {
  assert.deepEqual(FILTER_STATES, ["off", "flag", "block"]);
  assert.equal(DEFAULT_FILTER_STATE, "off");
  assert.equal(FILTER_STORAGE_KEY, "aitFilterState");
  assert.equal(AI_FILTER_THRESHOLD, 45);
});

test("nextFilterState cycles off -> flag -> block -> off", () => {
  assert.equal(nextFilterState("off"), "flag");
  assert.equal(nextFilterState("flag"), "block");
  assert.equal(nextFilterState("block"), "off");
});

test("nextFilterState defaults on any garbage input", () => {
  for (const garbage of [null, undefined, "", 42, {}, "OFF", "flagged"]) {
    assert.equal(nextFilterState(garbage), DEFAULT_FILTER_STATE);
  }
});
