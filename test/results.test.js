import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DAY, statePaths } from "../src/config.js";
import { ResultLog, parseLog } from "../src/results.js";

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-"));
  return path.join(dir, "nested", "results.jsonl");
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

test("a missing log loads as empty", async () => {
  const log = await ResultLog.load(await tempFile());
  assert.deepEqual(log.tally(), {});
  assert.equal(log.isDone("alice"), false);
});

test("record appends one JSON line and creates the folder", async () => {
  const file = await tempFile();
  const log = await ResultLog.load(file);
  await log.record("alice", "blocked");
  await log.record("bob", "failed", "HTTP 500");

  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]), ["username", "status", "at"]);
  assert.equal(lines[1].note, "HTTP 500");
});

test("the latest status per handle wins, case-insensitively", async () => {
  const file = await tempFile();
  const first = await ResultLog.load(file);
  await first.record("Alice", "failed");
  await first.record("alice", "blocked");
  await first.record("bob", "mismatch");

  const log = await ResultLog.load(file);
  assert.equal(log.latest("ALICE").status, "blocked");
  assert.equal(log.isDone("alice"), true);
  assert.equal(log.isDone("bob"), false);
  assert.deepEqual(log.tally(), { blocked: 1, mismatch: 1 });
});

test("only blocked, already_blocked, not_found and suspended are final", () => {
  const statuses = ["blocked", "already_blocked", "not_found", "suspended", "unavailable", "mismatch", "failed"];
  const log = new ResultLog("unused", statuses.map((status) => ({ username: status, status, at: hoursAgo(1) })));
  assert.deepEqual(
    statuses.filter((status) => log.isDone(status)),
    ["blocked", "already_blocked", "not_found", "suspended"],
  );
});

test("countBlocksSince counts blocks made by the tool in the window", () => {
  const log = new ResultLog("unused", [
    { username: "a", status: "blocked", at: hoursAgo(30) },
    { username: "b", status: "blocked", at: hoursAgo(5) },
    { username: "c", status: "already_blocked", at: hoursAgo(2) },
    { username: "d", status: "blocked", at: hoursAgo(1) },
  ]);
  assert.equal(log.countBlocksSince(Date.now() - DAY), 2);
});

test("blank and broken lines are skipped", async () => {
  const good = JSON.stringify({ username: "alice", status: "blocked", at: hoursAgo(1) });
  const text = `${good}\n\nnot json\n{"username":"bob"}\n{"username":"carol","sta`;
  assert.deepEqual(parseLog(text).map((entry) => entry.username), ["alice"]);

  const file = path.join(await mkdtemp(path.join(tmpdir(), "x-mass-blocker-")), "results.jsonl");
  await writeFile(file, text);
  assert.deepEqual((await ResultLog.load(file)).tally(), { blocked: 1 });
});

test("statePaths honors X_MASS_BLOCKER_HOME, then XDG_CONFIG_HOME", () => {
  assert.equal(statePaths({ X_MASS_BLOCKER_HOME: "/tmp/xmb" }).session, "/tmp/xmb/session.json");
  assert.equal(statePaths({ XDG_CONFIG_HOME: "/cfg" }).results, "/cfg/x-mass-blocker/results.jsonl");
});
