import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { DAY, statePaths } from "../src/config.js";
import { ResultLog, parseLog } from "../src/results.js";

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-"));
  return path.join(dir, "nested", "results.jsonl");
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
const LIST = "https://example.com/list.txt";
const entry = (username, status, extra = {}) => ({ username, status, list: LIST, at: hoursAgo(1), ...extra });

test("a missing log loads as empty", async () => {
  const log = await ResultLog.load(await tempFile());
  assert.deepEqual(log.tally(), {});
  assert.equal(log.isDone("alice"), false);
});

test("record appends one JSON line and creates the folder", async () => {
  const file = await tempFile();
  const log = await ResultLog.load(file);
  await log.record("alice", "blocked", { list: LIST, userId: "9007199254740993" });
  await log.record("bob", "failed", { note: "HTTP 500", list: LIST });

  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].userId, "9007199254740993");
  assert.equal((await ResultLog.load(file)).lastAction("alice").userId, lines[0].userId);
  assert.deepEqual(Object.keys(lines[1]), ["username", "status", "note", "list", "at"]);
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
  const statuses = [
    "blocked",
    "already_blocked",
    "not_found",
    "suspended",
    "unblocked",
    "not_blocked",
    "unavailable",
    "mismatch",
    "failed",
  ];
  const log = new ResultLog("unused", statuses.map((status) => entry(status, status)));
  assert.deepEqual(
    statuses.filter((status) => log.isDone(status)),
    ["blocked", "already_blocked", "not_found", "suspended"],
  );
});

test("lastAction is the latest block or unblock, whatever was seen after it", () => {
  const log = new ResultLog("unused", [
    entry("alice", "blocked", { at: hoursAgo(50) }),
    entry("alice", "already_blocked", { at: hoursAgo(20) }), // a --recheck
    entry("bob", "blocked", { at: hoursAgo(40) }),
    entry("bob", "unblocked", { at: hoursAgo(10) }),
    entry("carol", "already_blocked"),
  ]);
  assert.equal(log.lastAction("alice").at, hoursAgo(50));
  assert.equal(log.latest("alice").status, "already_blocked");
  assert.equal(log.lastAction("bob").status, "unblocked");
  assert.equal(log.lastAction("carol"), undefined);
});

test("countActionsSince counts the tool's blocks and unblocks in the window", () => {
  const log = new ResultLog("unused", [
    entry("a", "blocked", { at: hoursAgo(30) }),
    entry("b", "blocked", { at: hoursAgo(5) }),
    entry("c", "already_blocked", { at: hoursAgo(2) }),
    entry("a", "unblocked", { at: hoursAgo(1) }),
  ]);
  assert.equal(log.countActionsSince(Date.now() - DAY), 2);
});

describe("pardoned", () => {
  const log = new ResultLog("unused", [
    entry("kept", "blocked"),
    entry("pardoned", "blocked"),
    entry("rechecked", "blocked"),
    entry("rechecked", "already_blocked"),
    entry("userBlocked", "already_blocked"),
    entry("otherList", "blocked", { list: "/tmp/other.txt" }),
    entry("doneBefore", "blocked"),
    entry("doneBefore", "unblocked"),
    entry("unblockedByHand", "blocked"),
    entry("unblockedByHand", "not_blocked"),
    entry("deleted", "blocked"),
    entry("deleted", "not_found"),
    entry("retry", "blocked"),
    entry("retry", "failed"),
  ].map((result) => ({ ...result, userId: "123" })).concat(
    entry("legacy", "blocked"),
    entry("legacy", "already_blocked", { userId: "456" }),
    entry("invalidId", "blocked", { userId: 123 }),
  ));

  test("returns the tool's blocks from this list that left it", () => {
    assert.deepEqual(log.pardoned(LIST, ["kept"]).map(({ username, userId }) => [username, userId]), [
      ["pardoned", "123"], ["rechecked", "123"], ["retry", "123"],
    ]);
  });

  test("matches the list case-insensitively", () => {
    assert.deepEqual(log.pardoned(LIST, ["KEPT", "Pardoned", "RECHECKED", "retry"]), []);
  });

  test("blockedFrom counts what the tool blocked from a list and hasn't unblocked", () => {
    assert.deepEqual(log.blockedFrom("/tmp/other.txt"), ["otherList"]);
    assert.equal(log.blockedFrom(LIST).length, 8);
  });
});

test("blank and broken lines are skipped", async () => {
  const good = JSON.stringify(entry("alice", "blocked"));
  const text = `${good}\n\nnot json\n{"username":"bob"}\n{"username":"carol","sta`;
  assert.deepEqual(parseLog(text).map((e) => e.username), ["alice"]);

  const file = path.join(await mkdtemp(path.join(tmpdir(), "x-mass-blocker-")), "results.jsonl");
  await writeFile(file, text);
  assert.deepEqual((await ResultLog.load(file)).tally(), { blocked: 1 });
});

test("statePaths honors X_MASS_BLOCKER_HOME, then XDG_CONFIG_HOME", () => {
  assert.equal(statePaths({ X_MASS_BLOCKER_HOME: "/tmp/xmb" }).session, "/tmp/xmb/session.json");
  assert.equal(statePaths({ XDG_CONFIG_HOME: "/cfg" }).results, "/cfg/x-mass-blocker/results.jsonl");
});
