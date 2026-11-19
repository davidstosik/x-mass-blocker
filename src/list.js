import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

const HANDLE = /^\w{1,50}$/;

/** Loads a list of X handles from a URL or a local file. */
export async function loadList(source) {
  const text = /^https?:\/\//i.test(source) ? await download(source) : await readLocal(source);
  const handles = parseList(text);
  if (handles.length === 0) throw new CliError(`No usernames found in ${source}.`);
  return handles;
}

/** One handle per line. Leading @ is optional; duplicates are dropped case-insensitively. */
export function parseList(text) {
  const seen = new Set();
  const handles = [];
  for (const line of text.split(/\r?\n/)) {
    const handle = line.trim().replace(/^@/, "");
    if (!HANDLE.test(handle)) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

async function download(url) {
  let response;
  try {
    response = await fetch(url, { headers: { "user-agent": "x-mass-blocker" } });
  } catch (error) {
    throw new CliError(`Could not download the list from ${url}: ${error.cause?.message ?? error.message}`);
  }
  if (!response.ok) throw new CliError(`Could not download the list from ${url}: HTTP ${response.status}`);
  return response.text();
}

async function readLocal(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new CliError(`Could not read the list ${file}: ${error.message}`);
  }
}
