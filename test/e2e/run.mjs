// End-to-end: the real n8n, the real workflow export, fake Gemini / Notion / Telegram.
//
//   N8N_BIN=/path/to/node_modules/.bin/n8n npm run e2e
//
// Starts n8n on a throwaway SQLite database, imports test credentials and
// workflows/lead-intake.json, publishes it, then replays the samples against the webhook
// and checks what reached each fake API. Nothing leaves the machine: the three APIs are
// a local HTTP server, reached through the *_API_BASE settings and the Telegram
// credential's base URL.

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { workflow } from "../../scripts/build.mjs";

const N8N = process.env.N8N_BIN || "n8n";
const N8N_PORT = 15678;
const MOCK_PORT = 15679;
const TOKEN = "e2e-" + randomBytes(8).toString("hex");
const root = new URL("../../", import.meta.url);
const sample = (name) => JSON.parse(readFileSync(new URL(`samples/${name}.json`, root), "utf8"));

// ---------------------------------------------------------------- fake APIs

const calls = [];
const qualificationFor = (lead) => {
  const spam = /backlink|SEO package/i.test(lead.message);
  const vague = lead.message.length < 40;
  return {
    language: /[àéè]|bonjour|combien/i.test(lead.message) ? "fr" : "en",
    summary: `Résumé de test pour ${lead.name}.`,
    projectType: spam ? "other" : vague ? "showcase" : "ecommerce",
    budgetFit: lead.budget ? "realistic" : "unknown",
    urgency: "normal",
    score: spam ? 0 : vague ? 18 : 82,
    scoreReasons: spam ? ["Spam"] : ["Raison de test"],
    missingInfo: vague ? ["Quel type de site ?"] : [],
    isSpam: spam,
    replySubject: spam ? "" : "Re: votre projet",
    replyDraft: spam ? "" : `Bonjour ${lead.name},\n\nMerci.\n\nHery`,
  };
};

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: json });
    const send = (status, payload) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); };
    if (req.url.startsWith("/gemini/")) {
      const lead = JSON.parse(json.contents[0].parts[0].text);
      return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(qualificationFor(lead)) }] }, finishReason: "STOP" }] });
    }
    if (req.url === "/notion/v1/pages") return send(200, { object: "page", id: "p-" + calls.length, url: `https://www.notion.so/p-${calls.length}` });
    if (/^\/telegram\/bot[^/]+\/sendMessage$/.test(req.url)) return send(200, { ok: true, result: { message_id: calls.length } });
    send(404, { error: "unexpected " + req.url });
  });
});

// ---------------------------------------------------------------------- n8n

const home = mkdtempSync(join(tmpdir(), "lead-assistant-e2e-"));
const env = {
  ...process.env,
  N8N_USER_FOLDER: home,
  N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
  N8N_PORT: String(N8N_PORT),
  N8N_LISTEN_ADDRESS: "127.0.0.1",
  N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_PERSONALIZATION_ENABLED: "false",
  N8N_RUNNERS_BROKER_PORT: "15680",
  DB_SQLITE_POOL_SIZE: "2",
  GEMINI_MODEL: "gemini-test",
  GEMINI_API_BASE: `http://127.0.0.1:${MOCK_PORT}/gemini`,
  NOTION_API_BASE: `http://127.0.0.1:${MOCK_PORT}/notion`,
  NOTION_DATABASE_ID: "db-e2e",
  TELEGRAM_CHAT_ID: "4242",
};

const cred = (type, name, data) => {
  const [c] = Object.values(workflow.nodes.flatMap((n) => Object.entries(n.credentials || {}))
    .filter(([t, v]) => t === type && v.name === name).map(([, v]) => v));
  return { id: c.id, name, type, data };
};
const credentials = [
  cred("httpHeaderAuth", "Lead webhook token", { name: "X-Lead-Token", value: TOKEN }),
  cred("httpHeaderAuth", "Gemini API key", { name: "x-goog-api-key", value: "fake-gemini-key" }),
  cred("httpHeaderAuth", "Notion integration token", { name: "Authorization", value: "Bearer fake-notion-token" }),
  cred("telegramApi", "Telegram bot", { accessToken: "123:fake", baseUrl: `http://127.0.0.1:${MOCK_PORT}/telegram` }),
];

const cli = (...args) => execFileSync(N8N, args, { env, stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, check, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
};

let server;
let log = "";
const post = (body, headers = { "X-Lead-Token": TOKEN }) =>
  fetch(`http://127.0.0.1:${N8N_PORT}/webhook/lead`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

  writeFileSync(join(home, "credentials.json"), JSON.stringify(credentials));
  cli("import:credentials", `--input=${join(home, "credentials.json")}`);
  cli("import:workflow", `--input=${new URL("workflows/lead-intake.json", root).pathname}`);
  cli("publish:workflow", `--id=${workflow.id}`);
  console.log("✓ imported and published");

  server = spawn(N8N, ["start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  await until("n8n to start", async () => (await fetch(`http://127.0.0.1:${N8N_PORT}/healthz`).catch(() => null))?.ok, 120000)
    .catch((e) => { console.error(log); throw e; });
  // /healthz answers before published workflows are registered: n8n activates them in
  // the background a moment later. Until then the webhook is a 404.
  await until("the webhook to be registered", async () => (await post({}, {})).status !== 404, 60000);
  console.log("✓ n8n is up, webhook registered");

  // 1. No token, wrong token: refused before anything runs.
  assert.equal((await post(sample("lead-fr"), {})).status, 403);
  assert.equal((await post(sample("lead-fr"), { "X-Lead-Token": "nope" })).status, 403);
  console.log("✓ 403 without the right token");

  // 2. Missing fields: 400 with the list, no API called.
  const bad = await post({ email: "x@y.co" });
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).fields, ["name", "message", "source"]);
  assert.equal(calls.length, 0);
  console.log("✓ 400 with the missing fields, nothing called");

  // 3. A real lead: 202 at once, then Gemini → Notion → Telegram.
  const ok = await post(sample("lead-fr"));
  assert.equal(ok.status, 202);
  assert.equal((await ok.json()).ok, true);
  await until("the Telegram notification", () => calls.some((c) => c.url.includes("/sendMessage")));
  const [gemini, notion, telegram] = calls;
  assert.equal(gemini.url, "/gemini/v1beta/models/gemini-test:generateContent");
  assert.equal(gemini.headers["x-goog-api-key"], "fake-gemini-key");
  assert.equal(gemini.body.generationConfig.responseMimeType, "application/json");
  assert.match(gemini.body.systemInstruction.parts[0].text, /You triage the enquiries/);
  assert.equal(notion.headers.authorization, "Bearer fake-notion-token");
  assert.equal(notion.headers["notion-version"], "2022-06-28");
  assert.equal(notion.body.parent.database_id, "db-e2e");
  assert.equal(notion.body.properties.Score.number, 82);
  assert.equal(telegram.url, "/telegram/bot123:fake/sendMessage");
  assert.equal(telegram.body.chat_id, "4242");
  assert.equal(telegram.body.parse_mode, "HTML");
  assert.match(telegram.body.text, /82\/100/);
  assert.match(telegram.body.text, /https:\/\/www\.notion\.so\/p-2/);
  assert.doesNotMatch(telegram.body.text, /sent automatically with n8n/);
  console.log("✓ lead-fr: 202, Gemini → Notion → Telegram");

  // 4. Spam: filed in Notion, no Telegram.
  calls.length = 0;
  assert.equal((await post({ ...sample("lead-vague"), message: "Cheap backlink and SEO package, 500 links for $50" })).status, 202);
  await until("the Notion page", () => calls.some((c) => c.url === "/notion/v1/pages"));
  await sleep(2000);
  assert.equal(calls.find((c) => c.url === "/notion/v1/pages").body.properties.Status.select.name, "Spam");
  assert.equal(calls.some((c) => c.url.includes("/sendMessage")), false);
  console.log("✓ spam: filed as Spam, no notification");

  console.log("\nall end-to-end checks passed");
}

main()
  .catch((e) => { console.error(log.split("\n").slice(-40).join("\n")); console.error("✗", e.message); process.exitCode = 1; })
  .finally(() => {
    server?.kill("SIGTERM");
    mock.close();
    rmSync(home, { recursive: true, force: true });
  });
