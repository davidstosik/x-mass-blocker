import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listId, loadList, parseList } from "../src/list.js";

test("listId keeps URLs and makes file paths absolute", () => {
  assert.equal(listId("https://example.com/list.txt"), "https://example.com/list.txt");
  assert.equal(listId("sample.txt"), path.resolve("sample.txt"));
});

test("parseList trims lines, drops a leading @ and keeps valid handles", () => {
  const text = "alice\r\n  @bob  \n\ncarol_99\nnot a handle\nhttps://x.com/dave\n" + "x".repeat(51) + "\n";
  assert.deepEqual(parseList(text), ["alice", "bob", "carol_99"]);
});

test("parseList dedupes case-insensitively, keeping the first spelling", () => {
  assert.deepEqual(parseList("Alice\nalice\n@ALICE\nbob\n"), ["Alice", "bob"]);
});

test("loadList reads a local file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-"));
  const file = path.join(dir, "list.txt");
  await writeFile(file, "one\ntwo\n");
  assert.deepEqual(await loadList(file), ["one", "two"]);
});

test("loadList rejects a list without usernames", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-"));
  const file = path.join(dir, "empty.txt");
  await writeFile(file, "\n\n");
  await assert.rejects(loadList(file), /No usernames found/);
});
