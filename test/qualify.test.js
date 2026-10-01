const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { geminiRequest } = require("../src/qualify.js");
const { readQualification } = require("../src/parse.js");
const { validate } = require("../src/validate.js");

const prompt = fs.readFileSync(path.join(__dirname, "../prompts/qualify.md"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../prompts/qualify.schema.json"), "utf8"));
const { lead } = validate(require("../samples/lead-en.json"));

const answer = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] });
const good = {
  language: "en", summary: "Northwind veut automatiser la saisie de bons de livraison.", projectType: "ai_automation",
  budgetFit: "realistic", urgency: "normal", score: 86, scoreReasons: ["Besoin clair", "Budget donné", "Entreprise réelle"],
  missingInfo: ["Quel ERP ?"], isSpam: false, replySubject: "Your delivery notes", replyDraft: "Hi Daniel, …\nHery",
};

test("the request carries the prompt as system instruction and the lead as the only user turn", () => {
  const req = geminiRequest(lead, prompt, schema);
  assert.equal(req.systemInstruction.parts[0].text, prompt);
  assert.equal(req.contents.length, 1);
  assert.deepEqual(JSON.parse(req.contents[0].parts[0].text), lead);
});

test("the request asks for JSON matching the schema", () => {
  const req = geminiRequest(lead, prompt, JSON.stringify(schema));
  assert.equal(req.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(req.generationConfig.responseSchema, schema);
});

test("the prompt and the schema agree on the fields", () => {
  for (const field of schema.required) assert.match(prompt, new RegExp("`" + field + "`"), `${field} not explained in the prompt`);
});

test("a well-formed answer is read as is", () => {
  const q = readQualification(answer(good));
  assert.equal(q.error, null);
  assert.equal(q.score, 86);
  assert.equal(q.projectType, "ai_automation");
  assert.deepEqual(q.missingInfo, ["Quel ERP ?"]);
});

test("out-of-range values fall back instead of failing", () => {
  const q = readQualification(answer({ ...good, score: 140, urgency: "asap", projectType: "blockchain", scoreReasons: ["a", "b", "c", "d"] }));
  assert.equal(q.score, 100);
  assert.equal(q.urgency, "normal");
  assert.equal(q.projectType, "other");
  assert.equal(q.scoreReasons.length, 3);
});

test("isSpam is true only when the model says exactly true", () => {
  assert.equal(readQualification(answer({ ...good, isSpam: "yes" })).isSpam, false);
  assert.equal(readQualification(answer({ ...good, isSpam: true })).isSpam, true);
});

test("a blocked or unreadable answer still yields a qualification, with the reason", () => {
  const blocked = readQualification({ promptFeedback: { blockReason: "SAFETY" } });
  assert.equal(blocked.error, "gemini_safety");
  assert.equal(blocked.score, 0);
  const truncated = readQualification({ candidates: [{ content: { parts: [{ text: '{"language":"en",' }] }, finishReason: "MAX_TOKENS" }] });
  assert.equal(truncated.error, "gemini_max_tokens");
});

test("a call that failed after its retries still yields a qualification", () => {
  const q = readQualification({ error: { message: "503 - model overloaded" } });
  assert.equal(q.error, "gemini_request_failed");
  assert.equal(q.score, 0);
  assert.equal(q.isSpam, false);
});
