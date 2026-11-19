#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DAY, DEFAULT_LIST_URL, EXIT, statePaths } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { login, loginWithPastedCookies, logout } from "../src/login.js";
import { ResultLog } from "../src/results.js";
import { run } from "../src/runner.js";

const help = (paths) => `Block every X account on levels.io's "blocked for AI reply" list.

Usage:
  x-mass-blocker login [--paste]   Log in to X in Chrome and save the session
  x-mass-blocker run [options]     Unblock accounts removed from the list, then block the rest
  x-mass-blocker stats [--json]    Count the results so far
  x-mass-blocker logout            Log the saved session out of X, then delete it

Options for login:
  --paste                Paste the auth_token and ct0 cookies instead of opening Chrome

Options for run:
  --dry-run              Open each menu and check it, but never block, unblock or record anything
  -n, --limit N          Visit at most N accounts this run
  --daily-cap N          Stop once N accounts were blocked or unblocked in the last 24 hours
                         (default: no cap; --daily-cap 400 spreads the list over about 10 days)
  --headed               Show the browser window
  --list URL|FILE        Use another list (default: ${DEFAULT_LIST_URL})
  --recheck              Visit accounts again even if a previous run already settled them
  --no-unblock           Don't unblock accounts that were removed from the list
  --allow-mass-unblock   Unblock them even if unusually many left the list at once
  --json                 Print the summary as JSON on stdout (progress always goes to stderr)

Exit codes: 0 done, 1 error, 2 stopped early (run again later), 3 not logged in.
Session and results are kept in ${paths.dir}
(set X_MASS_BLOCKER_HOME to use another folder).
`;

const progress = (message) => process.stderr.write(`${message}\n`);

async function loginCommand(args, paths) {
  const { paste } = parse(args, { paste: { type: "boolean" } });
  if (paste) await loginWithPastedCookies(paths.session, progress);
  else await login(paths.session, progress);
  return EXIT.OK;
}

async function logoutCommand(args, paths) {
  parse(args, {});
  await logout(paths.session, progress);
  return EXIT.OK;
}

async function runCommand(args, paths) {
  const options = parse(args, {
    "dry-run": { type: "boolean" },
    limit: { type: "string", short: "n" },
    "daily-cap": { type: "string" },
    headed: { type: "boolean" },
    list: { type: "string" },
    recheck: { type: "boolean" },
    "no-unblock": { type: "boolean" },
    "allow-mass-unblock": { type: "boolean" },
    json: { type: "boolean" },
  });

  process.once("SIGINT", () => {
    progress("\nInterrupted. Progress is saved: run again to continue.");
    process.exit(130);
  });

  const summary = await run({
    paths,
    list: options.list ?? DEFAULT_LIST_URL,
    limit: positiveInteger(options.limit, "--limit"),
    dailyCap: positiveInteger(options["daily-cap"], "--daily-cap") ?? null,
    dryRun: Boolean(options["dry-run"]),
    headed: Boolean(options.headed),
    recheck: Boolean(options.recheck),
    unblock: !options["no-unblock"],
    allowMassUnblock: Boolean(options["allow-mass-unblock"]),
    progress,
  });

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (summary.dryRun) {
    console.log(
      `Dry run: would block ${n(summary.wouldBlock)}, would unblock ${n(summary.wouldUnblock)}, ` +
        `skipped ${n(summary.skipped)}, failed ${n(summary.failed)}.`,
    );
  } else {
    const unblocked = summary.unblocked ? `, unblocked ${n(summary.unblocked)}` : "";
    console.log(
      `Blocked ${n(summary.blocked)}${unblocked}, skipped ${n(summary.skipped)}, failed ${n(summary.failed)}. ` +
        `${n(summary.remaining)} accounts left on the list.`,
    );
  }
  return summary.stopped ? EXIT.STOPPED : EXIT.OK;
}

const STATUS_ORDER = [
  "blocked",
  "already_blocked",
  "unblocked",
  "not_blocked",
  "not_found",
  "suspended",
  "unavailable",
  "mismatch",
  "failed",
];

async function statsCommand(args, paths) {
  const { json } = parse(args, { json: { type: "boolean" } });
  const log = await ResultLog.load(paths.results);
  const byStatus = log.tally();
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const actionsLast24h = log.countActionsSince(Date.now() - DAY);

  if (json) {
    console.log(JSON.stringify({ byStatus, total, actionsLast24h }, null, 2));
  } else if (total === 0) {
    console.log("No results yet. Run `x-mass-blocker run` first.");
  } else {
    const statuses = Object.keys(byStatus).sort((a, b) => rank(a) - rank(b));
    const rows = [...statuses.map((status) => [status, byStatus[status]]), ["total", total]];
    for (const [label, count] of rows) console.log(`${label.padEnd(16)}${n(count).padStart(7)}`);
    console.log(`\nBlocked or unblocked in the last 24 hours: ${n(actionsLast24h)}`);
  }
  return EXIT.OK;
}

const COMMANDS = { login: loginCommand, run: runCommand, stats: statsCommand, logout: logoutCommand };

async function main(argv) {
  const [command, ...args] = argv;
  const paths = statePaths();
  if (!command || command === "help" || argv.includes("--help") || argv.includes("-h")) {
    console.log(help(paths));
    return EXIT.OK;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new CliError(`Unknown command "${command}". Run "x-mass-blocker --help" for usage.`);
  }
  return COMMANDS[command](args, paths);
}

function parse(args, options) {
  try {
    return parseArgs({ args, options }).values;
  } catch (error) {
    throw new CliError(`${error.message}\nRun "x-mass-blocker --help" for usage.`);
  }
}

function positiveInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new CliError(`${flag} must be a positive whole number.`);
  return Number(value);
}

function rank(status) {
  const index = STATUS_ORDER.indexOf(status);
  return index === -1 ? STATUS_ORDER.length : index;
}

function n(number) {
  return number.toLocaleString("en-US");
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof CliError ? error.message : error);
    process.exitCode = error.exitCode ?? EXIT.ERROR;
  },
);
