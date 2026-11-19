import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { XBrowser } from "../src/browser.js";
import { run } from "../src/runner.js";
import { ResultLog } from "../src/results.js";

class ProfileFixture extends EventEmitter {
  userId = "9007199254740993";
  blocked = false;
  menuVisits = 0;
  actions = [];

  async goto(url) {
    this.currentUrl = url;
    if (url === "https://x.com/home") return;
    assert.equal(url, "https://x.com/alice");
    const variables = encodeURIComponent(JSON.stringify({ screen_name: "alice" }));
    this.emit("response", {
      url: () => `https://x.com/i/api/graphql/fixture/UserByScreenName?variables=${variables}`,
      status: () => 200,
      json: async () => ({
        data: { user: { result: {
          __typename: "User",
          rest_id: this.userId,
          core: { screen_name: "alice" },
          relationship_perspectives: { blocking: this.blocked },
        } } },
      }),
    });
  }

  url() { return this.currentUrl; }
  context() { return { cookies: async () => [{ name: "auth_token", value: "fixture" }] }; }
  isClosed() { return false; }
  async evaluate() { return { kind: "profile", handle: "alice", blocked: this.blocked }; }

  locator(selector) {
    const action = this.blocked ? "unblock" : "block";
    const item = {
      first: () => item,
      or: () => item,
      waitFor: async () => {},
      innerText: async () => `${action} @alice`,
      getAttribute: async () => action,
      click: async () => {
        this.actions.push(action);
        this.blocked = !this.blocked;
      },
    };
    if (selector.includes("SideNav") || selector.includes("loginButton")) return { count: async () => 1 };
    if (selector.includes("userActions")) return { first: () => ({ click: async () => { this.menuVisits++; } }) };
    if (selector === '[role="menu"]') return { locator: () => item, getByRole: () => item };
    if (selector.includes("confirmationSheetConfirm")) return { click: async () => {} };
    if (selector.includes("primaryColumn")) return item;
    assert.fail(`Unexpected selector: ${selector}`);
  }

  async waitForResponse() { return { ok: () => true }; }
}

test("pardons skip a reassigned handle even when its new owner is manually blocked", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "x-mass-blocker-runner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { results: path.join(dir, "results.jsonl"), session: path.join(dir, "session.json") };
  const list = path.join(dir, "list.txt");
  await writeFile(paths.session, JSON.stringify({ cookies: [{ name: "auth_token", value: "fixture" }] }));
  await writeFile(list, "alice\n");

  const page = new ProfileFixture();
  t.mock.method(XBrowser, "start", async () => ({
    isConnected: true,
    newPage: async () => page,
    close: async () => {},
  }));
  const runFixture = (options) => run({ paths, list, unblock: true, progress: () => {}, ...options });

  const originalId = page.userId;
  assert.equal((await runFixture()).blocked, 1);
  assert.equal((await ResultLog.load(paths.results)).lastAction("alice").userId, originalId);

  await writeFile(list, "kept\n");
  await (await ResultLog.load(paths.results)).record("kept", "already_blocked");
  page.userId = "9007199254740992";
  page.blocked = true; // The new owner was blocked manually.
  assert.equal((await runFixture()).byStatus.mismatch, 1);
  assert.equal((await runFixture({ dryRun: true })).wouldUnblock, 0);
  page.userId = undefined;
  assert.equal((await runFixture()).byStatus.mismatch, 1);
  assert.equal(page.menuVisits, 1);
  assert.deepEqual(page.actions, ["block"]);

  page.userId = originalId;
  assert.equal((await runFixture()).unblocked, 1);
  assert.deepEqual(page.actions, ["block", "unblock"]);
});
