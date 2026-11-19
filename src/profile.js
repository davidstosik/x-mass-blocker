import { setTimeout as sleep } from "node:timers/promises";
import { TIMING } from "./config.js";
import { isUserId } from "./user-id.js";

/**
 * Opens https://x.com/HANDLE and works out what it shows, from two signals:
 * X's UserByScreenName API response (when we catch it) and the rendered page.
 *
 * Resolves to `{status, note?, userId?}` where status is one of:
 *   ready, already_blocked, not_found, suspended, unavailable, mismatch,
 *   rate_limited, error (temporary), logged_out.
 */
export async function inspectProfile(page, handle, { requireVerifiedState = false } = {}) {
  let lookup = null;
  const onResponse = async (response) => {
    const url = new URL(response.url());
    if (url.origin !== "https://x.com" && url.origin !== "https://api.x.com") return;
    if (!url.pathname.endsWith("/UserByScreenName") || !isLookupFor(url, handle)) return;
    let body = null;
    try {
      body = await response.json();
    } catch {
      // body unavailable (e.g. the page navigated away)
    }
    lookup = classifyLookup(response.status(), body) ?? lookup;
  };

  page.on("response", onResponse);
  try {
    await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded", timeout: TIMING.profileTimeout });
    const deadline = Date.now() + TIMING.profileTimeout;
    let verdict;
    while (Date.now() < deadline) {
      if (isLoginUrl(page.url())) return { status: "logged_out" };
      const rendered = await probe(page);
      verdict = judgeProfile(handle, lookup, rendered, { requireVerifiedState });
      const actionable = verdict?.status === "ready" || verdict?.status === "already_blocked";
      // The DOM can be ready before the lookup body arrives. Give it time to supply an ID.
      if (verdict && (!actionable || verdict.userId || (lookup && !isUserId(lookup.userId)))) return verdict;
      await sleep(TIMING.pollInterval);
    }
    return verdict ?? { status: "error", note: "profile page did not load" };
  } finally {
    page.off("response", onResponse);
  }
}

/** X's login pages. The old /i/flow/login now redirects to /i/jf/onboarding/web?mode=login. */
export function isLoginUrl(url) {
  const { pathname } = new URL(url);
  return pathname.startsWith("/i/flow/login") || pathname.startsWith("/i/jf/onboarding");
}

/**
 * Reads X's UserByScreenName GraphQL response. Returns null when it tells us nothing, or one of:
 *   {kind: "rate_limited"}, {kind: "not_found"}, {kind: "suspended", reason},
 *   {kind: "unavailable", reason}, {kind: "user", handle, userId?, blocked, blockingKnown?}
 */
export function classifyLookup(httpStatus, body) {
  if (httpStatus === 429) return { kind: "rate_limited" };
  if (httpStatus !== 200 || !body || typeof body !== "object") return null;

  const user = body.data?.user;
  if (body.errors && !user) return null;

  const result = user?.result;
  if (!result) return { kind: "not_found" };

  if (result.__typename === "UserUnavailable") {
    const reason = String(result.reason ?? result.message ?? result.unavailable_message?.text ?? "");
    return { kind: /suspend/i.test(reason) ? "suspended" : "unavailable", reason };
  }
  if (result.__typename === "User") {
    const blocking = result.relationship_perspectives?.blocking ?? result.legacy?.blocking;
    return {
      kind: "user",
      handle: result.core?.screen_name ?? result.legacy?.screen_name ?? null,
      blocked: Boolean(blocking),
      ...(isUserId(result.rest_id) ? { userId: result.rest_id, blockingKnown: typeof blocking === "boolean" } : {}),
    };
  }
  return null;
}

/**
 * Runs in the browser, so it must not use anything from outside its own body.
 * Returns null while the page is still loading, or one of:
 *   {kind: "profile", handle, blocked}, {kind: "suspended"}, {kind: "not_found"},
 *   {kind: "interstitial"}, {kind: "error", note}
 */
export function probeProfilePage() {
  const column = document.querySelector('[data-testid="primaryColumn"]');
  const userName = document.querySelector('[data-testid="UserName"]');
  const blocked = Boolean(column?.querySelector('[data-testid$="-unblock"]'));
  if (userName && (blocked || document.querySelector('[data-testid="userActions"]'))) {
    // The display name comes first and may contain "@", so the handle is the last match.
    const handles = [...userName.innerText.matchAll(/@(\w+)/g)].map((match) => match[1]);
    return { kind: "profile", handle: handles.at(-1) ?? null, blocked };
  }

  const text = column?.innerText ?? "";
  if (/Account suspended/.test(text)) return { kind: "suspended" };
  if (/This account doesn.t exist/.test(text)) return { kind: "not_found" }; // X uses a curly apostrophe

  const viewProfile = [...document.querySelectorAll('button, [role="button"]')].find(
    (element) => element.innerText.trim() === "Yes, view profile",
  );
  if (viewProfile) {
    viewProfile.click();
    return { kind: "interstitial" };
  }

  const error = text.match(/Something went wrong|Rate limit|Try again later/);
  if (error) return { kind: "error", note: error[0] };
  return null;
}

/** Combines the API lookup and the page probe into a verdict for `target`, or null to keep waiting. */
export function judgeProfile(target, lookup, page, { requireVerifiedState = false } = {}) {
  const isTarget = (handle) => typeof handle === "string" && handle.toLowerCase() === target.toLowerCase();
  const mismatch = (handle) => ({ status: "mismatch", note: `profile shows @${handle}` });

  const verified = lookup?.kind === "user" && isTarget(lookup.handle) &&
    isUserId(lookup.userId) && lookup.blockingKnown;

  switch (lookup?.kind) {
    case "rate_limited":
      return { status: "rate_limited", note: "X returned HTTP 429" };
    case "not_found":
    case "suspended":
      return { status: lookup.kind };
    case "unavailable":
      return { status: "unavailable", note: lookup.reason || undefined };
    case "user":
      if (typeof lookup.handle === "string" && lookup.handle && !isTarget(lookup.handle)) return mismatch(lookup.handle);
      if (requireVerifiedState && isTarget(lookup.handle) && !isUserId(lookup.userId)) {
        return { status: "mismatch", note: "could not verify X user ID" };
      }
      if (requireVerifiedState && verified && lookup.blocked) {
        return { status: "already_blocked", userId: lookup.userId };
      }
      if (!requireVerifiedState && lookup.blocked && page?.kind !== "profile") {
        return { status: "already_blocked", ...(isTarget(lookup.handle) && lookup.userId ? { userId: lookup.userId } : {}) };
      }
  }

  switch (page?.kind) {
    case "profile":
      if (!page.handle) return null;
      if (!isTarget(page.handle)) return mismatch(page.handle);
      if (requireVerifiedState) return verified ? { status: "ready", userId: lookup.userId } : null;
      return {
        status: page.blocked || (lookup?.kind === "user" && lookup.blocked) ? "already_blocked" : "ready",
        ...(isTarget(lookup?.handle) && isUserId(lookup.userId) ? { userId: lookup.userId } : {}),
      };
    case "suspended":
    case "not_found":
      return { status: page.kind };
    case "error":
      return { status: "error", note: page.note };
  }
  return null;
}

/** Only use responses about our target, not a late one from the previous profile. */
function isLookupFor(url, handle) {
  try {
    const screenName = JSON.parse(url.searchParams.get("variables"))?.screen_name;
    return typeof screenName === "string" && screenName.toLowerCase() === handle.toLowerCase();
  } catch {
    return false;
  }
}

async function probe(page) {
  try {
    return await page.evaluate(probeProfilePage);
  } catch (error) {
    if (page.isClosed()) throw error;
    return null; // e.g. the page navigated while we were looking
  }
}
