import { EXIT } from "./config.js";

/** An error meant for the user: printed without a stack trace. */
export class CliError extends Error {
  constructor(message, exitCode = EXIT.ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class NotLoggedInError extends CliError {
  constructor(message = "Not logged in to X. Run `x-mass-blocker login` first.") {
    super(message, EXIT.NOT_LOGGED_IN);
  }
}
