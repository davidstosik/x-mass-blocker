import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChrome } from "../src/browser.js";
import { CliError } from "../src/errors.js";
import { login } from "../src/login.js";
import { run } from "../src/runner.js";

const sandboxFailure = new Error(
  "browserType.launch: Target page, context or browser has been closed\nChromium sandboxing failed!",
);

test("falls back to sandboxed Chromium when the Chrome channel cannot start", async (t) => {
  const browser = {};
  const launch = t.mock.method(chromium, "launch", async ({ channel }) => {
    if (channel === "chrome") throw sandboxFailure;
    return browser;
  });

  assert.equal(await launchChrome({ headless: true }), browser);
  assertSandboxedAttempts(launch, true);
});

test("login reports sandbox startup failure before navigating", async (t) => {
  const launch = mockFailedLaunch(t);

  await assert.rejects(login("unused-session.json", () => {}), checkLaunchError);
  assertSandboxedAttempts(launch, false);
});

for (const headed of [true, false]) {
  test(`authenticated ${headed ? "headed" : "headless"} run reports sandbox startup failure`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const paths = { session: path.join(dir, "session.json"), results: path.join(dir, "results.jsonl") };
    const list = path.join(dir, "handles.txt");
    await writeFile(paths.session, JSON.stringify({ cookies: [{ name: "auth_token", value: "fixture" }], origins: [] }));
    await writeFile(list, "fixture_account\n");
    const launch = mockFailedLaunch(t);

    await assert.rejects(run({ paths, list, headed, dryRun: true, progress: () => {} }), checkLaunchError);
    assertSandboxedAttempts(launch, !headed);
  });
}

function mockFailedLaunch(t) {
  return t.mock.method(chromium, "launch", async ({ channel }) => {
    if (channel === "chrome") throw new Error("Chrome channel is missing");
    throw sandboxFailure;
  });
}

function checkLaunchError(error) {
  assert.ok(error instanceof CliError);
  assert.match(error.message, /Google Chrome: Chrome channel is missing/);
  assert.match(error.message, /Playwright Chromium: Chromium sandboxing failed/);
  assert.match(error.message, /environment that supports Chromium sandboxing/);
  return true;
}

function assertSandboxedAttempts(launch, headless) {
  const calls = launch.mock.calls.map(({ arguments: [options] }) => options);
  assert.deepEqual(calls.map((options) => options.channel), ["chrome", undefined]);
  for (const options of calls) {
    assert.equal(options.chromiumSandbox, true);
    assert.equal(options.headless, headless);
    assert.ok(!options.args.includes("--no-sandbox"));
  }
}
