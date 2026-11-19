import readline from "node:readline";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { launchChrome, saveSession } from "./browser.js";
import { TIMING } from "./config.js";
import { CliError } from "./errors.js";

const LOGIN_URL = "https://x.com/i/flow/login";
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
