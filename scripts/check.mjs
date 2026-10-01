// Checks the three outside services before n8n is even installed.
//
//   npm run check
//
// Settings come from .env (NOTION_DATABASE_ID, TELEGRAM_CHAT_ID, GEMINI_MODEL). The three
// secrets come from the environment — GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, NOTION_TOKEN —
// or, when one is missing, are asked for with the input hidden. They are never printed
// and never written anywhere: this process holds them and exits.
//
// What it does:
//   Gemini    the key and the model answer, then one real qualification of
//             samples/lead-en.json with the workflow's own prompt, printed in full
//   Telegram  the token is valid, and the bot can write to you (sends one test message)
//   Notion    the database exists, the connection can see it, and each property has
//             the name and the type the workflow writes

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { geminiRequest } = require("../src/qualify.js");
const { readQualification } = require("../src/parse.js");
const { validate } = require("../src/validate.js");
const { PROPERTIES } = require("../src/notion.js");

// ------------------------------------------------------------------ helpers

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => console.log(`  ${green("✓")} ${s}`);
const fail = (s, hint) => { console.log(`  ${red("✗")} ${s}`); if (hint) console.log(`    ${dim("→ " + hint)}`); };

/** Asks for a value without echoing it. */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return resolve("");
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          stdout.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") { stdout.write("\n"); process.exit(130); }        // Ctrl+C
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; } // Backspace
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function secret(name, label) {
  if (process.env[name]) return process.env[name].trim();
  return askHidden(`${label} ${dim(`(${name}, hidden)`)}: `);
}

async function call(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { error: e.cause?.code || e.name || String(e) } };
  }
}

/** Compares a Notion database to what the workflow writes. Exported for the tests. */
export function notionIssues(database, expected = PROPERTIES) {
  const actual = database?.properties || {};
  const issues = [];
  for (const [name, type] of Object.entries(expected)) {
    if (!actual[name]) {
      const near = Object.keys(actual).find((k) => k.trim().toLowerCase() === name.toLowerCase());
      issues.push(near ? `"${near}" should be named exactly "${name}"` : `missing property "${name}" (${type})`);
    } else if (actual[name].type !== type) {
      issues.push(`"${name}" is ${actual[name].type}, should be ${type}`);
    }
  }
  return issues;
}

// ------------------------------------------------------------------- checks

const RETRY_DELAYS_MS = (process.env.CHECK_RETRY_DELAYS_MS || "5000,10000,20000").split(",").map(Number);

async function checkGemini(key, model, base) {
  console.log("\nGemini");
  if (!key) return fail("no key given", "create one at https://aistudio.google.com/apikey"), false;
  const headers = { "x-goog-api-key": key, "Content-Type": "application/json" };

  const info = await call(`${base}/v1beta/models/${model}`, { headers });
  if (info.status !== 200) {
    const msg = info.body?.error?.message || JSON.stringify(info.body);
    const hint = info.status === 400 || info.status === 403 ? "the key is wrong or disabled — copy it again from AI Studio"
      : info.status === 404 ? `no model "${model}" — check GEMINI_MODEL in .env`
      : info.status === 0 ? "no connection to Google — check the network" : null;
    return fail(`${info.status} ${msg}`, hint), false;
  }
  ok(`key accepted, model ${info.body.displayName || model}`);

  const prompt = readFileSync(join(root, "prompts/qualify.md"), "utf8");
  const schema = JSON.parse(readFileSync(join(root, "prompts/qualify.schema.json"), "utf8"));
  const { lead } = validate(JSON.parse(readFileSync(join(root, "samples/lead-en.json"), "utf8")));
  const started = Date.now();
  // 429 (free-tier quota) and 503 (model overloaded) are temporary: retry like the
  // workflow does, a little longer each time, before calling it a failure.
  let res;
  for (const wait of [0, ...RETRY_DELAYS_MS]) {
    if (wait) {
      console.log(`    ${dim(`${res.status} — retrying in ${wait / 1000} s`)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
    res = await call(`${base}/v1beta/models/${model}:generateContent`, {
      method: "POST", headers, body: JSON.stringify(geminiRequest(lead, prompt, schema)),
    });
    if (res.status !== 429 && res.status !== 503) break;
  }
  if (res.status !== 200) {
    const hint = res.status === 429 ? "free-tier quota reached — wait a minute and retry"
      : res.status === 503 ? "Google's servers are overloaded — retry in a few minutes, or set GEMINI_MODEL to another model in .env"
      : null;
    return fail(`qualification failed: ${res.status} ${res.body?.error?.message || ""}`, hint), false;
  }
  const q = readQualification(res.body);
  if (q.error) return fail(`answer unreadable: ${q.error}`), false;
  ok(`real qualification of samples/lead-en.json in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(dim([
    `      score ${q.score}/100 · ${q.projectType} · budget ${q.budgetFit} · urgency ${q.urgency} · ${q.language}${q.isSpam ? " · SPAM" : ""}`,
    `      ${q.summary}`,
    ...q.scoreReasons.map((r) => `      + ${r}`),
    ...q.missingInfo.map((m) => `      ? ${m}`),
    `      ── ${q.replySubject}`,
    ...q.replyDraft.split("\n").map((l) => `      ${l}`),
  ].join("\n")));
  return true;
}

async function checkTelegram(token, chatId, base) {
  console.log("\nTelegram");
  if (!token) return fail("no bot token given", "ask @BotFather, /mybots → your bot → API Token"), false;
  const me = await call(`${base}/bot${token}/getMe`);
  if (!me.body?.ok) return fail(`token refused (${me.status})`, "copy the token from @BotFather again"), false;
  ok(`bot @${me.body.result.username}`);

  if (!chatId) return fail("TELEGRAM_CHAT_ID is empty in .env", "send /start to @userinfobot to get your Id"), false;
  const sent = await call(`${base}/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: "✅ lead-assistant : le bot peut t'écrire. (message de test de npm run check)" }),
  });
  if (!sent.body?.ok) {
    const d = sent.body?.description || "";
    const hint = /chat not found/i.test(d) ? `open @${me.body.result.username} and press Start, then check TELEGRAM_CHAT_ID`
      : /blocked/i.test(d) ? `you blocked @${me.body.result.username} — unblock it and press Start` : null;
    return fail(`cannot write to chat ${chatId}: ${d}`, hint), false;
  }
  ok(`test message delivered to chat ${chatId} — check Telegram`);
  return true;
}

async function checkNotion(token, databaseId, base) {
  console.log("\nNotion");
  if (!token) return fail("no token given", "Developer tools → Connections → lead-assistant → API token"), false;
  if (!databaseId) return fail("NOTION_DATABASE_ID is empty in .env", "the 32 characters before ?v= in the database link"), false;
  const id = databaseId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(id)) return fail(`"${databaseId}" is not a database id`, "32 hexadecimal characters, from the link, before ?v="), false;

  const db = await call(`${base}/v1/databases/${id}`, {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  if (db.status === 401) return fail("token refused", "copy the API token of the lead-assistant connection again"), false;
  if (db.status === 404) return fail("database not found", "⋯ → Connections on the database: is lead-assistant added? Is the id the database's, not the view's?"), false;
  if (db.status !== 200) return fail(`${db.status} ${db.body?.message || ""}`), false;
  ok(`database "${db.body.title?.map((t) => t.plain_text).join("") || id}" reachable`);

  const issues = notionIssues(db.body);
  if (issues.length) {
    for (const issue of issues) fail(issue);
    console.log(`    ${dim("→ fix these in Notion — see docs/notion.md")}`);
    return false;
  }
  ok(`all ${Object.keys(PROPERTIES).length} properties present, with the right types`);
  return true;
}

// --------------------------------------------------------------------- main

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  else console.log(dim("No .env yet — cp .env.example .env and fill in the settings."));
  const env = process.env;

  console.log("Secrets are read here, never shown, never saved.");
  const geminiKey = await secret("GEMINI_API_KEY", "Gemini API key");
  const telegramToken = await secret("TELEGRAM_BOT_TOKEN", "Telegram bot token");
  const notionToken = await secret("NOTION_TOKEN", "Notion API token");

  const results = [
    await checkGemini(geminiKey, env.GEMINI_MODEL || "gemini-3.6-flash", env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com"),
    await checkTelegram(telegramToken, env.TELEGRAM_CHAT_ID, env.TELEGRAM_API_BASE || "https://api.telegram.org"),
    await checkNotion(notionToken, env.NOTION_DATABASE_ID, env.NOTION_API_BASE || "https://api.notion.com"),
  ];
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed === 3 ? green("All three services are ready.") : red(`${3 - passed} of 3 need attention.`)}`);
  process.exitCode = passed === 3 ? 0 : 1;
}
