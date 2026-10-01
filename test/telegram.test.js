const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../src/validate.js");
const { telegramMessage, telegramRequest, escape } = require("../src/telegram.js");

const { lead } = validate(require("../samples/lead-fr.json"));
const q = {
  language: "fr", summary: "Un atelier de sacs en raphia veut une boutique en ligne bilingue.", projectType: "ecommerce",
  budgetFit: "realistic", urgency: "normal", score: 78, scoreReasons: ["Périmètre clair", "Budget cohérent"],
  missingInfo: ["Quel prestataire de paiement ?", "Qui gère les expéditions ?"], isSpam: false,
  replySubject: "Votre boutique en ligne", replyDraft: "Bonjour Sandrine,\n\nMerci pour votre message.\n\nHery", error: null,
};

test("the Telegram message gives the score, the questions and the Notion link", () => {
  const text = telegramMessage(lead, q, "https://www.notion.so/page-1");
  assert.match(text, /78\/100/);
  assert.match(text, /▰{8}▱{2}/);
  assert.match(text, /• Quel prestataire de paiement \?/);
  assert.match(text, /<a href="https:\/\/www\.notion\.so\/page-1">/);
});

test("whatever the visitor typed is escaped for Telegram's HTML mode", () => {
  const text = telegramMessage({ ...lead, name: "<script>alert(1)</script>", company: "A & B" }, q, null);
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; · A &amp; B/);
  assert.equal(escape('"'), "&quot;");
});

test("a hot lead is flagged, a failed qualification is said", () => {
  assert.match(telegramMessage(lead, { ...q, score: 91 }, null), /^<b>🔥 /);
  assert.match(telegramMessage(lead, { ...q, error: "gemini_safety" }, null), /Qualification incomplète \(gemini_safety\)/);
});

test("the request is ready for sendMessage", () => {
  const req = telegramRequest("42", lead, q, null);
  assert.equal(req.chat_id, "42");
  assert.equal(req.parse_mode, "HTML");
  assert.ok(req.text.length <= 4096);
});

test("the model that qualified the lead is named, when there is one", () => {
  assert.match(telegramMessage(lead, { ...q, model: "gemini-3.8-flash" }, null), /<i>Qualifié par gemini-3\.8-flash<\/i>/);
  assert.doesNotMatch(telegramMessage(lead, { ...q, model: null }, null), /Qualifié par/);
});
