import assert from "node:assert/strict";
import test from "node:test";

import { createContactCode, evaluateDoorRelease } from "../app/relay-authorization.ts";

const activeState = {
  stage: 3,
  status: "playing",
  armedUntil: 100_000,
  contactCode: "Q7M4ZX",
};

const validAttempt = {
  now: 50_000,
  releaseCode: "575213",
  contactCode: "Q7M4ZX",
  expectedReleaseCode: "575213",
};

test("requires a live human authorization", () => {
  assert.deepEqual(evaluateDoorRelease({ ...activeState, armedUntil: 50_000 }, validAttempt), { ok: false, reason: "contact_expired" });
  assert.deepEqual(evaluateDoorRelease({ ...activeState, stage: 2 }, validAttempt), { ok: false, reason: "lock_not_ready" });
});

test("rejects release calls without the current one-time contact code", () => {
  assert.deepEqual(evaluateDoorRelease(activeState, { ...validAttempt, contactCode: "" }), { ok: false, reason: "contact_code_required" });
  assert.deepEqual(evaluateDoorRelease(activeState, { ...validAttempt, contactCode: "AAAAAA" }), { ok: false, reason: "contact_code_required" });
});

test("requires both the contact code and the release code", () => {
  assert.deepEqual(evaluateDoorRelease(activeState, { ...validAttempt, releaseCode: "000000" }), { ok: false, reason: "invalid_release_code" });
  assert.deepEqual(evaluateDoorRelease(activeState, { ...validAttempt, contactCode: "q7m4zx" }), { ok: true });
});

test("generates six-character contact codes without ambiguous characters", () => {
  const generated = new Set(Array.from({ length: 32 }, () => createContactCode()));
  assert.ok(generated.size > 1);
  for (const code of generated) assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
});
