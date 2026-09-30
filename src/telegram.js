// Build Telegram message — the Code node that writes the notification Hery reads on
// his phone: who, what, how good, what to ask, and the link to the Notion page where
// the draft waits.
//
// HTML parse mode: only <b>, <i> and <a> are used, and every piece of text
// the visitor typed is escaped — Telegram rejects the whole message on one stray "<".

const { TYPE_LABELS, BUDGET_LABELS, URGENCY_LABELS } = require("./labels.js");

// Telegram's hard limit for one message.
const MAX_MESSAGE = 4096;

function escape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bar(score) {
  const full = Math.round(score / 10);
  return "▰".repeat(full) + "▱".repeat(10 - full);
}

function telegramMessage(lead, q, pageUrl) {
  const who = [lead.name, lead.company].filter(Boolean).map(escape).join(" · ");
  const lines = [
    `<b>${q.score >= 70 ? "🔥 " : ""}Nouveau prospect — ${q.score}/100</b>`,
    bar(q.score),
    "",
    `<b>${who}</b>`,
    escape(q.summary || lead.message.slice(0, 200)),
    "",
    `Type : ${TYPE_LABELS[q.projectType]}`,
    `Budget : ${escape(lead.budget) || "—"} (${BUDGET_LABELS[q.budgetFit]})`,
    `Urgence : ${URGENCY_LABELS[q.urgency]}${lead.deadline ? ` — échéance ${lead.deadline}` : ""}`,
    `Langue : ${q.language} · Source : ${escape(lead.source)}`,
  ];
  if (q.missingInfo.length) lines.push("", "<b>À demander</b>", ...q.missingInfo.map((m) => `• ${escape(m)}`));
  if (q.error) lines.push("", `<i>Qualification incomplète (${escape(q.error)}) — à lire à la main.</i>`);
  if (pageUrl) lines.push("", `<a href="${escape(pageUrl)}">Ouvrir la fiche et le brouillon dans Notion</a>`);

  let message = lines.join("\n");
  if (message.length > MAX_MESSAGE) message = message.slice(0, MAX_MESSAGE - 1) + "…";
  return message;
}

function telegramRequest(chatId, lead, q, pageUrl) {
  return {
    chat_id: chatId,
    text: telegramMessage(lead, q, pageUrl),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
}

/* @n8n — uncommented by scripts/build.mjs, where $input, $() and $env exist
const { lead, qualification } = $("Build Notion page").first().json;
return $input.all().map((item) => ({
  json: { request: telegramRequest($env.TELEGRAM_CHAT_ID, lead, qualification, item.json.url) },
}));
@end */

module.exports = { telegramMessage, telegramRequest, escape };
