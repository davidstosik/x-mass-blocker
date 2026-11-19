import os from "node:os";
import path from "node:path";

export const DEFAULT_LIST_URL = "https://blockedforaireply.levels.io/api/usernames.txt";

/** X doesn't publish its limits. 400 blocks and unblocks a day is a cautious guess. */
export const DEFAULT_DAILY_CAP = 400;

/**
 * levels.io doesn't publish pardons: a pardoned handle just disappears from the list. So a broken
 * or cut-off download would look like a mass pardon. Unblock at most this many at once unless told to.
 */
export const MASS_UNBLOCK = { minimum: 10, share: 0.05 };

export const EXIT = {
  OK: 0,
  ERROR: 1,
  STOPPED: 2, // rate limit, daily cap or repeated failures: run again later
  NOT_LOGGED_IN: 3,
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

export const TIMING = {
  loginTimeout: 10 * MINUTE,
  loginCookieSettle: 3 * SECOND, // X rotates ct0 right after login
  loginCheckTimeout: 30 * SECOND,
  profileTimeout: 25 * SECOND,
  confirmTimeout: 10 * SECOND, // for X to confirm a block or an unblock
  pollInterval: 500,
  afterBlock: [3 * SECOND, 5 * SECOND],
  afterSkip: [1 * SECOND, 2 * SECOND],
  retryDelays: [30 * SECOND, 15 * MINUTE, 15 * MINUTE],
  rateLimitWait: 15 * MINUTE,
};

export const MAX_FAILURES_IN_A_ROW = 3;

/** Where the session and the results log live. */
export function stateDir(env = process.env) {
  if (env.X_MASS_BLOCKER_HOME) return path.resolve(env.X_MASS_BLOCKER_HOME);
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "x-mass-blocker");
}

export function statePaths(env = process.env) {
  const dir = stateDir(env);
  return {
    dir,
    session: path.join(dir, "session.json"),
    results: path.join(dir, "results.jsonl"),
  };
}
