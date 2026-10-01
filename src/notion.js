// Build Notion page — the Code node that turns a lead and its qualification into the
// body of POST /v1/pages.
//
// The database it writes to is described in docs/notion.md: one row per lead, the
// fields Hery sorts and filters on as properties, the long texts (message, draft) in
// the page itself.

const { TYPE_LABELS, BUDGET_LABELS, URGENCY_LABELS } = require("./labels.js");

// The database's properties and their Notion types — what docs/notion.md asks you to
// create, what notionPage writes, and what scripts/check.mjs compares a real database to.
const PROPERTIES = {
  Name: "title", Email: "email", Company: "rich_text", Phone: "phone_number", Score: "number",
  Status: "select", Type: "select", "Budget given": "rich_text", "Budget fit": "select",
  Urgency: "select", Language: "select", Source: "select", Summary: "rich_text",
  Received: "date", Deadline: "date",
};

// Notion refuses a rich_text over 2,000 characters.
const MAX_TEXT = 2000;

function text(content) {
  return [{ type: "text", text: { content: String(content || "").slice(0, MAX_TEXT) } }];
}

function heading(content) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: text(content) } };
}

function paragraphs(content) {
  // One block per line, each under the 2,000-character cap. Every line break counts:
  // Gemini writes its drafts with single ones, and splitting on blank lines only ran
  // "Bonjour Lova," the body and "Cordialement, Hery" into one block.
  return String(content || "—")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((part) => part.match(/[\s\S]{1,2000}/g) || [])
    .map((part) => ({ object: "block", type: "paragraph", paragraph: { rich_text: text(part) } }));
}

function bullets(items) {
  return items.map((item) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: text(item) } }));
}

function select(name) {
  return name ? { select: { name: String(name).replace(/,/g, " ").slice(0, 100) } } : { select: null };
}

function notionPage(lead, q, databaseId) {
  const properties = {
    Name: { title: text(lead.name) },
    Email: { email: lead.email || null },
    Company: { rich_text: text(lead.company) },
    Phone: { phone_number: lead.phone || null },
    Score: { number: q.score },
    Status: select(q.isSpam ? "Spam" : "Nouveau"),
    Type: select(TYPE_LABELS[q.projectType]),
    "Budget given": { rich_text: text(lead.budget) },
    "Budget fit": select(BUDGET_LABELS[q.budgetFit]),
    Urgency: select(URGENCY_LABELS[q.urgency]),
    Language: select(q.language),
    Source: select(lead.source),
    Summary: { rich_text: text(q.summary) },
    Received: { date: { start: lead.receivedAt } },
  };
  if (lead.deadline) properties.Deadline = { date: { start: lead.deadline } };

  const children = [
    heading("Message"),
    ...paragraphs(lead.message),
    ...(lead.other ? [heading("Autres précisions"), ...paragraphs(lead.other)] : []),
    ...(lead.features ? [heading("Fonctionnalités cochées"), ...paragraphs(lead.features)] : []),
    heading("Pourquoi ce score"),
    ...bullets(q.scoreReasons.length ? q.scoreReasons : ["—"]),
    ...(q.model ? paragraphs(`Qualifié par ${q.model}.`) : []),
    ...(q.missingInfo.length ? [heading("À demander"), ...bullets(q.missingInfo)] : []),
    ...(q.replyDraft ? [heading(`Brouillon — ${q.replySubject}`), ...paragraphs(q.replyDraft)] : []),
    ...(q.error ? [heading("Qualification incomplète"), ...paragraphs(`Gemini n'a pas pu qualifier ce message (${q.error}). À lire à la main.`)] : []),
  ];

  // Notion accepts at most 100 blocks per request.
  return { parent: { database_id: databaseId }, properties, children: children.slice(0, 100) };
}

/* @n8n — uncommented by scripts/build.mjs; runs once per lead, where $json and $env exist
return { json: { ...$json, page: notionPage($json.lead, $json.qualification, $env.NOTION_DATABASE_ID) } };
@end */

module.exports = { notionPage, PROPERTIES };
