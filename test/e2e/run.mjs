// End-to-end: the real n8n, the real workflow export, a fake Worker queue and fake
// Gemini / Notion / Telegram.
//
//   N8N_BIN=/path/to/node_modules/.bin/n8n npm run e2e
//
// Imports test credentials and workflows/lead-intake.json into n8n on a throwaway SQLite
// database, then runs the workflow with `n8n execute` — the schedule trigger fires once,
// as it does from the editor's button — against a local server standing in for all four
// services. Nothing leaves the machine.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { workflow } from "../../scripts/build.mjs";

const N8N = process.env.N8N_BIN || "n8n";
const MOCK_PORT = 15679;
const LEADS_TOKEN = "e2e-" + randomBytes(8).toString("hex");
const root = new URL("../../", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL(`samples/${name}.json`, root), "utf8"));

// ----------------------------------------------------------- fake services

const calls = [];
let queue = [];
let notionDown = false;

const qualificationFor = (lead) => {
  const spam = /backlink/i.test(lead.message);
  return {
    language: "fr", summary: `Résumé de test pour ${lead.name}.`, projectType: spam ? "other" : "ecommerce",
    budgetFit: lead.budget ? "realistic" : "unknown", urgency: "normal", score: spam ? 0 : 82,
    scoreReasons: ["Raison de test"], missingInfo: [], isSpam: spam,
    replySubject: spam ? "" : "Re: votre projet", replyDraft: spam ? "" : `Bonjour ${lead.name},\n\nHery`,
  };
};

const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    const send = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };

    if (url.pathname.startsWith("/worker/")) {
      if (req.headers.authorization !== `Bearer ${LEADS_TOKEN}`) return send(401, { ok: false });
      if (url.pathname === "/worker/api/leads/pending") return send(200, { leads: queue.slice(0, Number(url.searchParams.get("limit")) || 10) });
      if (url.pathname === "/worker/api/leads/ack") {
        const before = queue.length;
        queue = queue.filter((l) => !body.ids.includes(l.id));
        return send(200, { ok: true, deleted: before - queue.length });
      }
    }
    if (url.pathname.startsWith("/gemini/")) {
      const lead = JSON.parse(body.contents[0].parts[0].text);
      if (lead.name === "Gemini Down") return send(503, { error: { message: "The model is overloaded." } });
      return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(qualificationFor(lead)) }] }, finishReason: "STOP" }] });
    }
    if (url.pathname === "/notion/v1/pages") {
      if (notionDown) return send(500, { message: "Notion is down" });
      const name = body.properties.Name.title[0].text.content;
      return send(200, { object: "page", id: `p-${name}`, url: `https://www.notion.so/p-${encodeURIComponent(name)}` });
    }
    if (/^\/telegram\/bot[^/]+\/sendMessage$/.test(url.pathname)) return send(200, { ok: true, result: { message_id: calls.length } });
    send(404, { error: "unexpected " + url.pathname });
  });
});

// ---------------------------------------------------------------------- n8n

const home = mkdtempSync(join(tmpdir(), "lead-assistant-e2e-"));
const env = {
  ...process.env,
  N8N_USER_FOLDER: home,
  N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_RUNNERS_BROKER_PORT: "15680",
  LEADS_API_BASE: `http://127.0.0.1:${MOCK_PORT}/worker`,
  GEMINI_MODEL: "gemini-test",
  GEMINI_RETRY_WAIT_S: "1",
  GEMINI_API_BASE: `http://127.0.0.1:${MOCK_PORT}/gemini`,
  NOTION_API_BASE: `http://127.0.0.1:${MOCK_PORT}/notion`,
  NOTION_DATABASE_ID: "db-e2e",
  TELEGRAM_CHAT_ID: "4242",
};

const credentialId = (type, name) =>
  workflow.nodes.map((n) => n.credentials?.[type]).find((c) => c?.name === name).id;
const cred = (type, name, data) => ({ id: credentialId(type, name), name, type, data });
const credentials = [
  cred("httpHeaderAuth", "Leads API token", { name: "Authorization", value: `Bearer ${LEADS_TOKEN}` }),
  cred("httpHeaderAuth", "Gemini API key", { name: "x-goog-api-key", value: "fake-gemini-key" }),
  cred("httpHeaderAuth", "Notion integration token", { name: "Authorization", value: "Bearer fake-notion-token" }),
  cred("telegramApi", "Telegram bot", { accessToken: "123:fake", baseUrl: `http://127.0.0.1:${MOCK_PORT}/telegram` }),
];

const n8n = (...args) => new Promise((resolve) => {
  execFile(N8N, args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code ?? 1 : 0, output: stdout + stderr }));
});
const run = () => n8n("execute", `--id=${workflow.id}`);
const lead = (name, extra = {}) => ({ id: `lead:${new Date().toISOString()}:${name}`, ...sample("lead-fr"), name, ...extra });
const of = (path) => calls.filter((c) => c.path === path);
const sent = () => calls.filter((c) => c.path.endsWith("/sendMessage"));

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  writeFileSync(join(home, "credentials.json"), JSON.stringify(credentials));
  for (const args of [["import:credentials", `--input=${join(home, "credentials.json")}`],
                      ["import:workflow", `--input=${new URL("workflows/lead-intake.json", root).pathname}`]]) {
    const r = await n8n(...args);
    assert.equal(r.code, 0, r.output);
  }
  console.log("✓ imported");

  // 1. Four leads queued: a real one, spam, an invalid one, one Gemini cannot answer.
  queue = [
    lead("Sandrine Rabe"),
    lead("Spammer", { message: "Cheap backlink package, 500 links for $50" }),
    lead("", { email: "" }),
    lead("Gemini Down"),
  ];
  let r = await run();
  assert.equal(r.code, 0, r.output);

  const pending = of("/worker/api/leads/pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].query, "?limit=10");
  assert.equal(pending[0].headers.authorization, `Bearer ${LEADS_TOKEN}`);

  const gemini = calls.filter((c) => c.path.startsWith("/gemini/"));
  assert.ok(gemini.every((c) => c.path === "/gemini/v1beta/models/gemini-test:generateContent"));
  assert.ok(gemini.every((c) => c.headers["x-goog-api-key"] === "fake-gemini-key"));
  assert.ok(gemini.every((c) => /You triage the enquiries/.test(c.body.systemInstruction.parts[0].text)));
  assert.equal(gemini.filter((c) => JSON.parse(c.body.contents[0].parts[0].text).name === "Gemini Down").length, 2, "a failed Gemini call is tried once more");
  assert.equal(gemini.some((c) => JSON.parse(c.body.contents[0].parts[0].text).name === ""), false, "invalid lead never reaches Gemini");

  const pages = of("/notion/v1/pages");
  const byName = Object.fromEntries(pages.map((p) => [p.body.properties.Name.title[0].text.content, p.body]));
  assert.deepEqual(Object.keys(byName).sort(), ["Gemini Down", "Sandrine Rabe", "Spammer"]);
  assert.ok(pages.every((p) => p.headers.authorization === "Bearer fake-notion-token" && p.headers["notion-version"] === "2022-06-28"));
  assert.equal(byName["Sandrine Rabe"].properties.Score.number, 82);
  assert.equal(byName["Spammer"].properties.Status.select.name, "Spam");
  assert.ok(JSON.stringify(byName["Gemini Down"].children).includes("gemini_request_failed"));

  const messages = sent().map((c) => c.body);
  assert.equal(messages.length, 2, "Sandrine and Gemini Down, not the spam");
  assert.ok(messages.every((m) => m.chat_id === "4242" && m.parse_mode === "HTML"));
  assert.ok(messages.some((m) => /82\/100/.test(m.text) && m.text.includes("p-Sandrine%20Rabe")));
  assert.ok(messages.some((m) => /Qualification incomplète \(gemini_request_failed\)/.test(m.text)));
  assert.ok(messages.every((m) => !/sent automatically with n8n/.test(m.text)));

  const acked = of("/worker/api/leads/ack").flatMap((c) => c.body.ids);
  assert.equal(acked.length, 4);
  assert.deepEqual(queue, [], "the queue is empty");
  console.log("✓ run 1: 4 leads — qualified, spam filed silently, invalid dropped, Gemini failure filed — all acknowledged");

  // 2. Notion down: the lead is neither notified nor acknowledged — it stays queued —
  //    and the run itself does not crash.
  calls.length = 0;
  notionDown = true;
  queue = [lead("Waits For Notion")];
  r = await run();
  assert.equal(r.code, 0, r.output);
  assert.equal(of("/notion/v1/pages").length, 1);
  assert.equal(sent().length, 0);
  assert.equal(of("/worker/api/leads/ack").length, 0);
  assert.equal(queue.length, 1);
  console.log("✓ run 2: Notion down — not acknowledged, still queued");

  // 3. Notion back: the same lead goes through.
  calls.length = 0;
  notionDown = false;
  r = await run();
  assert.equal(r.code, 0, r.output);
  assert.equal(sent().length, 1);
  assert.deepEqual(queue, []);
  console.log("✓ run 3: Notion back — the waiting lead is filed, notified and acknowledged");

  // 4. Empty queue: one poll, nothing else.
  calls.length = 0;
  r = await run();
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(calls.map((c) => c.path), ["/worker/api/leads/pending"]);
  console.log("✓ run 4: empty queue — one poll, nothing else");

  console.log("\nall end-to-end checks passed");
}

main()
  .catch((e) => { console.error("✗", e.message); process.exitCode = 1; })
  .finally(() => {
    mock.close();
    rmSync(home, { recursive: true, force: true });
  });
