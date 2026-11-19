import { setTimeout as sleep } from "node:timers/promises";
import { readSession, XBrowser } from "./browser.js";
import { DAY, MASS_UNBLOCK, MAX_FAILURES_IN_A_ROW, TIMING } from "./config.js";
import { NotLoggedInError } from "./errors.js";
import { listId, loadList } from "./list.js";
import { checkLogin } from "./login.js";
import { inspectProfile } from "./profile.js";
import { ResultLog } from "./results.js";

const TEMPORARY = new Set(["rate_limited", "error"]);
const ACTED = new Set(["blocked", "unblocked", "would_block", "would_unblock"]);

const STOP_MESSAGES = {
  daily_cap: (cap) => `Daily cap reached (${cap} blocks and unblocks in the last 24 hours).`,
  rate_limited: () => "X keeps rate limiting this account.",
  too_many_failures: () => `${MAX_FAILURES_IN_A_ROW} accounts failed in a row.`,
};

/**
 * Unblocks the accounts it blocked that were removed from the list (pardoned), then blocks
 * every account on the list that isn't done yet. Each result is appended to the log right
 * away, so stopping at any point loses nothing.
 */
export async function run({ paths, list, limit, dailyCap, dryRun, headed, recheck, unblock, allowMassUnblock, progress }) {
  const log = await ResultLog.load(paths.results);
  const source = listId(list);
  const handles = await loadList(list);

  const { toUnblock, heldBack } = unblock
    ? pardonedAccounts(log, source, handles, { allowMassUnblock, progress })
    : { toUnblock: [], heldBack: 0 };
  const toBlock = recheck ? handles : handles.filter((handle) => !log.isDone(handle));
  const tasks = [
    ...toUnblock.map(({ username, userId }) => ({ handle: username, unblock: true, expectedUserId: userId })),
    ...toBlock.map((handle) => ({ handle, unblock: false })),
  ];
  const queue = limit ? tasks.slice(0, limit) : tasks;
  progress(
    `${handles.length} accounts on the list, ${handles.length - toBlock.length} already done` +
      `${toUnblock.length ? `, ${toUnblock.length} removed since the tool blocked them` : ""}. ` +
      `Visiting ${queue.length}${dryRun ? " (dry run: nothing will be blocked or unblocked)" : ""}.`,
  );

  const runner = new Runner({ sessionFile: paths.session, log, list: source, dailyCap, dryRun, headed, progress });
  const stopped = await runner.process(queue);
  if (stopped) progress(`Stopped early: ${STOP_MESSAGES[stopped](dailyCap)} Run again later.`);

  const count = (status) => runner.counts[status] ?? 0;
  const failed = count("failed");
  const acted = [...ACTED].reduce((sum, status) => sum + count(status), 0);
  return {
    dryRun,
    visited: runner.visited,
    blocked: count("blocked"),
    unblocked: count("unblocked"),
    ...(dryRun ? { wouldBlock: count("would_block"), wouldUnblock: count("would_unblock") } : {}),
    skipped: runner.visited - acted - failed,
    failed,
    byStatus: runner.counts,
    remaining: handles.filter((handle) => !log.isDone(handle)).length,
    ...(heldBack ? { unblockHeldBack: heldBack } : {}),
    stopped,
  };
}

/** Accounts to unblock, unless so many left the list at once that the download looks broken. */
function pardonedAccounts(log, source, handles, { allowMassUnblock, progress }) {
  const pardoned = log.pardoned(source, handles);
  const expected = Math.max(MASS_UNBLOCK.minimum, Math.ceil(MASS_UNBLOCK.share * log.blockedFrom(source).length));
  if (pardoned.length <= expected || allowMassUnblock) return { toUnblock: pardoned, heldBack: 0 };

  progress(
    `${pardoned.length} accounts this tool blocked are no longer on the list, more than the ${expected} expected. ` +
      "That could be a broken download, so none will be unblocked. " +
      "If the list really shrank, run again with --allow-mass-unblock.",
  );
  return { toUnblock: [], heldBack: pardoned.length };
}

class Runner {
  counts = {};
  visited = 0;
  #browser = null;
  #page = null;

  constructor({ sessionFile, log, list, dailyCap, dryRun, headed, progress }) {
    Object.assign(this, { sessionFile, log, list, dailyCap, dryRun, headed, progress });
  }

  /** Returns why it stopped early ("daily_cap", "rate_limited", "too_many_failures"), or null. */
  async process(queue) {
    if (queue.length === 0) return null;
    if (this.#dailyCapReached()) return "daily_cap";

    try {
      await this.#ensurePage();
      if ((await checkLogin(this.#page)) !== "in") throw notLoggedIn();

      let failuresInARow = 0;
      for (const [index, task] of queue.entries()) {
        if (this.#dailyCapReached()) return "daily_cap";

        const { status, note, rateLimited, userId } = await this.#visit(task);
        if (!this.dryRun) await this.log.record(task.handle, status, { note, list: this.list, userId });
        this.counts[status] = (this.counts[status] ?? 0) + 1;
        this.visited++;
        const position = `[${String(index + 1).padStart(String(queue.length).length)}/${queue.length}]`;
        const verb = task.unblock ? "unblock" : "block";
        this.progress(`${position} ${verb} @${task.handle}: ${status.replaceAll("_", " ")}${note ? ` (${note})` : ""}`);

        if (status === "failed") {
          if (rateLimited) return "rate_limited";
          if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) return "too_many_failures";
        } else {
          failuresInARow = 0;
        }
        if (index < queue.length - 1) await pause(ACTED.has(status) ? TIMING.afterBlock : TIMING.afterSkip);
      }
      return null;
    } finally {
      await this.#browser?.close();
    }
  }

  /** One account, retrying temporary errors (30s, 15 min, 15 min) before giving up. */
  async #visit({ handle, unblock, expectedUserId }) {
    let actionUserId;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.#attempt(handle, unblock, expectedUserId ?? actionUserId);
      if (outcome.actionSent) actionUserId = outcome.userId ?? null;

      if (!TEMPORARY.has(outcome.status)) {
        // An earlier attempt clicked but couldn't confirm it, and this one finds it done: it went through.
        const echo = unblock ? "not_blocked" : "already_blocked";
        if (actionUserId !== undefined && outcome.status === echo) {
          return { status: unblock ? "unblocked" : "blocked", note: "confirmed on retry", userId: actionUserId };
        }
        return outcome.status === "unblocked" ? { ...outcome, note: "no longer on the list" } : outcome;
      }

      const rateLimited = outcome.status === "rate_limited";
      // A logged-out profile page looks like one that never loads, so check before retrying.
      if (!rateLimited && (await this.#checkLoginQuietly()) === "out") throw notLoggedIn();

      const delays = TIMING.retryDelays;
      if (attempt >= delays.length) return { status: "failed", note: outcome.note, rateLimited };
      const delay = rateLimited ? Math.max(delays[attempt], TIMING.rateLimitWait) : delays[attempt];
      this.progress(`  @${handle}: ${outcome.note ?? outcome.status}. Retrying in ${formatDuration(delay)}.`);
      await sleep(delay);
    }
  }

  async #attempt(handle, unblock, expectedUserId) {
    try {
      await this.#ensurePage();
      const verdict = await inspectProfile(this.#page, handle);
      if (verdict.status === "logged_out") throw notLoggedIn();
      if ((unblock || expectedUserId !== undefined) &&
          (verdict.status === "ready" || verdict.status === "already_blocked")) {
        if (!expectedUserId || !verdict.userId) return { status: "mismatch", note: "could not verify X user ID" };
        if (expectedUserId !== verdict.userId) return { status: "mismatch", note: "X user ID differs from the recorded ID" };
      }
      if (unblock) {
        if (verdict.status === "ready") return { status: "not_blocked" };
        if (verdict.status !== "already_blocked") return verdict;
      } else if (verdict.status !== "ready") {
        return verdict;
      }
      const outcome = await toggleBlock(this.#page, handle, { unblock, dryRun: this.dryRun });
      if (outcome.actionSent) return { ...outcome, userId: verdict.userId };
      return outcome;
    } catch (error) {
      if (error instanceof NotLoggedInError) throw error;
      // Playwright or browser error: start over with a fresh page (or a fresh Chrome) next time.
      await this.#page?.close().catch(() => {});
      this.#page = null;
      return { status: "error", note: error.message.split("\n")[0] };
    }
  }

  async #ensurePage() {
    if (!this.#browser?.isConnected) {
      await this.#browser?.close();
      const storageState = await readSession(this.sessionFile);
      this.#browser = await XBrowser.start({ storageState, headed: this.headed });
      this.#page = null;
    }
    if (!this.#page || this.#page.isClosed()) this.#page = await this.#browser.newPage();
  }

  async #checkLoginQuietly() {
    try {
      await this.#ensurePage();
      return await checkLogin(this.#page);
    } catch {
      return "unknown";
    }
  }

  #dailyCapReached() {
    if (!this.dailyCap || this.dryRun) return false;
    return this.log.countActionsSince(Date.now() - DAY) >= this.dailyCap;
  }
}

/**
 * Blocks (or unblocks) the profile open in `page` through its ··· menu, after checking the menu
 * names the right handle. In a dry run, it only opens the menu and checks it.
 */
async function toggleBlock(page, handle, { unblock, dryRun }) {
  await page.locator('[data-testid="userActions"]').first().click();
  const menu = page.locator('[role="menu"]');
  const item = menu
    .locator('[data-testid="block"], [data-testid="unblock"]')
    .or(menu.getByRole("menuitem", { name: /^(un)?block @\w+$/i }))
    .first();
  if (!(await isVisibleSoon(item))) return closeMenu(page, { status: "error", note: "no Block item in the ··· menu" });

  const text = (await item.innerText()).trim();
  const shown = text.match(/@(\w+)/)?.[1];
  if (shown?.toLowerCase() !== handle.toLowerCase()) {
    return closeMenu(page, { status: "mismatch", note: `menu reads "${text}"` });
  }
  const isBlocked = (await item.getAttribute("data-testid")) === "unblock" || /^unblock/i.test(text);
  if (!unblock && isBlocked) return closeMenu(page, { status: "already_blocked" });
  if (unblock && !isBlocked) return closeMenu(page, { status: "not_blocked" });
  if (dryRun) return closeMenu(page, { status: unblock ? "would_unblock" : "would_block" });

  const endpoint = unblock ? "/blocks/destroy" : "/blocks/create";
  const response = page.waitForResponse((r) => new URL(r.url()).pathname.includes(endpoint), {
    timeout: TIMING.confirmTimeout + 5000,
  });
  response.catch(() => {}); // handled below; this only avoids an unhandled rejection
  await item.click();
  // X always asks to confirm a block. An unblock may go through without asking.
  const confirm = page.locator('[data-testid="confirmationSheetConfirm"]');
  if (unblock) await confirm.click({ timeout: 3000 }).catch(() => {});
  else await confirm.click({ timeout: 5000 });
  return { ...(await confirmation(page, response, { unblock })), actionSent: true };
}

/**
 * Success is a 2xx from X's API, or the profile's button changing within 10s:
 * "Blocked" (…-unblock) after a block, "Follow" (…-follow) after an unblock.
 */
async function confirmation(page, responsePromise, { unblock }) {
  const done = unblock ? "unblocked" : "blocked";
  const fromApi = responsePromise.then((response) => {
    if (response.ok()) return { status: done };
    const note = `${unblock ? "blocks/destroy" : "blocks/create"} returned HTTP ${response.status()}`;
    return { status: response.status() === 429 ? "rate_limited" : "error", note };
  });
  const button = unblock ? '[data-testid$="-follow"]' : '[data-testid$="-unblock"]';
  const fromPage = page
    .locator(`[data-testid="primaryColumn"] ${button}`)
    .first()
    .waitFor({ timeout: TIMING.confirmTimeout })
    .then(() => ({ status: done }));
  try {
    return await Promise.any([fromApi, fromPage]);
  } catch {
    return { status: "error", note: `${unblock ? "unblock" : "block"} not confirmed within 10s` };
  }
}

async function closeMenu(page, outcome) {
  await page.keyboard.press("Escape");
  return outcome;
}

async function isVisibleSoon(locator) {
  try {
    await locator.waitFor({ timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function pause([min, max]) {
  return sleep(min + Math.random() * (max - min));
}

function formatDuration(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;
}

function notLoggedIn() {
  return new NotLoggedInError("Not logged in to X: the saved session expired or was logged out. Run `x-mass-blocker login` again.");
}
