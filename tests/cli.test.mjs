import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, tempRoot } from "./helpers.mjs";

test("help and JSON list, inspect and validate", async (t) => {
  const root = await tempRoot(t);
  const help = await run(root, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /volt create/);
  const created = await run(root, [
    "volt",
    "create",
    "my-notes",
    "--profile",
    "basic",
    "--path",
    join(root, "my notes"),
    "--workdir",
    join(root, "work dir"),
    "--purpose",
    "Project knowledge",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /Next:/);
  const listed = await run(root, ["volt", "list", "--json"]);
  assert.equal(listed.code, 0);
  const list = JSON.parse(listed.stdout);
  assert.equal(list.vaults.length, 1);
  assert.equal(list.vaults[0].id, "my-notes");
  const inspected = await run(root, ["volt", "inspect", "my-notes", "--json"]);
  assert.equal(JSON.parse(inspected.stdout).autonomy.mode, "manual");
  const validated = await run(root, ["volt", "validate", "my-notes", "--json"]);
  assert.equal(validated.code, 0);
  assert.equal(JSON.parse(validated.stdout).ok, true);
  const invalid = await run(root, [
    "--json",
    "volt",
    "create",
    "My Notes",
    "--profile",
    "basic",
    "--path",
    "./nope",
  ]);
  assert.notEqual(invalid.code, 0);
  assert.equal(JSON.parse(invalid.stderr).code, "INVALID_ID");
});

test("the command walkthrough creates vaults, revisions and a handoff", async (t) => {
  const root = await tempRoot(t);
  const prompt = join(root, "prompt.md");
  const updated = join(root, "prompt-updated.md");
  const instructions = join(root, "instructions.md");
  await writeFile(prompt, "Implement the feature.\n");
  await writeFile(
    updated,
    "Implement the feature.\nName the files you change.\n",
  );
  await writeFile(instructions, "Use only the attached context.\n");
  for (const args of [
    [
      "volt",
      "create",
      "my-notes",
      "--profile",
      "basic",
      "--path",
      "./volts/my notes",
      "--purpose",
      "Project knowledge",
    ],
    [
      "volt",
      "create",
      "project-dev",
      "--profile",
      "dev",
      "--path",
      "./volts/project-dev",
      "--workdir",
      "./repo",
      "--purpose",
      "Development context",
    ],
    [
      "volt",
      "create",
      "helper-context",
      "--profile",
      "agent",
      "--path",
      "./volts/helper-context",
      "--purpose",
      "Helper context",
    ],
  ]) {
    const result = await run(root, args);
    assert.equal(result.code, 0, result.stderr);
  }
  await writeFile(
    join(root, "volts/my notes/context/public.md"),
    "Visible note\n",
  );
  await writeFile(
    join(root, "volts/my notes/context/secret.md"),
    "DO_NOT_EXPORT_SENTINEL\n",
  );
  const added = await run(root, [
    "prompt",
    "add",
    "project-dev",
    "--name",
    "implement-feature",
    "--file",
    prompt,
  ]);
  assert.equal(added.code, 0, added.stderr);
  const revised = await run(root, [
    "prompt",
    "revise",
    "project-dev",
    "implement-feature",
    "--file",
    updated,
    "--message",
    "Clarify expected output",
  ]);
  assert.equal(revised.code, 0, revised.stderr);
  assert.match(revised.stdout, /r2/);
  const defined = await run(root, [
    "agent",
    "define",
    "helper",
    "--volt",
    "helper-context",
    "--instructions",
    instructions,
  ]);
  assert.equal(defined.code, 0, defined.stderr);
  assert.match(defined.stdout, /Launched: no/);
  const attached = await run(root, [
    "agent",
    "attach",
    "helper",
    "--context",
    "my-notes",
    "--include",
    "context/public.md",
    "--access",
    "read",
  ]);
  assert.equal(attached.code, 0, attached.stderr);
  const exported = await run(root, [
    "context",
    "export",
    "helper",
    "--output",
    "./exports/helper context.md",
    "--json",
  ]);
  assert.equal(exported.code, 0, exported.stderr);
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.launched, false);
  const bundle = await readFile(
    join(root, "exports", "helper context.md"),
    "utf8",
  );
  assert.match(bundle, /Visible note/);
  assert.equal(bundle.includes("DO_NOT_EXPORT_SENTINEL"), false);
  const again = await run(root, [
    "volt",
    "create",
    "my-notes",
    "--profile",
    "basic",
    "--path",
    "./volts/my notes",
    "--purpose",
    "Project knowledge",
  ]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /unchanged|Preserved/);
  assert.match(
    await readFile(join(root, "volts/my notes/context/public.md"), "utf8"),
    /Visible note/,
  );
});

test("the terminal UI can provision a vault through the same services", async (t) => {
  const root = await tempRoot(t);
  const script = [
    "create",
    "profile basic",
    "name from-ui",
    "purpose Project knowledge",
    "path ./ui vault",
    "workdir ./ui work",
    "preview",
    "confirm",
    "validate from-ui",
    "quit",
    "",
  ].join("\n");
  const result = await run(root, ["ui"], script);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Next:/);
  assert.match(result.stdout, /valid from-ui/);
  const listed = await run(root, ["volt", "list", "--json"]);
  assert.equal(JSON.parse(listed.stdout).vaults[0].id, "from-ui");
});
