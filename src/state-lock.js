import { randomUUID } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./errors.js";

const CLAIM = /^([1-9]\d*)\.[0-9a-f-]{36}$/;

export async function withStateLock(stateDir, operation) {
  const lockDir = path.join(stateDir, ".state-lock");
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const name = `${process.pid}.${randomUUID()}`;
  const claim = path.join(lockDir, name);
  await mkdir(claim);

  try {
    // Publish before checking for competitors. A later contender sees this claim until
    // the operation ends. If two contenders see each other, both can safely back out.
    for (const entry of await readdir(lockDir)) {
      if (entry === name) continue;
      const match = CLAIM.exec(entry);
      if (!match) continue;
      if (isAlive(Number(match[1]))) {
        throw new CliError(`State directory is busy: ${stateDir}. Try again after the other command finishes.`);
      }
      // Each claim has a unique name, so concurrent cleanup cannot remove a new claim.
      await removeClaim(path.join(lockDir, entry));
    }
    return await operation();
  } finally {
    await removeClaim(claim);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function removeClaim(claim) {
  try {
    await rmdir(claim);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
