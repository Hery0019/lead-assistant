const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../src/validate.js");
const { notionPage, PROPERTIES } = require("../src/notion.js");

const { lead } = validate(require("../samples/lead-fr.json"));
const q = {
  language: "fr", summary: "Un atelier de sacs en raphia veut une boutique en ligne bilingue.", projectType: "ecommerce",
  budgetFit: "realistic", urgency: "normal", score: 78, scoreReasons: ["Périmètre clair", "Budget cohérent"],
  missingInfo: ["Quel prestataire de paiement ?", "Qui gère les expéditions ?"], isSpam: false,
  replySubject: "Votre boutique en ligne", replyDraft: "Bonjour Sandrine,\n\nMerci pour votre message.\n\nHery", error: null,
};

test("the Notion page fills every property the database has", () => {
  const page = notionPage(lead, q, "db123");
  assert.equal(page.parent.database_id, "db123");
  assert.equal(page.properties.Name.title[0].text.content, "Sandrine Rabe");
  assert.equal(page.properties.Score.number, 78);
  assert.equal(page.properties.Status.select.name, "Nouveau");
  assert.equal(page.properties.Type.select.name, "E-commerce");
  assert.equal(page.properties.Deadline.date.start, "2026-12-15");
});

test("spam is filed as Spam, without a draft section", () => {
  const page = notionPage(lead, { ...q, isSpam: true, replyDraft: "", replySubject: "" }, "db");
  assert.equal(page.properties.Status.select.name, "Spam");
  assert.ok(!page.children.some((b) => b.type === "heading_2" && b.heading_2.rich_text[0].text.content.startsWith("Brouillon")));
});

test("Notion limits are respected: 2,000 characters per text, 100 blocks, no comma in a select", () => {
  const long = { ...lead, message: Array.from({ length: 150 }, (_, i) => `Paragraphe ${i} ` + "x".repeat(2500)).join("\n\n"), source: "Recherche, en ligne" };
  const page = notionPage(long, q, "db");
  assert.ok(page.children.length <= 100);
  for (const block of page.children) assert.ok(block[block.type].rich_text[0].text.content.length <= 2000);
  assert.equal(page.properties.Source.select.name, "Recherche  en ligne");
});

test("an optional deadline is left out rather than sent empty", () => {
  const page = notionPage({ ...lead, deadline: "" }, q, "db");
  assert.equal("Deadline" in page.properties, false);
});

test("the page body holds the message, the reasons, the questions and the draft", () => {
  const texts = notionPage(lead, q, "db").children.map((b) => b[b.type].rich_text[0].text.content);
  assert.ok(texts.includes("Message"));
  assert.ok(texts.includes("Quel prestataire de paiement ?"));
  assert.ok(texts.includes("Brouillon — Votre boutique en ligne"));
  assert.ok(texts.includes("Bonjour Sandrine,"));
});

test("the page writes exactly the declared properties, each with its declared type", () => {
  const page = notionPage(lead, q, "db");
  assert.deepEqual(Object.keys(page.properties).sort(), Object.keys(PROPERTIES).sort());
  for (const [name, value] of Object.entries(page.properties)) {
    const type = Object.keys(value)[0];
    assert.equal(type, PROPERTIES[name], `${name} is written as ${type}`);
  }
});
