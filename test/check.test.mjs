import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { notionIssues } from "../scripts/check.mjs";

const { PROPERTIES } = createRequire(import.meta.url)("../src/notion.js");
const database = (props) => ({ properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])) });

test("a database built as documented has no issue", () => {
  assert.deepEqual(notionIssues(database(PROPERTIES)), []);
});

test("extra properties are fine", () => {
  assert.deepEqual(notionIssues(database({ ...PROPERTIES, Notes: "rich_text", Tags: "multi_select" })), []);
});

test("an emptied title column is reported as missing Name", () => {
  const { Name, ...rest } = PROPERTIES;
  assert.deepEqual(notionIssues(database({ ...rest, "": "title" })), ['missing property "Name" (title)']);
});

test("a wrong case or a stray space is named, not just reported missing", () => {
  const { "Budget fit": _, ...rest } = PROPERTIES;
  assert.deepEqual(notionIssues(database({ ...rest, "budget fit ": "select" })), ['"budget fit " should be named exactly "Budget fit"']);
});

test("Status created with Notion's Status type instead of Select is caught", () => {
  assert.deepEqual(notionIssues(database({ ...PROPERTIES, Status: "status" })), ['"Status" is status, should be select']);
});

import { modelChain, rankModels } from "../scripts/check.mjs";

test("the model chain is read like the workflow reads it", () => {
  assert.deepEqual(modelChain({ GEMINI_MODELS: " gemini-3.6-flash, gemini-3.8-flash ,," }), ["gemini-3.6-flash", "gemini-3.8-flash"]);
  assert.deepEqual(modelChain({ GEMINI_MODEL: "gemini-3.8-flash" }), ["gemini-3.8-flash"]);
  assert.deepEqual(modelChain({ GEMINI_MODELS: "a,b", GEMINI_MODEL: "c" }), ["a", "b"]);
  assert.deepEqual(modelChain({}), ["gemini-3.6-flash"]);
});

test("suggested models: flash, then flash-lite, then the rest; stable before preview; newest first", () => {
  assert.deepEqual(
    rankModels(["gemini-3.6-pro", "gemini-3.6-flash-lite", "gemini-3.8-flash-preview-09", "gemini-3.6-flash", "gemini-3.8-flash"]),
    ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.8-flash-preview-09", "gemini-3.6-flash-lite", "gemini-3.6-pro"],
  );
});
