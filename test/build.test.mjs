import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflow } from "../scripts/build.mjs";

const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

test("every Code node is valid JavaScript once assembled", () => {
  for (const n of workflow.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
    assert.doesNotThrow(() => new Function("$input", "$", "$env", "$execution", n.parameters.jsCode), `${n.name} does not parse`);
    assert.doesNotMatch(n.parameters.jsCode, /require\(|module\.exports|@n8n|__PROMPT__|__SCHEMA__/, n.name);
  }
});

test("the Gemini node carries the real prompt and schema", () => {
  const js = byName["Build Gemini request"].parameters.jsCode;
  assert.ok(js.includes(JSON.stringify(readFileSync(new URL("../prompts/qualify.md", import.meta.url), "utf8"))));
  assert.match(js, /"propertyOrdering"/);
});

test("every connection points at a node that exists", () => {
  for (const [from, { main }] of Object.entries(workflow.connections)) {
    assert.ok(byName[from], `unknown source ${from}`);
    for (const branch of main) for (const link of branch) assert.ok(byName[link.node], `${from} → unknown ${link.node}`);
  }
});

test("node names and ids are unique, and ids are stable", () => {
  assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
  const committed = JSON.parse(readFileSync(new URL("../workflows/lead-intake.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(workflow)), "workflows/lead-intake.json is stale: run node scripts/build.mjs");
});

test("no secret is written into the export", () => {
  const text = JSON.stringify(workflow);
  assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{20,}|secret_[0-9A-Za-z]{20,}|ntn_[0-9A-Za-z]{20,}|\d{8,10}:[0-9A-Za-z_-]{30,}/);
});
