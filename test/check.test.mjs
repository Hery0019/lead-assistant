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
