import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/x-mass-blocker.js", import.meta.url));
const browser = new URL("../src/browser.js", import.meta.url).href;
const logoutFixture = `data:text/javascript,${encodeURIComponent(`
  import { once } from "node:events";
  import { XBrowser } from ${JSON.stringify(browser)};
  XBrowser.start = async () => ({
    close: async () => {},
    newPage: async () => ({
      goto: async (url) => {
        if (url === "https://x.com/logout") {
          const resume = once(process.stdin, "data");
          process.stderr.write("fixture revoking session\\n");
          await resume;
          process.stdin.pause();
        }
      },
      url: () => "https://x.com/",
      locator: () => ({ count: async () => 0 }),
      context: () => ({ cookies: async () => [] }),
    }),
  });
`)}`;

function command(t, dir, args, preload = []) {
  const child = spawn(process.execPath, [...preload, cli, ...args], {
    env: { ...process.env, X_MASS_BLOCKER_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stderr = "";
  let ready;
  const waitingForRevocation = new Promise((resolve) => { ready = resolve; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (stderr.includes("fixture revoking session\n")) ready();
  });
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stderr }));
  return {
    child,
    done,
    revoking: () => Promise.race([
      waitingForRevocation,
      done.then((result) => assert.fail(`Logout exited before revocation: ${result.stderr}`)),
    ]),
  };
}

test("logout excludes session replacement and a killed owner can be recovered", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "xmb-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const session = path.join(dir, "session.json");
  const oldSession = JSON.stringify({ cookies: [{ name: "auth_token", value: "fixture_old" }] });
  await writeFile(session, oldSession, { mode: 0o600 });

  const startLogout = () => command(t, dir, ["logout"], ["--import", logoutFixture]);
  const interrupted = startLogout();
  await interrupted.revoking();
  interrupted.child.kill("SIGKILL");
  assert.equal((await interrupted.done).signal, "SIGKILL");
  assert.equal((await readdir(path.join(dir, ".state-lock"))).length, 1);

  const logout = startLogout();
  await logout.revoking();
  const competingLogin = command(t, dir, ["login", "--paste"]);
  competingLogin.child.stdin.end();
  const busy = await competingLogin.done;
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /State directory is busy/);
  assert.equal(await readFile(session, "utf8"), oldSession);

  assert.equal((await command(t, dir, ["stats", "--json"]).done).code, 0);
  logout.child.stdin.end("continue");
  assert.equal((await logout.done).code, 0);
  await assert.rejects(stat(session), { code: "ENOENT" });

  const replacement = command(t, dir, ["login", "--paste"]);
  replacement.child.stdin.end("fixture_new\nfixture_csrf\n");
  assert.equal((await replacement.done).code, 0);
  assert.match(await readFile(session, "utf8"), /fixture_new/);
  assert.equal((await stat(session)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.join(dir, ".state-lock")), []);
});
