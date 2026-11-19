import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Handles with one of these statuses are skipped by later block runs (unless --recheck). */
export const FINAL_STATUSES = new Set(["blocked", "already_blocked", "not_found", "suspended"]);

/** What the tool itself did to an account. Every other status is something it saw. */
const ACTIONS = new Set(["blocked", "unblocked"]);

/** Seen after the tool blocked an account, these mean there is nothing left to unblock. */
const NOTHING_TO_UNBLOCK = new Set(["not_blocked", "not_found", "suspended"]);

/**
 * The append-only results log: one JSON line per visit, `{username, status, note?, list, at}`.
 * The latest line for a handle is its current state; its latest blocked/unblocked line is
 * the last thing the tool did to it. Earlier lines are kept as history.
 */
export class ResultLog {
  #latest = new Map(); // lowercase username -> latest entry
  #lastAction = new Map(); // lowercase username -> latest blocked/unblocked entry
  #actionTimes = []; // ms timestamps of blocked/unblocked entries

  constructor(file, entries = []) {
    this.file = file;
    for (const entry of entries) this.#remember(entry);
  }

  static async load(file) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new ResultLog(file, parseLog(text));
  }

  latest(username) {
    return this.#latest.get(username.toLowerCase());
  }

  lastAction(username) {
    return this.#lastAction.get(username.toLowerCase());
  }

  isDone(username) {
    return FINAL_STATUSES.has(this.latest(username)?.status);
  }

  async record(username, status, { note, list } = {}) {
    const entry = { username, status, ...(note ? { note } : {}), ...(list ? { list } : {}), at: new Date().toISOString() };
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`);
    this.#remember(entry);
    return entry;
  }

  /** Blocks and unblocks made by the tool since `time` (ms), for the daily cap. */
  countActionsSince(time) {
    return this.#actionTimes.filter((t) => t >= time).length;
  }

  /** Accounts the tool blocked from `list` and hasn't unblocked since. */
  blockedFrom(list) {
    return [...this.#lastAction.values()]
      .filter((action) => action.status === "blocked" && action.list === list)
      .map((action) => action.username);
  }

  /**
   * Accounts the tool blocked from `list` that are no longer on it (`handles` is the list as it is
   * now). Accounts that were already blocked before the tool got to them are never included.
   */
  pardoned(list, handles) {
    const onList = new Set(handles.map((handle) => handle.toLowerCase()));
    return this.blockedFrom(list).filter(
      (username) => !onList.has(username.toLowerCase()) && !NOTHING_TO_UNBLOCK.has(this.latest(username).status),
    );
  }

  /** Number of handles per latest status. */
  tally() {
    const counts = {};
    for (const { status } of this.#latest.values()) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }

  #remember(entry) {
    const key = entry.username.toLowerCase();
    this.#latest.set(key, entry);
    if (ACTIONS.has(entry.status)) {
      this.#lastAction.set(key, entry);
      this.#actionTimes.push(Date.parse(entry.at));
    }
  }
}

/** Parses JSONL, skipping blank or broken lines (e.g. one cut short by a crash). */
export function parseLog(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.username === "string" && typeof entry.status === "string") entries.push(entry);
    } catch {
      // ignore
    }
  }
  return entries;
}
