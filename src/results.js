import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";
import { isUserId } from "./user-id.js";

/** Handles with one of these statuses are skipped by later block runs (unless --recheck). */
export const FINAL_STATUSES = new Set(["blocked", "already_blocked", "not_found", "suspended"]);

/** What the tool itself did to an account. Every other status is something it saw. */
const ACTIONS = new Set(["blocked", "unblocked"]);

/** Seen after the tool blocked an account, these mean there is nothing left to unblock. */
const NOTHING_TO_UNBLOCK = new Set(["not_blocked", "not_found", "suspended"]);

/**
 * The append-only results log: one JSON line per visit, `{accountId, username, status, note?, list, userId?, at}`.
 * Runs load a single account's history. Offline stats can load the entire journal.
 */
export class ResultLog {
  #latest = new Map(); // account ID and lowercase username -> latest entry
  #lastAction = new Map(); // account ID and lowercase username -> latest blocked/unblocked entry
  #actionTimes = []; // ms timestamps of blocked/unblocked entries
  #accountId;

  constructor(file, entries = [], accountId) {
    this.file = file;
    this.#accountId = accountId;
    if (accountId !== undefined) {
      if (!isUserId(accountId)) throw new CliError("A verified X account ID is required to scope the journal.");
      if (entries.some((entry) => !isUserId(entry.accountId))) {
        throw new CliError(
          `The results journal at ${file} contains history with an unknown X account owner. ` +
            "Move the journal aside to start fresh, or explicitly migrate each row by adding its verified accountId.",
        );
      }
    }
    for (const entry of entries) {
      if (accountId === undefined || entry.accountId === accountId) this.#remember(entry);
    }
  }

  static async load(file, accountId) {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return new ResultLog(file, parseLog(text), accountId);
  }

  latest(username) {
    return this.#latest.get(this.#key(username, this.#accountId));
  }

  lastAction(username) {
    return this.#lastAction.get(this.#key(username, this.#accountId));
  }

  isDone(username) {
    return FINAL_STATUSES.has(this.latest(username)?.status);
  }

  async record(username, status, { note, list, userId } = {}) {
    if (!this.#accountId) throw new CliError("A verified X account ID is required to record results.");
    const entry = {
      accountId: this.#accountId,
      username,
      status,
      ...(note ? { note } : {}),
      ...(list ? { list } : {}),
      ...(isUserId(userId) ? { userId } : {}),
      at: new Date().toISOString(),
    };
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
   * now). Returns the block entries that establish the original account's ID.
   */
  pardoned(list, handles) {
    const onList = new Set(handles.map((handle) => handle.toLowerCase()));
    return [...this.#lastAction.values()].filter(
      ({ accountId, username, status, list: source, userId }) => status === "blocked" && source === list &&
        isUserId(userId) && !onList.has(username.toLowerCase()) && !NOTHING_TO_UNBLOCK.has(this.#latest.get(this.#key(username, accountId)).status),
    );
  }

  /** Number of handles per latest status. */
  tally() {
    const counts = {};
    for (const { status } of this.#latest.values()) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }

  #key(username, accountId) {
    return `${isUserId(accountId) ? accountId : ""}:${username.toLowerCase()}`;
  }

  #remember(entry) {
    const key = this.#key(entry.username, entry.accountId);
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
