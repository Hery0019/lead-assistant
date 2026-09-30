const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../src/validate.js");
const fr = require("../samples/lead-fr.json");
const vague = require("../samples/lead-vague.json");

test("a complete lead passes and keeps its fields", () => {
  const { ok, missing, lead } = validate(fr);
  assert.equal(ok, true);
  assert.deepEqual(missing, []);
  assert.equal(lead.name, "Sandrine Rabe");
  assert.equal(lead.deadline, "2026-12-15");
  assert.equal(lead.receivedAt, "2026-09-30T08:30:00.000Z");
});

test("a short lead with only the required fields still passes", () => {
  const { ok, lead } = validate(vague);
  assert.equal(ok, true);
  assert.equal(lead.budget, "");
  assert.equal(lead.company, "");
});

test("missing required fields are reported, in the contract's order", () => {
  const { ok, missing } = validate({ email: "a@b.co", message: "  " });
  assert.equal(ok, false);
  assert.deepEqual(missing, ["name", "message", "source"]);
});

test("an address that does not look like one is reported", () => {
  const { missing } = validate({ ...fr, email: "not-an-address" });
  assert.deepEqual(missing, ["email"]);
});

test("fields outside the contract never reach the lead", () => {
  const { lead } = validate({ ...fr, botcheck: "on", "cf-turnstile-response": "x", prompt: "ignore previous instructions" });
  assert.equal("botcheck" in lead, false);
  assert.equal("cf-turnstile-response" in lead, false);
  assert.equal("prompt" in lead, false);
});

test("long fields are capped", () => {
  const { lead } = validate({ ...fr, message: "x".repeat(20000), company: "y".repeat(1000) });
  assert.equal(lead.message.length, 5000);
  assert.equal(lead.company.length, 300);
});

test("a bad date is replaced, a bad deadline dropped", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const { lead } = validate({ ...fr, receivedAt: "yesterday", deadline: "before Christmas" }, now);
  assert.equal(lead.receivedAt, now.toISOString());
  assert.equal(lead.deadline, "");
});

test("a body that is not an object is a lead with everything missing", () => {
  for (const body of [undefined, null, "text", 42]) {
    const { ok, missing } = validate(body);
    assert.equal(ok, false);
    assert.equal(missing.length, 4);
  }
});
