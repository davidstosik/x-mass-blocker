import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright-core";
import { CliError, NotLoggedInError } from "./errors.js";

const { version: PLAYWRIGHT_VERSION } = createRequire(import.meta.url)("playwright-core/package.json");

// A page we serve ourselves (never hits the network), used to read the user agent data
// that Chrome only exposes on https pages.
const PROBE_URL = "https://x-mass-blocker.invalid/";

/**
 * Launches the installed Google Chrome, or Playwright's own Chromium if the user installed it.
 * The flags hide the usual automation markers (navigator.webdriver, the "controlled by" bar).
 */
export async function launchChrome({ headless, args = [] }) {
  const options = {
    headless,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled", ...args],
  };
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch (chromeError) {
    try {
      return await chromium.launch(options);
    } catch {
      throw new CliError(
        "Could not start Google Chrome. Install it from https://www.google.com/chrome/\n" +
          `or install Playwright's Chromium instead: npx playwright@${PLAYWRIGHT_VERSION} install chromium\n` +
          `(${chromeError.message.split("\n")[0]})`,
      );
    }
  }
}

/** Reads the saved Playwright storageState. Throws NotLoggedInError if there is none. */
export async function readSession(file) {
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new NotLoggedInError();
    throw new CliError(`Could not read ${file}: ${error.message}`);
  }
  if (!state.cookies?.some((cookie) => cookie.name === "auth_token")) throw new NotLoggedInError();
  return state;
}

/** Saves a Playwright storageState. It holds the user's full X session, so only they may read it. */
export async function saveSession(file, state) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600); // writeFile's mode only applies to new files
}

/** Chrome with the saved X session, made to look like a regular (non-headless) Chrome. */
export class XBrowser {
  #browser;
  #context;
  #userAgentOverride = null;

  constructor(browser, context) {
    this.#browser = browser;
    this.#context = context;
  }

  static async start({ sessionFile, headed = false }) {
    const storageState = await readSession(sessionFile);
    const browser = await launchChrome({
      headless: !headed,
      args: ["--blink-settings=imagesEnabled=false"],
    });
    try {
      const userAgent = (await realUserAgent(browser)).replace("HeadlessChrome", "Chrome");
      const context = await browser.newContext({ storageState, userAgent });
      await context.addCookies([{ name: "lang", value: "en", domain: ".x.com", path: "/", secure: true }]);
      const xBrowser = new XBrowser(browser, context);
      xBrowser.#userAgentOverride = await xBrowser.#headlessBrandsOverride(userAgent);
      return xBrowser;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  get isConnected() {
    return this.#browser.isConnected();
  }

  async newPage() {
    const page = await this.#context.newPage();
    if (this.#userAgentOverride) {
      const cdp = await this.#context.newCDPSession(page);
      await cdp.send("Network.setUserAgentOverride", this.#userAgentOverride);
    }
    return page;
  }

  async close() {
    await this.#browser.close().catch(() => {});
  }

  /**
   * Headless Chrome reports a "HeadlessChrome" brand in navigator.userAgentData and in the
   * Sec-CH-UA headers. If it does, build a CDP override with the brand renamed.
   */
  async #headlessBrandsOverride(userAgent) {
    const page = await this.#context.newPage();
    try {
      await page.route(PROBE_URL, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
      await page.goto(PROBE_URL);
      const data = await page.evaluate(() =>
        navigator.userAgentData?.getHighEntropyValues([
          "architecture",
          "bitness",
          "fullVersionList",
          "model",
          "platformVersion",
          "wow64",
        ]),
      );
      if (!data || !JSON.stringify(data.brands).includes("Headless")) return null;

      const rename = ({ brand, version }) => ({ brand: brand.replace("HeadlessChrome", "Google Chrome"), version });
      const { brands, fullVersionList, platform, platformVersion, architecture, bitness, model, mobile, wow64 } = data;
      return {
        userAgent,
        userAgentMetadata: {
          brands: brands.map(rename),
          fullVersionList: fullVersionList.map(rename),
          platform,
          platformVersion,
          architecture,
          bitness,
          model,
          mobile,
          wow64,
        },
      };
    } finally {
      await page.close();
    }
  }
}

async function realUserAgent(browser) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { userAgent } = await cdp.send("Browser.getVersion");
    return userAgent;
  } finally {
    await cdp.detach();
  }
}
