# x-mass-blocker

![Santa crossing robot accounts off his naughty list, next to the x-mass-blocker icon](assets/banner.jpg)

**Santa's naughty list for AI reply guys.**

Blocks every X account on [levels.io's "blocked for AI reply" list](https://blockedforaireply.levels.io) from your own account, using the Google Chrome already installed on your computer.

The site offers a prompt for AI browser agents that visits about 3,700 profiles and blocks them one by one. Done by an LLM, that costs tens of millions of tokens per run. This script does the same clicks for free, remembers where it left off, stays under a daily cap, and unblocks accounts that were taken off the list after an appeal.

## Quick start

You need Node.js 20 or later and Google Chrome.

```sh
# 1. Log in to X in a Chrome window (use your username and password)
npx github:davidstosik/x-mass-blocker login

# 2. Dry run: open the Block menu of 5 accounts, block nothing
npx github:davidstosik/x-mass-blocker run --dry-run -n 5 --headed

# 3. Block for real (up to 400 accounts a day by default)
npx github:davidstosik/x-mass-blocker run
```

> [!IMPORTANT]
> This is v1, tested on a single account with a sample of 20 blocks and 2 unblocks. X changes its pages often, so do the dry run first and watch it.

At 400 blocks a day, the whole list takes about 10 runs. Each run picks up where the last one stopped.

## For AI agents

Paste this into Claude Code, Codex or any agent that can run commands:

```text
Run `npx github:davidstosik/x-mass-blocker login` and wait for me to log in.
Then run `npx github:davidstosik/x-mass-blocker run --json` and report the summary.
If it exits with code 2, tell me to run it again tomorrow.
If it exits with code 3, ask me to log in again.
```

## Commands

| Command | What it does |
| --- | --- |
| `login` | Opens Chrome on X's login page and saves the session once you're logged in. |
| `login --paste` | Asks for the `auth_token` and `ct0` cookies (copied from a logged-in browser) instead. |
| `run` | Unblocks accounts removed from the list, then blocks the rest. |
| `stats [--json]` | Counts the results so far. |

Options for `run`:

| Option | Default | |
| --- | --- | --- |
| `--dry-run` | | Open each menu and check it, then press Escape. Nothing is blocked, unblocked or recorded. |
| `-n, --limit N` | all | Visit at most N accounts this run. |
| `--daily-cap N` | 400 | Stop once N accounts were blocked or unblocked in the last 24 hours. |
| `--headed` | | Show the browser window. |
| `--list URL\|FILE` | levels.io list | Use another list, one username per line. |
| `--recheck` | | Visit accounts again even if a previous run settled them. |
| `--no-unblock` | | Don't unblock accounts that were removed from the list. |
| `--allow-mass-unblock` | | Unblock them even if unusually many left the list at once (see below). |
| `--json` | | Print the summary as JSON on stdout. Progress always goes to stderr. |

Exit codes: `0` done, `1` error, `2` stopped early (daily cap, rate limit or repeated failures: run again later), `3` not logged in.

## How it works

- It downloads the list and skips accounts a previous run already settled (blocked, already blocked, suspended or deleted).
- It drives your installed Chrome through [Playwright](https://playwright.dev), headless, with your saved session, and hides the usual automation markers.
- For each username it opens `x.com/USERNAME` and reads both X's own API response and the page to tell whether the account exists, is suspended or is already blocked.
- It checks that the profile and the Block menu show the right handle, then blocks through the ··· menu the way you would, one account every 3 to 5 seconds.
- On errors it retries after 30 seconds, then 15 minutes twice. It stops after 3 failures in a row or when X keeps rate limiting.
- Each result is saved right away, so you can stop it with Ctrl-C at any time.

### Pardons

Appeals are reviewed by hand on levels.io, and an accepted one simply removes the handle from the list. So at the start of each run, the script looks for accounts **it** blocked from this list that are no longer on it, and unblocks them first. Accounts you had blocked yourself before the script got to them are never unblocked.

A broken or cut-off download would look like a mass pardon. So if more than 10 accounts, or 5% of the script's blocks, left the list at once, the script unblocks none of them and says so. If the list really shrank, run again with `--allow-mass-unblock`.

## Files and privacy

Everything lives in `~/.config/x-mass-blocker/` (or `$XDG_CONFIG_HOME/x-mass-blocker/`, or `$X_MASS_BLOCKER_HOME`):

- `session.json` holds your X session cookies. **Anyone with this file can use your X account.** It's readable only by you (`chmod 600`). To revoke it, delete the file and log the session out in X's settings (Security and account access > Apps and sessions).
- `results.jsonl` is the record of every run. Lines are only ever added, one per visit, so an account's history stays readable:
  ```jsonl
  {"username":"example","status":"blocked","list":"https://blockedforaireply.levels.io/api/usernames.txt","at":"2026-11-20T09:42:03.551Z"}
  {"username":"example","status":"unblocked","note":"no longer on the list","list":"https://blockedforaireply.levels.io/api/usernames.txt","at":"2026-12-02T10:01:44.120Z"}
  ```
  `blocked` and `unblocked` are what the script did. The other statuses are what it found: `already_blocked` (blocked before the script got there), `not_blocked` (already unblocked when it came to unblock), `not_found`, `suspended`, `unavailable`, `mismatch` (the page showed another handle) and `failed`.

The script only talks to X and to the list's URL.

## Caveats

- **Automating x.com is against X's terms of service.** The risk falls on your account. The defaults are cautious, but X doesn't publish its limits, so 400 a day is a guess.
- The text fallbacks assume X is displayed in English. The script asks for English, but your account's language setting may win.
- Usernames can change hands: the account you block may not be the one that was put on the list.
- If you log in with Google or Apple, those sign-ins may refuse an automated browser. Use your username and password, or `login --paste`.

## Credits

The list is curated by [Pieter Levels (@levelsio)](https://x.com/levelsio) at [blockedforaireply.levels.io](https://blockedforaireply.levels.io). This project isn't affiliated with X or with levels.io.

## License

[MIT](LICENSE)
