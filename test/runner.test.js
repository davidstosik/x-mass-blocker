import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { XBrowser } from "../src/browser.js";
import { TIMING } from "../src/config.js";
import { ResultLog } from "../src/results.js";
import { run } from "../src/runner.js";

const A = "1900000000000000001";
const B = "1900000000000000002";

function lookup(handle, userId, { status = 200, blocked = false, shown = handle } = {}) {
  const variables = encodeURIComponent(JSON.stringify({ screen_name: handle }));
  return {
    url: () => `https://x.com/i/api/graphql/fixture/UserByScreenName?variables=${variables}`,
    status: () => status,
    json: async () => ({
      data: { user: { result: {
        __typename: "User", rest_id: userId, core: { screen_name: shown },
        relationship_perspectives: { blocking: blocked },
      } } },
    }),
  };
}

async function fixture(t, { blocked = true, initialVerification, recovery = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xmb-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { session: path.join(dir, "session.json"), results: path.join(dir, "results.jsonl") };
  const list = path.join(dir, "list.txt");
  await writeFile(list, "target\n");
  const visited = [];
  const verified = [];
  const actions = [];
  let closed = 0;
  const startBrowser = async ({ storageState }) => {
    const token = storageState.cookies[0].value;
    const [accountId, handle] = token.split(":");
    const context = { cookies: async () => storageState.cookies };
    let pageNumber = 0;
    const newPage = async () => {
      const index = pageNumber++;
      const verification = index === 0 ? initialVerification : recovery[index - 1];
      const events = new EventEmitter();
      let location;
      let resolveResponse;
      const menuItem = {
        first: () => menuItem,
        waitFor: async () => {},
        innerText: async () => `${blocked ? "Unblock" : "Block"} @${visited.at(-1)}`,
        getAttribute: async () => blocked ? "unblock" : "block",
        click: async () => { actions.push(visited.at(-1)); },
        or: () => menuItem,
      };
      const page = {
        goto: async (url) => {
          location = url;
          if (url === `https://x.com/${handle}`) {
            verified.push(token);
            resolveResponse();
          } else if (url !== "https://x.com/home") {
            if (recovery.length && index === 0) throw new Error("Fixture page crashed");
            const target = new URL(url).pathname.slice(1);
            visited.push(target);
            events.emit("response", lookup(target, "42", { blocked: blocked || target === "removed" }));
          }
        },
        url: () => location,
        locator: (selector) => ({
          count: async () => Number(selector.includes("AppTabBar_Profile_Link")),
          first() { return this; },
          locator: () => menuItem,
          getByRole: () => menuItem,
          click: async () => {},
          waitFor: async () => {},
          getAttribute: async () => {
            assert.equal(selector, '[data-testid="AppTabBar_Profile_Link"]');
            return `/${handle}`;
          },
        }),
        waitForResponse: (predicate) => new Promise((resolve) => {
          if (location === "https://x.com/target") {
            const response = { url: () => "https://x.com/i/api/1.1/blocks/create.json", ok: () => true };
            assert.ok(predicate(response));
            resolve(response);
            return;
          }
          resolveResponse = () => {
            const response = lookup(handle, verification?.accountId ?? accountId, verification);
            assert.ok(predicate(response));
            resolve(response);
          };
        }),
        context: () => context,
        isClosed: () => false,
        close: async () => {},
        on: events.on.bind(events),
        off: events.off.bind(events),
        evaluate: async () => ({ kind: "profile", handle: visited.at(-1), blocked: blocked || visited.at(-1) === "removed" }),
      };
      return page;
    };
    return { isConnected: true, newPage, close: async () => { closed++; } };
  };

  return {
    paths,
    list,
    visited,
    verified,
    actions,
    closed: () => closed,
    session: async (token) => writeFile(paths.session, JSON.stringify({ cookies: [{ name: "auth_token", value: token }] })),
    run: (options) => run({ paths, list, unblock: true, progress: () => {}, ...options }, { startBrowser }),
  };
}

test("switching accounts isolates actions, observations, and the daily cap", async (t) => {
  const f = await fixture(t, { blocked: false });
  const a = await ResultLog.load(f.paths.results, A);
  await a.record("target", "already_blocked", { list: f.list });
  await a.record("removed", "blocked", { list: f.list, userId: "42" });
  await f.session(`${B}:second:initial`);

  const summary = await f.run({ dailyCap: 1, limit: 1 });
  assert.equal(summary.stopped, null);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(f.visited, ["target"]);
  assert.deepEqual(f.actions, ["target"]);
  assert.equal((await ResultLog.load(f.paths.results, B)).latest("target").status, "blocked");
  assert.deepEqual((await ResultLog.load(f.paths.results)).tally(), { already_blocked: 1, blocked: 2 });

  await f.session(`${A}:renamed:refreshed`);
  const back = await f.run({ dailyCap: 1 });
  assert.equal(back.stopped, "daily_cap");
  assert.deepEqual(f.visited, ["target"]);
  assert.deepEqual(f.verified, [`${B}:second:initial`, `${A}:renamed:refreshed`]);
  assert.equal(f.closed(), 2);
});

test("refreshing a session keeps history even when there are no queued tasks", async (t) => {
  const f = await fixture(t);
  await f.session(`${A}:first:initial`);
  assert.equal((await f.run()).visited, 1);

  await f.session(`${A}:renamed:refreshed`);
  const summary = await f.run();
  assert.equal(summary.visited, 0);
  assert.equal(summary.remaining, 0);
  assert.deepEqual(f.verified, [`${A}:first:initial`, `${A}:renamed:refreshed`]);
});

test("unknown or invalid journal owners require explicit migration or a fresh journal", async (t) => {
  const f = await fixture(t);
  await f.session(`${B}:second:initial`);
  const legacy = '{"username":"target","status":"blocked"}\n';
  await writeFile(f.paths.results, legacy);
  await assert.rejects(f.run({ dryRun: true }), /unknown X account owner.*Move the journal aside/);
  assert.deepEqual(f.visited, []);
  assert.equal(await readFile(f.paths.results, "utf8"), legacy);
  assert.equal(f.closed(), 1);

  await writeFile(f.paths.results, '{"accountId":123,"username":"target","status":"blocked"}\n');
  await assert.rejects(f.run(), /unknown X account owner/);

  await writeFile(f.paths.results, JSON.stringify({ accountId: A, username: "target", status: "blocked" }) + "\n");
  assert.equal((await f.run()).visited, 1);
});

test("an unverified session cannot reach the journal or a target", async (t) => {
  const f = await fixture(t);
  await f.session("invalid:second:initial");
  // An unknown-owner error would take precedence if the journal were read before verification.
  await writeFile(f.paths.results, '{"username":"target","status":"blocked"}\n');
  await assert.rejects(f.run(), /Could not verify the signed-in X account ID/);
  assert.deepEqual(f.visited, []);
  assert.equal(f.closed(), 1);
});

class ProfileFixture extends EventEmitter {
  userId = "9007199254740993";
  blocked = false;
  menuVisits = 0;
  actions = [];

  async goto(url) {
    this.currentUrl = url;
    if (url === "https://x.com/home" || url === "https://x.com/signed_in") return;
    assert.equal(url, "https://x.com/alice");
    this.emit("response", lookup("alice", this.userId, { blocked: this.blocked }));
  }

  url() { return this.currentUrl; }
  context() { return { cookies: async () => [{ name: "auth_token", value: "fixture" }] }; }
  isClosed() { return false; }
  async evaluate() { return { kind: "profile", handle: "alice", blocked: this.blocked }; }

  locator(selector) {
    if (selector === '[data-testid="AppTabBar_Profile_Link"]') return { getAttribute: async () => "/signed_in" };
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

  async waitForResponse(predicate) {
    const identity = lookup("signed_in", A);
    if (predicate(identity)) return identity;
    return { ok: () => true };
  }
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
  assert.equal((await ResultLog.load(paths.results, A)).lastAction("alice").userId, originalId);

  await writeFile(list, "kept\n");
  await (await ResultLog.load(paths.results, A)).record("kept", "already_blocked");
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

function shortenRetries(t) {
  const delays = TIMING.retryDelays;
  TIMING.retryDelays = [0, 0];
  t.after(() => { TIMING.retryDelays = delays; });
}

test("temporary verification failure on a replacement page backs off and retries", async (t) => {
  const f = await fixture(t, { blocked: false, recovery: [{ status: 503 }, {}] });
  shortenRetries(t);
  const progress = [];
  await f.session(`${A}:first:initial`);

  const summary = await f.run({ progress: (line) => progress.push(line) });
  assert.equal(summary.stopped, null);
  assert.equal(summary.blocked, 1);
  assert.equal(f.verified.length, 3);
  assert.deepEqual(f.actions, ["target"]);
  assert.equal(progress.filter((line) => line.includes("Retrying")).length, 2);
  assert.ok(progress.some((line) => /account lookup.*Retrying/.test(line)));
});

test("a switched account on a replacement page aborts the run", async (t) => {
  const f = await fixture(t, { recovery: [{ accountId: B }] });
  shortenRetries(t);
  await f.session(`${A}:first:initial`);

  await assert.rejects(f.run(), /signed-in X account changed during the run/);
  assert.equal(f.verified.length, 2);
  assert.deepEqual(f.visited, []);
  assert.deepEqual(f.actions, []);
  await assert.rejects(readFile(f.paths.results), { code: "ENOENT" });
});

test("a 429 verifying a replacement page stops with rate_limited", async (t) => {
  const f = await fixture(t, { recovery: [{ status: 429 }] });
  shortenRetries(t);
  await f.session(`${A}:first:initial`);

  const summary = await f.run();
  assert.equal(summary.stopped, "rate_limited");
  assert.equal(summary.visited, 0);
  assert.equal(f.verified.length, 2);
  assert.deepEqual(f.actions, []);
  await assert.rejects(readFile(f.paths.results), { code: "ENOENT" });
});

test("a 429 verifying the initial page stops before reading history", async (t) => {
  const f = await fixture(t, { initialVerification: { status: 429 } });
  await f.session(`${A}:first:initial`);
  await writeFile(f.paths.results, '{"username":"target","status":"blocked"}\n');

  const summary = await f.run();
  assert.equal(summary.stopped, "rate_limited");
  assert.equal(summary.remaining, null);
  assert.deepEqual(f.visited, []);
  assert.equal(f.closed(), 1);
});

test("a successful lookup for the wrong handle on a replacement page is fatal", async (t) => {
  const f = await fixture(t, { recovery: [{ shown: "someone_else" }] });
  shortenRetries(t);
  await f.session(`${A}:first:initial`);

  await assert.rejects(f.run(), /Could not verify the signed-in X account ID/);
  assert.equal(f.verified.length, 2);
  assert.deepEqual(f.visited, []);
});
