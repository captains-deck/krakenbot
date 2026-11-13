import assert from "node:assert/strict";
import test from "node:test";
import { assertExplicitInclude, matchesInclude } from "../dist/index.js";

test("context selections match only the named root", () => {
  assert.equal(matchesInclude("context/**", "context/a.md"), true);
  assert.equal(matchesInclude("context/**", "context/sub/a.md"), true);
  assert.equal(matchesInclude("context/**", "context-secret/a.md"), false);
  assert.equal(matchesInclude("context/**", "secret.md"), false);
  assert.equal(
    matchesInclude("context/public/**", "context/public/note.md"),
    true,
  );
  assert.equal(
    matchesInclude("context/public/**", "context/private/secret.md"),
    false,
  );
  assert.doesNotThrow(() => assertExplicitInclude("context/**"));
  for (const pattern of [
    "**",
    "*",
    "**/*",
    "context/../secret.md",
    "/tmp/context/a.md",
  ]) {
    assert.throws(() => assertExplicitInclude(pattern));
  }
});
