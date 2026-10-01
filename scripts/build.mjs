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
  node(name, "n8n-nodes-base.code", 2, position, {
    // Once per lead: each node then finds its own lead's data with $("Node").item,
    // however many leads the run picked up.
    mode: "runOnceForEachItem",
    jsCode: codeFrom(files, replacements),
  });

// Three tries, five seconds apart, for calls whose failure stops the run anyway (the
// queue fetch, the ack). n8n skips these retries on a node that continues on error,
// which is why Gemini and Notion handle failure on their own error output instead.
const retries = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };

const http = (name, position, method, url, { headers = [], auth, query = [], body, retry = true } = {}) =>
  node(name, "n8n-nodes-base.httpRequest", 4.2, position, {
    method,
    url,
    ...(auth ? { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" } : {}),
    sendQuery: query.length > 0,
    queryParameters: { parameters: query },
    sendHeaders: headers.length > 0,
    headerParameters: { parameters: headers },
    sendBody: Boolean(body),
    ...(body ? { specifyBody: "json", jsonBody: body } : {}),
    options: { timeout: 30000 },
  }, { ...(auth ? { credentials: credential("httpHeaderAuth", auth) } : {}), ...(retry ? retries : {}) });

const isTrue = (name, position, left) =>
  node(name, "n8n-nodes-base.if", 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
      conditions: [{ id: uuid(`${name}/condition`), leftValue: left, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
      combinator: "and",
    },
    options: {},
  });

// GEMINI MODEL CHAIN. Free Gemini models answer 503 "high demand" for minutes at a
// time, one model at a time. So the lead is offered to up to MODEL_ATTEMPTS models in
// turn, taken from GEMINI_MODELS (comma-separated, first is preferred): each failure
// goes down the node's error output to the next model. A chain shorter than
// MODEL_ATTEMPTS repeats its last model, which then acts as a plain retry.
// GEMINI_MODEL, the single-model setting of earlier versions, still works.
const MODEL_ATTEMPTS = 4;
const MODELS = '($env.GEMINI_MODELS || $env.GEMINI_MODEL || "gemini-3.6-flash").split(",").map((m) => m.trim()).filter(Boolean)';
const modelAt = (i) => `((list) => list[Math.min(${i}, list.length - 1)])(${MODELS})`;
const geminiUrl = (i) => `={{ $env.GEMINI_API_BASE }}/v1beta/models/{{ ${modelAt(i)} }}:generateContent`;
const geminiNode = (i) => `Gemini — model ${i + 1}`;

// The id of the lead an item belongs to, from any node after Validate.
const LEAD_ID = '$("Validate").item.json.id';

const nodes = [
  node("Every 5 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, [0, 200], {
    rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
  }),
  // To empty the queue on demand from the editor — and what `n8n execute` starts from,
  // which the end-to-end test relies on.
  node("Run now", "n8n-nodes-base.manualTrigger", 1, [0, 400], {}),
  http("Fetch queued leads", [220, 300], "GET", "={{ $env.LEADS_API_BASE }}/api/leads/pending", {
    auth: "Leads API token",
    query: [{ name: "limit", value: "10" }],
  }),
  // One item per lead. An empty queue returns no item, and the run ends here.
  node("One item per lead", "n8n-nodes-base.code", 2, [440, 300], {
    jsCode: "return ($input.first().json.leads || []).map((lead) => ({ json: lead }));\n",
  }),

  code("Validate", [660, 300], ["validate.js"]),
  isTrue("Valid?", [880, 300], "={{ $json.ok }}"),

  code("Build Gemini request", [1100, 200], ["qualify.js"], {
    '"__PROMPT__"': JSON.stringify(prompt),
    '"__SCHEMA__"': JSON.stringify(schema),
  }),
  // Each model gets the lead in turn; the last one continues on error, so a lead that no
  // model could qualify is still filed — marked "qualification incomplète" — and can
  // never block the queue.
  ...Array.from({ length: MODEL_ATTEMPTS }, (_, i) => ({
    ...http(geminiNode(i), [1320 + 220 * i, 200 + 160 * i], "POST", geminiUrl(i), {
      auth: "Gemini API key",
      body: '={{ JSON.stringify($("Build Gemini request").item.json.request) }}',
      retry: false,
    }),
    onError: i < MODEL_ATTEMPTS - 1 ? "continueErrorOutput" : "continueRegularOutput",
  })),
  code("Read qualification", [2200, 200], ["parse.js"]),

  code("Build Notion page", [2420, 200], ["labels.js", "notion.js"]),
  // A failure here leaves the lead in the queue for the next run, and only that lead:
  // the others carry on and are acknowledged. Nothing half-filed, nothing duplicated.
  {
    ...http("File in Notion", [2640, 200], "POST", "={{ $env.NOTION_API_BASE }}/v1/pages", {
      auth: "Notion integration token",
      headers: [{ name: "Notion-Version", value: "2022-06-28" }],
      body: "={{ JSON.stringify($json.page) }}",
      retry: false,
    }),
    onError: "continueErrorOutput",
  },
  node("Left in the queue", "n8n-nodes-base.noOp", 1, [2860, 420], {}),

  isTrue("Spam?", [2860, 200], '={{ $("Build Notion page").item.json.qualification.isSpam }}'),
  code("Build Telegram message", [3080, 300], ["labels.js", "telegram.js"]),
  // The Telegram node rather than a raw HTTP call: its credential holds the bot token
  // and a base URL, which is what lets the tests point it at a local mock.
  node("Notify on Telegram", "n8n-nodes-base.telegram", 1.2, [3300, 300], {
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
  }, {
    credentials: credential("telegramApi", "Telegram bot"),
    // The lead is already safe in Notion: a failed notification must not stop the ack.
    onError: "continueRegularOutput",
  }),

  // Reached by invalid leads, spam and notified leads alike: each is done with.
  http("Acknowledge", [3520, 300], "POST", "={{ $env.LEADS_API_BASE }}/api/leads/ack", {
    auth: "Leads API token",
    body: `={{ JSON.stringify({ ids: [${LEAD_ID}] }) }}`,
  }),
];

// ------------------------------------------------------------------ connections

const main = (...targets) => ({ main: targets.map((t) => (t ? [{ node: t, type: "main", index: 0 }] : [])) });

const connections = {
  "Every 5 minutes": main("Fetch queued leads"),
  "Run now": main("Fetch queued leads"),
  "Fetch queued leads": main("One item per lead"),
  "One item per lead": main("Validate"),
  Validate: main("Valid?"),
  // Invalid: nothing to qualify, but it must leave the queue.
  "Valid?": main("Build Gemini request", "Acknowledge"),
  "Build Gemini request": main(geminiNode(0)),
  // Output 0: an answer, read at once. Output 1: an error, handed to the next model.
  ...Object.fromEntries(Array.from({ length: MODEL_ATTEMPTS }, (_, i) => [
    geminiNode(i),
    i < MODEL_ATTEMPTS - 1 ? main("Read qualification", geminiNode(i + 1)) : main("Read qualification"),
  ])),
  "Read qualification": main("Build Notion page"),
  "Build Notion page": main("File in Notion"),
  "File in Notion": main("Spam?", "Left in the queue"),
  // Spam is filed and acknowledged, without a notification.
  "Spam?": main("Acknowledge", "Build Telegram message"),
  "Build Telegram message": main("Notify on Telegram"),
  "Notify on Telegram": main("Acknowledge"),
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
