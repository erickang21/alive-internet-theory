import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_FILTER_THRESHOLD,
  DEFAULT_FILTER_STATE,
  FILTER_STATES,
  FILTER_STORAGE_KEY,
  MESSAGE_TYPES,
  VERDICTS,
} from "./constants.js";

test("verdict keys match the backend's", () => {
  assert.deepEqual(Object.keys(VERDICTS).sort(), ["ai_slop", "likely_ai", "likely_human"]);
});

test("message types are distinct", () => {
  const values = Object.values(MESSAGE_TYPES);
  assert.equal(new Set(values).size, values.length);
});

test("filter constants match the shared storage contract", () => {
  assert.deepEqual(FILTER_STATES, ["off", "flag", "block"]);
  assert.equal(DEFAULT_FILTER_STATE, "off");
  assert.equal(FILTER_STORAGE_KEY, "aitFilterState");
  assert.equal(AI_FILTER_THRESHOLD, 45);
});
