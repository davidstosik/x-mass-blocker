import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifyLookup, judgeProfile } from "../src/profile.js";

const user = (result) => ({ data: { user: { result } } });

describe("classifyLookup", () => {
  test("HTTP 429 is a rate limit", () => {
    assert.deepEqual(classifyLookup(429, null), { kind: "rate_limited" });
  });

  test("other errors and unreadable bodies tell us nothing", () => {
    assert.equal(classifyLookup(500, {}), null);
    assert.equal(classifyLookup(200, null), null);
    assert.equal(classifyLookup(200, { errors: [{ message: "Timeout" }] }), null);
  });

  test("HTTP 200 without a user result is not_found", () => {
    assert.deepEqual(classifyLookup(200, { data: {} }), { kind: "not_found" });
    assert.deepEqual(classifyLookup(200, { data: { user: {} } }), { kind: "not_found" });
  });

  test("UserUnavailable is suspended when the reason says so", () => {
    assert.deepEqual(classifyLookup(200, user({ __typename: "UserUnavailable", reason: "Suspended" })), {
      kind: "suspended",
      reason: "Suspended",
    });
    assert.deepEqual(classifyLookup(200, user({ __typename: "UserUnavailable", reason: "NoReason" })), {
      kind: "unavailable",
      reason: "NoReason",
    });
  });

  test("User reads the handle and blocking state from core and relationship_perspectives", () => {
    const result = {
      __typename: "User",
      core: { screen_name: "Alice" },
      legacy: { screen_name: "old", blocking: false },
      relationship_perspectives: { blocking: true },
    };
    assert.deepEqual(classifyLookup(200, user(result)), { kind: "user", handle: "Alice", blocked: true });
  });

  test("User falls back to the legacy fields", () => {
    const result = { __typename: "User", legacy: { screen_name: "bob", blocking: true } };
    assert.deepEqual(classifyLookup(200, user(result)), { kind: "user", handle: "bob", blocked: true });
    const unblocked = { __typename: "User", legacy: { screen_name: "bob" } };
    assert.deepEqual(classifyLookup(200, user(unblocked)), { kind: "user", handle: "bob", blocked: false });
  });

  test("errors next to a user result don't hide it", () => {
    const body = { ...user({ __typename: "User", core: { screen_name: "carol" } }), errors: [{ message: "partial" }] };
    assert.equal(classifyLookup(200, body).kind, "user");
  });
});

describe("judgeProfile", () => {
  const profile = (handle, blocked = false) => ({ kind: "profile", handle, blocked });

  test("waits while neither signal is conclusive", () => {
    assert.equal(judgeProfile("alice", null, null), null);
    assert.equal(judgeProfile("alice", null, { kind: "interstitial" }), null);
    assert.equal(judgeProfile("alice", { kind: "user", handle: "alice", blocked: false }, null), null);
  });

  test("the page is ready when it shows the target's profile", () => {
    assert.deepEqual(judgeProfile("alice", null, profile("Alice")), { status: "ready" });
  });

  test("a different handle is a mismatch, from either signal", () => {
    assert.deepEqual(judgeProfile("alice", null, profile("bob")), { status: "mismatch", note: "profile shows @bob" });
    assert.deepEqual(judgeProfile("alice", { kind: "user", handle: "bob", blocked: false }, profile("alice")), {
      status: "mismatch",
      note: "profile shows @bob",
    });
  });

  test("already blocked, from either signal", () => {
    assert.deepEqual(judgeProfile("alice", { kind: "user", handle: "alice", blocked: true }, null), {
      status: "already_blocked",
    });
    assert.deepEqual(judgeProfile("alice", { kind: "user", handle: "alice", blocked: false }, profile("alice", true)), {
      status: "already_blocked",
    });
  });

  test("the API answer wins for missing and suspended accounts", () => {
    assert.deepEqual(judgeProfile("alice", { kind: "not_found" }, null), { status: "not_found" });
    assert.deepEqual(judgeProfile("alice", { kind: "suspended", reason: "Suspended" }, null), { status: "suspended" });
    assert.deepEqual(judgeProfile("alice", { kind: "unavailable", reason: "Protected" }, null), {
      status: "unavailable",
      note: "Protected",
    });
    assert.equal(judgeProfile("alice", { kind: "rate_limited" }, profile("alice")).status, "rate_limited");
  });

  test("page text fallbacks", () => {
    assert.deepEqual(judgeProfile("alice", null, { kind: "not_found" }), { status: "not_found" });
    assert.deepEqual(judgeProfile("alice", null, { kind: "suspended" }), { status: "suspended" });
    assert.deepEqual(judgeProfile("alice", null, { kind: "error", note: "Something went wrong" }), {
      status: "error",
      note: "Something went wrong",
    });
  });
});
