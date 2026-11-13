import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appAt, rejectsCode, tempRoot } from "./helpers.mjs";

async function devVault(root) {
  const app = appAt(root);
  const created = await app.createVolt({
    id: "project-dev",
    profile: "dev",
    path: join(root, "dev"),
    purpose: "Development context",
    workdir: join(root, "repo"),
    dryRun: false,
  });
  return { app, created };
}

test("prompt revisions stay immutable and distinct from the vault files", async (t) => {
  const root = await tempRoot(t);
  const { app, created } = await devVault(root);
  const first = join(root, "prompt-v1.md");
  const second = join(root, "prompt-v2.md");
  const third = join(root, "prompt-v3.md");
  await writeFile(first, "Implement the feature.\n");
  await writeFile(
    second,
    "Implement the feature and name the files you change.\n",
  );
  await writeFile(
    third,
    "Implement the feature, name the files, and stop after tests.\n",
  );
  const added = await app.addPrompt({
    volt: "project-dev",
    name: "implement-feature",
    file: first,
  });
  assert.equal(added.revision, "r1");
  assert.equal(added.message, "Initial prompt");
  const revision = join(
    created.vaultRoot,
    "prompts/implement-feature/revisions/r1.md",
  );
  const original = await readFile(revision);
  await app.revisePrompt({
    volt: "project-dev",
    promptId: "implement-feature",
    file: second,
    message: "Clarify expected output",
  });
  const revised = await app.revisePrompt({
    volt: created.vaultRoot,
    promptId: "implement-feature",
    file: third,
    message: "Ask for a stopping point",
  });
  assert.equal(revised.revision, "r3");
  assert.deepEqual(await readFile(revision), original);
  const manifest = JSON.parse(
    await readFile(
      join(created.vaultRoot, "prompts/implement-feature/manifest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    manifest.revisions.map((item) => item.message),
    ["Initial prompt", "Clarify expected output", "Ask for a stopping point"],
  );
  assert.equal(
    await readFile(
      join(created.vaultRoot, "prompts/implement-feature/current.md"),
      "utf8",
    ),
    await readFile(third, "utf8"),
  );
  const same = await app.revisePrompt({
    volt: "project-dev",
    promptId: "implement-feature",
    file: third,
    message: "No further change",
  });
  assert.equal(same.status, "unchanged");
  assert.equal(same.revision, "r3");
});

test("basic vaults reject prompt storage", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  await app.createVolt({
    id: "my-notes",
    profile: "basic",
    path: join(root, "notes"),
    purpose: "Notes",
    workdir: null,
    dryRun: false,
  });
  await writeFile(join(root, "prompt.md"), "Hello\n");
  await rejectsCode(
    app.addPrompt({
      volt: "my-notes",
      name: "implement-feature",
      file: join(root, "prompt.md"),
    }),
    "WRONG_PROFILE",
  );
});
