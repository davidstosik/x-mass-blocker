# Working on x-mass-blocker

x-mass-blocker is a Node.js CLI that applies an X block list through Playwright. The project uses JavaScript ES modules, Node.js 20 or later, and `playwright-core` as its sole runtime dependency.

## Local development

- Run `npm ci` to install the locked dependency and `npm test` to run the built-in Node.js test runner. The tests in `test/` run offline and need neither Chrome nor an X session.
- After installing dependencies, run `node bin/x-mass-blocker.js --help` to check the local CLI. To test `stats --json` with fixture data, point `X_MASS_BLOCKER_HOME` at a temporary directory and put the fixture in `results.jsonl` there.
- Use offline checks for routine development. Live `login`, `run`, and `logout` commands interact with X. `run --dry-run` still needs an authenticated session when it has profiles to visit.
- Distribute releases through GitHub tags and use pinned `npx github:` commands in `README.md`. Keep the manifest private to prevent accidental npm registry publication.

## Code map

- `bin/x-mass-blocker.js` defines commands, flags, help, and output. `src/config.js` defines exit codes, state paths, timing, and the mass-unblock threshold.
- `src/list.js` loads and normalizes file or URL lists. A list is identified by its URL or its absolute file path.
- `src/results.js` reads and appends result history. `src/runner.js` queues pardons before blocks and manages retries and stopping conditions.
- `src/profile.js` classifies profiles using X responses and page state. `src/browser.js` handles Chrome and session storage, and `src/login.js` handles login, session checks, and logout.

## Behavior to preserve

- Keep progress on stderr and JSON output on stdout. Preserve exit codes `0` for success, `1` for errors, `2` for an early stop, and `3` for a missing or expired login. Update CLI help and `README.md` when changing user-facing behavior.
- Treat `session.json` as a credential. Keep it out of logs, fixtures, and commits, and retain file mode `0600`. When saved credentials exist, verify X has revoked the session before deleting the file during logout.
- Compare handles case-insensitively and verify the target in the action menu before clicking. A dry run can inspect the menu and must leave both X block state and the result log untouched.
- Keep `results.jsonl` append-only and skip malformed lines when reading it. Preserve the distinction between the latest observed status and the latest action the tool took.
- Pardons apply only to accounts the tool blocked from the same list and require the profile's stable X user ID to match the ID saved with the block. Preserve the mass-unblock guard. The optional daily cap counts both blocks and unblocks in the preceding 24 hours.
