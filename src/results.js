import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Handles with one of these statuses are skipped on later runs (unless --recheck). */
export const FINAL_STATUSES = new Set(["blocked", "already_blocked", "not_found", "suspended"]);

/**
 * The append-only results log: one JSON line per visited handle,
 * `{username, status, note?, at}`. The latest line for a handle wins.
 */
export class ResultLog {
  #latest = new Map(); // lowercase username -> latest entry
  #blockTimes = []; // ms timestamps of "blocked" entries

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

  isDone(username) {
    return FINAL_STATUSES.has(this.latest(username)?.status);
  }

  async record(username, status, note) {
    const entry = { username, status, ...(note ? { note } : {}), at: new Date().toISOString() };
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`);
    this.#remember(entry);
    return entry;
  }

  countBlocksSince(time) {
    return this.#blockTimes.filter((t) => t >= time).length;
  }

  /** Number of handles per latest status. */
  tally() {
    const counts = {};
    for (const { status } of this.#latest.values()) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }

  #remember(entry) {
    this.#latest.set(entry.username.toLowerCase(), entry);
    if (entry.status === "blocked") this.#blockTimes.push(Date.parse(entry.at));
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
