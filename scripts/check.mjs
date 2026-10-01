// Checks the three outside services before n8n is even installed.
//
//   npm run check
//
// Settings come from .env (NOTION_DATABASE_ID, TELEGRAM_CHAT_ID, GEMINI_MODELS). The three
// secrets come from the environment — GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, NOTION_TOKEN —
// or, when one is missing, are asked for with the input hidden. They are never printed
// and never written anywhere: this process holds them and exits.
//
// What it does:
//   Gemini    one real qualification of samples/lead-en.json with the workflow's own
//             prompt, walking the GEMINI_MODELS chain as the workflow does, printed in full
//
//   npm run check -- --models
//             lists the Gemini text models this key can use, asks each for a tiny JSON
//             answer, and suggests the GEMINI_MODELS line to put in .env
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

/** GEMINI_MODELS (or the older GEMINI_MODEL) as the workflow reads it: a list, preferred first. */
export function modelChain(env) {
  return (env.GEMINI_MODELS || env.GEMINI_MODEL || "gemini-3.6-flash").split(",").map((m) => m.trim()).filter(Boolean);
}

const geminiHeaders = (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" });
const failure = (res) => `${res.status} ${(res.body?.error?.message || "").split("\n")[0]}`.trim();

/** Same walk as the workflow: each model in turn, the first answer wins. */
async function checkGemini(key, models, base) {
  console.log("\nGemini");
  if (!key) return fail("no key given", "create one at https://aistudio.google.com/apikey"), false;
  console.log(dim(`    chain: ${models.join(" → ")}`));

  const prompt = readFileSync(join(root, "prompts/qualify.md"), "utf8");
  const schema = JSON.parse(readFileSync(join(root, "prompts/qualify.schema.json"), "utf8"));
  const { lead } = validate(JSON.parse(readFileSync(join(root, "samples/lead-en.json"), "utf8")));
  const body = JSON.stringify(geminiRequest(lead, prompt, schema));

  for (const model of models) {
    const started = Date.now();
    const res = await call(`${base}/v1beta/models/${model}:generateContent`, { method: "POST", headers: geminiHeaders(key), body });
    if (res.status === 400 || res.status === 403) {
      return fail(`${model}: ${failure(res)}`, "the key is wrong or disabled — copy it again from AI Studio"), false;
    }
    if (res.status !== 200) {
      console.log(`    ${dim(`${model}: ${failure(res)} — next model`)}`);
      continue;
    }
    const q = readQualification(res.body);
    if (q.error) { console.log(`    ${dim(`${model}: answer unreadable (${q.error}) — next model`)}`); continue; }
    ok(`${q.model || model} qualified samples/lead-en.json in ${((Date.now() - started) / 1000).toFixed(1)} s`);
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
  return fail("no model of the chain answered", "overloaded or unavailable — run npm run check -- --models to pick others for GEMINI_MODELS"), false;
}

/* Text-only Gemini models that can answer generateContent — not embeddings, speech,
   images, live audio or computer use, which the workflow has no use for. */
const NOT_FOR_TEXT = /embedding|tts|image|imagen|veo|live|audio|robotics|computer-use|aqa/i;

/** Ranks what answered: flash before flash-lite before the rest, newest version first. */
export function rankModels(names) {
  const family = (n) => (/flash-lite/.test(n) ? 1 : /flash/.test(n) ? 0 : 2);
  const version = (n) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const preview = (n) => (/preview|exp/.test(n) ? 1 : 0);
  return [...names].sort((a, b) => family(a) - family(b) || preview(a) - preview(b) || version(b) - version(a) || a.localeCompare(b));
}

/** Four models for GEMINI_MODELS. When Google is overloaded, a whole family of models
 *  tends to be at once, so the last place goes to a model of another family (a lite
 *  after flashes) when one is answering. Aliases such as gemini-flash-latest are left
 *  out: they move to a new model without warning. */
export function suggestChain(answered, busy = [], size = 4) {
  const stable = (list) => list.filter((n) => !/-latest$/.test(n));
  const pool = [...stable(answered), ...stable(busy)];
  const chain = pool.slice(0, size);
  const familyOf = (n) => (/flash-lite/.test(n) ? "lite" : /flash/.test(n) ? "flash" : "other");
  const families = new Set(chain.map(familyOf));
  if (chain.length === size && families.size === 1) {
    const other = stable(answered).find((n) => familyOf(n) !== familyOf(chain[0]));
    if (other) chain[size - 1] = other;
  }
  return chain;
}

/** --models: what this key can use right now, and the GEMINI_MODELS line to paste. */
async function listModels(key, base, current) {
  console.log("\nGemini models available to this key");
  if (!key) return fail("no key given", "create one at https://aistudio.google.com/apikey"), false;
  const list = await call(`${base}/v1beta/models?pageSize=1000`, { headers: geminiHeaders(key) });
  if (list.status !== 200) return fail(failure(list), "the key is wrong or disabled — copy it again from AI Studio"), false;

  const candidates = (list.body.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.startsWith("gemini") && !NOT_FOR_TEXT.test(n));
  console.log(dim(`    ${candidates.length} text models listed; asking each for a one-field JSON answer…`));

  // The same kind of request the workflow makes — JSON held to a schema — kept tiny.
  const probe = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Answer with ok set to true." }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { ok: { type: "BOOLEAN" } }, required: ["ok"] }, maxOutputTokens: 20 },
  });
  const results = [];
  for (const model of candidates) {
    const started = Date.now();
    const res = await call(`${base}/v1beta/models/${model}:generateContent`, { method: "POST", headers: geminiHeaders(key), body: probe });
    results.push({ model, status: res.status, ms: Date.now() - started, why: res.status === 200 ? "" : failure(res).slice(4, 90) });
  }

  const width = Math.max(...results.map((r) => r.model.length), 10);
  for (const r of results) {
    const mark = r.status === 200 ? green("✓") : r.status === 503 || r.status === 429 ? dim("~") : red("✗");
    console.log(`  ${mark} ${r.model.padEnd(width)}  ${String(r.status).padStart(3)}  ${r.status === 200 ? `${(r.ms / 1000).toFixed(1)} s` : dim(r.why)}`);
  }
  // Answering now first; overloaded (503) or out of quota (429) next — reachable, only
  // busy — and never what the key cannot use at all.
  const answered = rankModels(results.filter((r) => r.status === 200).map((r) => r.model));
  const busy = rankModels(results.filter((r) => r.status === 503 || r.status === 429).map((r) => r.model));
  const chain = suggestChain(answered, busy);
  console.log(dim("\n  ✓ answered   ~ reachable but overloaded or out of quota   ✗ not usable with this key"));
  if (!chain.length) return fail("no model usable right now — retry in a few minutes"), false;
  console.log(`\n  Current: GEMINI_MODELS=${current.join(",")}`);
  console.log(`  Suggested, in .env:\n\n    ${green(`GEMINI_MODELS=${chain.join(",")}`)}\n`);
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
  const geminiBase = env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";

  if (process.argv.includes("--models")) {
    process.exitCode = (await listModels(geminiKey, geminiBase, modelChain(env))) ? 0 : 1;
    process.exit();
  }

  const telegramToken = await secret("TELEGRAM_BOT_TOKEN", "Telegram bot token");
  const notionToken = await secret("NOTION_TOKEN", "Notion API token");

  const results = [
    await checkGemini(geminiKey, modelChain(env), geminiBase),
    await checkTelegram(telegramToken, env.TELEGRAM_CHAT_ID, env.TELEGRAM_API_BASE || "https://api.telegram.org"),
    await checkNotion(notionToken, env.NOTION_DATABASE_ID, env.NOTION_API_BASE || "https://api.notion.com"),
  ];
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed === 3 ? green("All three services are ready.") : red(`${3 - passed} of 3 need attention.`)}`);
  process.exitCode = passed === 3 ? 0 : 1;
}
