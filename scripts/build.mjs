// Writes workflows/lead-intake.json — the file you import into n8n.
//
//   node scripts/build.mjs
//
// WHY A BUILD AND NOT A JSON EDITED BY HAND. An n8n export stores each Code node as one
// escaped string and the prompt as another. Diffs of that are unreadable, and nothing
// can test it. Here the code lives in src/ as plain, tested JavaScript, the prompt in
// prompts/ as text, and this script assembles them into the export. Node ids are derived
// from node names, so rebuilding an unchanged workflow gives a byte-identical file.
//
// Editing in the n8n UI is still fine for trying things out; bring the change back into
// src/ or this file, rebuild, and commit the result.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

// -------------------------------------------------------------------- Code nodes

/** The body of a Code node: the listed modules, minus their require/export lines, then
 *  the @n8n block of the last one switched on. */
export function codeFrom(files, replacements = {}) {
  const parts = files.map((file) => {
    let source = read(`src/${file}`);
    for (const [placeholder, value] of Object.entries(replacements)) source = source.replace(placeholder, value);
    return source
      .split("\n")
      .filter((line) => !/^const .* = require\(".*"\);$/.test(line) && !/^module\.exports = /.test(line))
      .join("\n");
  });
  const last = parts.pop();
  const glue = last.match(/\/\* @n8n[^\n]*\n([\s\S]*?)@end \*\//);
  if (!glue) throw new Error(`no @n8n block in src/${files.at(-1)}`);
  const body = last.replace(glue[0], "").trimEnd();
  return [...parts.map((p) => p.trimEnd()), body, "", "// ---- n8n", glue[1].trimEnd()].join("\n\n") + "\n";
}

const prompt = read("prompts/qualify.md");
const schema = JSON.parse(read("prompts/qualify.schema.json"));

// ------------------------------------------------------------------------ nodes

const uuid = (name) => {
  const h = createHash("sha256").update(`lead-assistant/${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Credentials are referenced by name only. n8n asks you to pick the real one when you
// import; the ids here are placeholders it discards.
const credential = (type, name) => ({ [type]: { id: uuid(`credential/${name}`).slice(0, 16), name } });

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id: uuid(name), name, type, typeVersion, position, ...extra,
});

const code = (name, position, files, replacements) =>
  node(name, "n8n-nodes-base.code", 2, position, { jsCode: codeFrom(files, replacements) });

const post = (name, position, url, { headers = [], auth } = {}) =>
  node(name, "n8n-nodes-base.httpRequest", 4.2, position, {
    method: "POST",
    url,
    ...(auth ? { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" } : {}),
    sendHeaders: headers.length > 0,
    headerParameters: { parameters: headers },
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.request ?? $json.page) }}",
    options: { timeout: 30000 },
  }, {
    ...(auth ? { credentials: credential("httpHeaderAuth", auth) } : {}),
    // Every outside API gets three tries, five seconds apart: a 429 from a free tier is
    // the normal case, not the exception.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
  });

const isTrue = (name, position, left) =>
  node(name, "n8n-nodes-base.if", 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{ id: uuid(`${name}/condition`), leftValue: left, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
      combinator: "and",
    },
    options: {},
  });

const respond = (name, position, status, body) =>
  node(name, "n8n-nodes-base.respondToWebhook", 1.1, position, {
    respondWith: "json",
    responseBody: body,
    options: { responseCode: status },
  });

const nodes = [
  node("Webhook", "n8n-nodes-base.webhook", 2, [0, 300], {
    httpMethod: "POST",
    path: "lead",
    authentication: "headerAuth",
    responseMode: "responseNode",
    options: {},
  }, { webhookId: uuid("webhook/lead"), credentials: credential("httpHeaderAuth", "Lead webhook token") }),

  code("Validate", [220, 300], ["validate.js"]),
  isTrue("Valid?", [440, 300], "={{ $json.ok }}"),
  respond("Reject", [660, 460], 400, '={{ JSON.stringify({ ok: false, error: "missing_fields", fields: $json.missing }) }}'),
  // Answer the Worker now: everything after this runs without it waiting.
  respond("Accept", [660, 200], 202, "={{ JSON.stringify({ ok: true, lead: $execution.id }) }}"),

  code("Build Gemini request", [880, 200], ["qualify.js"], {
    '"__PROMPT__"': JSON.stringify(prompt),
    '"__SCHEMA__"': JSON.stringify(schema),
  }),
  post("Qualify with Gemini", [1100, 200],
    "={{ $env.GEMINI_API_BASE }}/v1beta/models/{{ $env.GEMINI_MODEL }}:generateContent",
    { auth: "Gemini API key" }),
  code("Read qualification", [1320, 200], ["parse.js"]),

  code("Build Notion page", [1540, 200], ["labels.js", "notion.js"]),
  post("File in Notion", [1760, 200], "={{ $env.NOTION_API_BASE }}/v1/pages", {
    auth: "Notion integration token",
    headers: [{ name: "Notion-Version", value: "2022-06-28" }],
  }),

  isTrue("Spam?", [1980, 200], "={{ $('Build Notion page').first().json.qualification.isSpam }}"),
  code("Build Telegram message", [2200, 300], ["labels.js", "telegram.js"]),
  // The Telegram node rather than a raw HTTP call: its credential holds the bot token
  // and a base URL, which is what lets the tests point it at a local mock.
  node("Notify on Telegram", "n8n-nodes-base.telegram", 1.2, [2420, 300], {
    resource: "message",
    operation: "sendMessage",
    chatId: "={{ $json.request.chat_id }}",
    text: "={{ $json.request.text }}",
    additionalFields: {
      // Off: n8n otherwise signs every message "sent automatically with n8n".
      appendAttribution: false,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
  }, { credentials: credential("telegramApi", "Telegram bot"), retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }),
];

// ------------------------------------------------------------------ connections

const main = (...targets) => ({ main: targets.map((t) => (t ? [{ node: t, type: "main", index: 0 }] : [])) });

const connections = {
  Webhook: main("Validate"),
  Validate: main("Valid?"),
  "Valid?": main("Accept", "Reject"),
  Accept: main("Build Gemini request"),
  "Build Gemini request": main("Qualify with Gemini"),
  "Qualify with Gemini": main("Read qualification"),
  "Read qualification": main("Build Notion page"),
  "Build Notion page": main("File in Notion"),
  "File in Notion": main("Spam?"),
  // Spam is filed and stops there: no notification.
  "Spam?": main(null, "Build Telegram message"),
  "Build Telegram message": main("Notify on Telegram"),
};

export const workflow = {
  // Fixed, so re-importing replaces the workflow instead of adding a copy.
  id: "leadIntake000001",
  name: "Lead intake",
  nodes,
  connections,
  settings: { executionOrder: "v1", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, "workflows/lead-intake.json");
  writeFileSync(out, JSON.stringify(workflow, null, 2) + "\n");
  console.log(`wrote workflows/lead-intake.json (${nodes.length} nodes)`);
}
