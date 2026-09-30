// Validate — first Code node after the Webhook.
//
// Keeps only the fields of the contract (docs/payload.md), trims them, caps their
// length and reports the required ones that are missing. Everything the LLM later reads
// goes through here, so nothing unexpected — no extra field, no 50 kB "message" — ever
// reaches the prompt.

const REQUIRED = ["name", "email", "message", "source"];
const OPTIONAL = ["service", "otherService", "budget", "deadline", "company", "phone", "features", "other"];
const MAX_LENGTH = { message: 5000, other: 2000 };
const DEFAULT_MAX = 300;

function clean(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+\n/g, "\n").trim().slice(0, max);
}

function validate(body, now = new Date()) {
  const input = body && typeof body === "object" ? body : {};
  const lead = {};
  for (const field of [...REQUIRED, ...OPTIONAL]) {
    lead[field] = clean(input[field], MAX_LENGTH[field] || DEFAULT_MAX);
  }
  // The Worker stamps receivedAt; a manual replay may not. Never trust it to be a date.
  const received = new Date(input.receivedAt);
  lead.receivedAt = Number.isNaN(received.getTime()) ? now.toISOString() : received.toISOString();
  if (lead.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(lead.deadline)) lead.deadline = "";

  const missing = REQUIRED.filter((field) => !lead[field]);
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) missing.push("email");
  return { ok: missing.length === 0, missing, lead };
}

/* @n8n — uncommented by scripts/build.mjs, where $input and $() exist
return $input.all().map((item) => ({ json: validate(item.json.body) }));
@end */

module.exports = { validate, REQUIRED };
