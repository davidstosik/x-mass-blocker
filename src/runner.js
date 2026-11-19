import { setTimeout as sleep } from "node:timers/promises";
import { XBrowser } from "./browser.js";
import { DAY, MAX_FAILURES_IN_A_ROW, TIMING } from "./config.js";
import { NotLoggedInError } from "./errors.js";
import { loadList } from "./list.js";
import { inspectProfile, isLoginUrl } from "./profile.js";
import { ResultLog } from "./results.js";

const TEMPORARY = new Set(["rate_limited", "error"]);

const STOP_MESSAGES = {
  daily_cap: (cap) => `Daily cap reached (${cap} blocks in the last 24 hours).`,
  rate_limited: () => "X keeps rate limiting this account.",
  too_many_failures: () => `${MAX_FAILURES_IN_A_ROW} accounts failed in a row.`,
};

/**
 * Visits every handle on the list that isn't done yet and blocks it.
 * Each result is appended to the log right away, so stopping at any point loses nothing.
 */
export async function run({ paths, list, limit, dailyCap, dryRun, headed, recheck, progress }) {
  const log = await ResultLog.load(paths.results);
  const handles = await loadList(list);
  const pending = recheck ? handles : handles.filter((handle) => !log.isDone(handle));
  const queue = limit ? pending.slice(0, limit) : pending;
  progress(
    `${handles.length} accounts on the list, ${handles.length - pending.length} already done. ` +
      `Visiting ${queue.length}${dryRun ? " (dry run: nothing will be blocked)" : ""}.`,
  );

  const runner = new Runner({ sessionFile: paths.session, log, dailyCap, dryRun, headed, progress });
  const stopped = await runner.process(queue);
  if (stopped) progress(`Stopped early: ${STOP_MESSAGES[stopped](dailyCap)} Run again later.`);

  const counts = runner.counts;
  const blocked = counts.blocked ?? 0;
  const failed = counts.failed ?? 0;
  const wouldBlock = counts.would_block ?? 0;
  return {
    dryRun,
    visited: runner.visited,
    blocked,
    ...(dryRun ? { wouldBlock } : {}),
    skipped: runner.visited - blocked - failed - wouldBlock,
    failed,
    byStatus: counts,
    remaining: handles.filter((handle) => !log.isDone(handle)).length,
    stopped,
  };
}

class Runner {
  counts = {};
  visited = 0;
  #browser = null;
  #page = null;

  constructor({ sessionFile, log, dailyCap, dryRun, headed, progress }) {
    Object.assign(this, { sessionFile, log, dailyCap, dryRun, headed, progress });
  }

  /** Returns why it stopped early ("daily_cap", "rate_limited", "too_many_failures"), or null. */
  async process(queue) {
    if (queue.length === 0) return null;
    if (this.#dailyCapReached()) return "daily_cap";

    try {
      await this.#ensurePage();
      if ((await checkLogin(this.#page)) !== "in") throw notLoggedIn();

      let failuresInARow = 0;
      for (const [index, handle] of queue.entries()) {
        if (this.#dailyCapReached()) return "daily_cap";

        const { status, note, rateLimited } = await this.#visit(handle);
        if (!this.dryRun) await this.log.record(handle, status, note);
        this.counts[status] = (this.counts[status] ?? 0) + 1;
        this.visited++;
        this.progress(`[${String(index + 1).padStart(String(queue.length).length)}/${queue.length}] @${handle}: ${status.replaceAll("_", " ")}${note ? ` (${note})` : ""}`);

        if (status === "failed") {
          if (rateLimited) return "rate_limited";
          if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) return "too_many_failures";
        } else {
          failuresInARow = 0;
        }
        if (index < queue.length - 1) await pause(status === "blocked" ? TIMING.afterBlock : TIMING.afterSkip);
      }
      return null;
    } finally {
      await this.#browser?.close();
    }
  }

  /** One handle, retrying temporary errors (30s, 15 min, 15 min) before giving up. */
  async #visit(handle) {
    let blockSent = false;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.#attempt(handle);
      blockSent ||= Boolean(outcome.blockSent);

      if (!TEMPORARY.has(outcome.status)) {
        // An earlier attempt clicked "Block" but couldn't confirm it: that block went through.
        if (outcome.status === "already_blocked" && blockSent) return { status: "blocked", note: "confirmed on retry" };
        return outcome;
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

  async #attempt(handle) {
    try {
      await this.#ensurePage();
      const verdict = await inspectProfile(this.#page, handle);
      if (verdict.status === "logged_out") throw notLoggedIn();
      if (verdict.status !== "ready") return verdict;
      return await blockFromProfile(this.#page, handle, { dryRun: this.dryRun });
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
      this.#browser = await XBrowser.start({ sessionFile: this.sessionFile, headed: this.headed });
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
    return !this.dryRun && this.log.countBlocksSince(Date.now() - DAY) >= this.dailyCap;
  }
}

/** Resolves to "in", "out", or "unknown" if X showed neither within 30s. */
async function checkLogin(page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: TIMING.loginCheckTimeout });
  const cookies = await page.context().cookies("https://x.com");
  if (!cookies.some((cookie) => cookie.name === "auth_token")) return "out"; // X deletes it on logout

  const loggedIn = page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]');
  const loggedOut = page.locator('[data-testid="loginButton"]');
  const deadline = Date.now() + TIMING.loginCheckTimeout;
  while (Date.now() < deadline) {
    // Logged out, /home redirects to the landing page or to a login page.
    if (new URL(page.url()).pathname === "/" || isLoginUrl(page.url())) return "out";
    if (await isPresent(loggedIn)) return "in";
    if (await isPresent(loggedOut)) return "out";
    await sleep(TIMING.pollInterval);
  }
  return "unknown";
}

/**
 * Blocks the profile open in `page` through its ··· menu, after checking the menu names the
 * right handle. In a dry run, it only opens the menu and checks it.
 */
async function blockFromProfile(page, handle, { dryRun }) {
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
  if ((await item.getAttribute("data-testid")) === "unblock" || /^unblock/i.test(text)) {
    return closeMenu(page, { status: "already_blocked" });
  }
  if (dryRun) return closeMenu(page, { status: "would_block" });

  await item.click();
  const confirm = page.locator('[data-testid="confirmationSheetConfirm"]');
  await confirm.waitFor({ timeout: 5000 });
  const response = page.waitForResponse((r) => new URL(r.url()).pathname.includes("/blocks/create"), {
    timeout: TIMING.blockConfirmTimeout,
  });
  response.catch(() => {}); // handled below; this only avoids an unhandled rejection
  await confirm.click();
  return { ...(await blockConfirmation(page, response)), blockSent: true };
}

/** Success is a 2xx from /blocks/create or the profile's Unblock button showing up, within 10s. */
async function blockConfirmation(page, responsePromise) {
  const fromApi = responsePromise.then((response) => {
    if (response.ok()) return { status: "blocked" };
    const note = `blocks/create returned HTTP ${response.status()}`;
    return { status: response.status() === 429 ? "rate_limited" : "error", note };
  });
  const fromPage = page
    .locator('[data-testid="primaryColumn"] [data-testid$="-unblock"]')
    .first()
    .waitFor({ timeout: TIMING.blockConfirmTimeout })
    .then(() => ({ status: "blocked" }));
  try {
    return await Promise.any([fromApi, fromPage]);
  } catch {
    return { status: "error", note: "block not confirmed within 10s" };
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

async function isPresent(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false; // e.g. the page is mid-navigation
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
