import { rm } from "node:fs/promises";
import readline from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome, readSession, saveSession, XBrowser } from "./browser.js";
import { TIMING } from "./config.js";
import { CliError, NotLoggedInError } from "./errors.js";
import { isLoginUrl } from "./profile.js";
import { isUserId } from "./user-id.js";

const LOGIN_URL = "https://x.com/i/flow/login";
const LOGOUT_URL = "https://x.com/logout";
const AUTH_COOKIES = ["auth_token", "ct0"];

/** Opens a visible Chrome window, waits for the user to log in to X, then saves the session. */
export async function login(sessionFile, progress) {
  const browser = await launchChrome({ headless: false });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(LOGIN_URL);
    progress(
      "Log in to X in the Chrome window that just opened.\n" +
        "Use your username and password: Google and Apple sign-in may refuse an automated browser.",
    );

    const deadline = Date.now() + TIMING.loginTimeout;
    while (!(await hasAuthCookies(context))) {
      if (Date.now() > deadline) throw new CliError("Timed out after 10 minutes waiting for you to log in.");
      await sleep(1000);
    }
    await sleep(TIMING.loginCookieSettle);
    await saveSession(sessionFile, await context.storageState());
  } finally {
    await browser.close().catch(() => {});
  }
  progress(`Logged in. Session saved to ${sessionFile}`);
}

/** Asks for the auth_token and ct0 cookies (copied from a logged-in browser) without echoing them. */
export async function loginWithPastedCookies(sessionFile, progress) {
  progress("Paste the auth_token and ct0 cookies of x.com (DevTools > Application > Cookies). Input is hidden.");
  const values = await promptHidden(AUTH_COOKIES);
  for (const [name, value] of Object.entries(values)) {
    if (!/^\w+$/.test(value)) throw new CliError(`That doesn't look like a valid ${name} value.`);
  }

  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  const cookie = (name, httpOnly) => ({
    name,
    value: values[name],
    domain: ".x.com",
    path: "/",
    expires,
    httpOnly,
    secure: true,
    sameSite: "None",
  });
  await saveSession(sessionFile, { cookies: [cookie("auth_token", true), cookie("ct0", false)], origins: [] });
  progress(`Session saved to ${sessionFile}`);
}

/**
 * Logs the saved session out of X, checks that X now turns its cookies away, then deletes the file.
 * Deleting the file alone revokes nothing: a copy of it keeps working until the session is logged out.
 */
export async function logout(sessionFile, progress) {
  let storageState;
  try {
    storageState = await readSession(sessionFile);
  } catch (error) {
    if (!(error instanceof NotLoggedInError)) throw error;
    await rm(sessionFile, { force: true }); // no auth_token in it: nothing to log out
    progress("No saved session: nothing to log out.");
    return;
  }

  progress("Logging the saved session out of X…");
  let confirmed = false;
  let trouble = "";
  try {
    confirmed = await withPage(storageState, confirmLogout);
  } catch (error) {
    trouble = `${error.message.split("\n")[0]}\n`;
  }
  // The real test, whatever happened above: a fresh Chrome with the old cookies must not be logged in.
  const status = await withPage(storageState, checkLogin).catch(() => "unknown");
  if (status !== "out") {
    const problem =
      status === "in" ? "X still accepts the saved session" : "Could not tell whether X still accepts the saved session";
    throw new CliError(
      `${trouble}${problem}, so ${sessionFile} was kept. Run \`x-mass-blocker logout\` again, or end the session ` +
        "in X: Settings > Security and account access > Apps and sessions > Sessions. Then delete the file.",
    );
  }

  await rm(sessionFile, { force: true });
  progress(
    confirmed
      ? `Logged out: X no longer accepts the saved session. Deleted ${sessionFile}`
      : `The saved session was already logged out. Deleted ${sessionFile}`,
  );
}

/** Resolves to "in", "out", or "unknown" if X showed neither within 30s. */
export async function checkLogin(page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: TIMING.loginCheckTimeout });
  if (!(await hasCookie(page.context(), "auth_token"))) return "out"; // X deletes it on logout

  const loggedIn = page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]');
  const loggedOut = page.locator('[data-testid="loginButton"]');
  const deadline = Date.now() + TIMING.loginCheckTimeout;
  while (Date.now() < deadline) {
    if (isLoggedOutUrl(page.url())) return "out";
    if (await isPresent(loggedIn)) return "in";
    if (await isPresent(loggedOut)) return "out";
    await sleep(TIMING.pollInterval);
  }
  return "unknown";
}

export class AccountIdentityError extends CliError {}

export class AccountVerificationRateLimitError extends Error {}

/** Reads the stable ID from the X lookup for the signed-in account's own profile link. */
export async function verifyAccountId(page) {
  const timeout = TIMING.loginCheckTimeout;
  const temporary = () => new Error("Could not complete the signed-in X account lookup. Try again later.");
  let result;
  let handle;
  try {
    const href = await page.locator('[data-testid="AppTabBar_Profile_Link"]').getAttribute("href", { timeout });
    handle = /^\/(\w+)\/?$/.exec(href)?.[1].toLowerCase();
    if (!handle) throw temporary();

    const profileUrl = `https://x.com/${handle}`;
    const checkResponse = (response) => {
      const status = response?.status();
      if (status === 429) throw new AccountVerificationRateLimitError();
      if (status !== undefined && status !== 200) throw temporary();
      return response;
    };
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        if (
          !["https://x.com", "https://api.x.com"].includes(url.origin) ||
          !url.pathname.endsWith("/UserByScreenName")
        ) return false;
        try {
          return JSON.parse(url.searchParams.get("variables"))?.screen_name?.toLowerCase() === handle;
        } catch {
          return false;
        }
      }, { timeout }).then(checkResponse),
      page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout }).then((response) => {
        checkResponse(response);
        if (page.url().replace(/\/$/, "").toLowerCase() !== profileUrl) throw temporary();
      }),
    ]);
    result = (await response.json())?.data?.user?.result;
  } catch (error) {
    if (error instanceof AccountVerificationRateLimitError) throw error;
    // Browser errors may include request details.
    throw temporary();
  }

  const shown = result?.core?.screen_name ?? result?.legacy?.screen_name;
  if (result?.__typename === "User" && typeof shown === "string" &&
      shown.toLowerCase() === handle && isUserId(result.rest_id)) return result.rest_id;
  throw new AccountIdentityError("Could not verify the signed-in X account ID from its profile lookup.");
}

/**
 * Opens x.com/logout and confirms X's "Log out of X?" dialog. Resolves to false if X showed no
 * dialog because the session was already logged out. Whether it worked is checked afterwards.
 */
async function confirmLogout(page) {
  await page.goto(LOGOUT_URL, { waitUntil: "domcontentloaded", timeout: TIMING.loginCheckTimeout });
  const confirm = page.locator('[data-testid="confirmationSheetConfirm"]');
  const deadline = Date.now() + TIMING.loginCheckTimeout;
  while (!(await isPresent(confirm))) {
    if (isLoggedOutUrl(page.url())) return false;
    if (Date.now() > deadline) throw new CliError("X didn't show its \"Log out\" dialog within 30s.");
    await sleep(TIMING.pollInterval);
  }
  await confirm.click();
  // X deletes the auth_token cookie once it has logged the session out. Give it time before closing.
  const settled = Date.now() + TIMING.loginCheckTimeout;
  while ((await hasCookie(page.context(), "auth_token")) && Date.now() < settled) await sleep(TIMING.pollInterval);
  return true;
}

/** Runs `fn` on a page of a headless Chrome holding `storageState`, then closes that Chrome. */
async function withPage(storageState, fn) {
  const browser = await XBrowser.start({ storageState });
  try {
    return await fn(await browser.newPage());
  } finally {
    await browser.close();
  }
}

/** Logged out, X sends pages that need an account to the landing page or to a login page. */
function isLoggedOutUrl(url) {
  return new URL(url).pathname === "/" || isLoginUrl(url);
}

async function hasCookie(context, name) {
  const cookies = await context.cookies("https://x.com");
  return cookies.some((cookie) => cookie.name === name && cookie.value);
}

async function isPresent(locator) {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false; // e.g. the page is mid-navigation
  }
}

async function hasAuthCookies(context) {
  let cookies;
  try {
    cookies = await context.cookies("https://x.com");
  } catch {
    throw new CliError("Chrome was closed before you finished logging in.");
  }
  return AUTH_COOKIES.every((name) => cookies.some((cookie) => cookie.name === name && cookie.value));
}

/** Reads one line per name from stdin. Output goes to a muted stream, so nothing is echoed. */
async function promptHidden(names) {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: Boolean(process.stdin.isTTY) });
  rl.on("SIGINT", () => process.exit(130));
  const lines = rl[Symbol.asyncIterator]();
  const values = {};
  try {
    for (const name of names) {
      process.stderr.write(`${name}: `);
      const { value = "" } = await lines.next();
      process.stderr.write("\n");
      values[name] = value.trim();
    }
  } finally {
    rl.close();
  }
  return values;
}
