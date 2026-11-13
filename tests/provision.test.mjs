import assert from "node:assert/strict";
import test from "node:test";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parseVolt } from "@wormvolt/core";
import { appAt, rejectsCode, tempRoot } from "./helpers.mjs";

async function create(app, root, profile, id, purpose) {
  return app.createVolt({
    id,
    profile,
    path: join(root, "vaults", id),
    purpose,
    workdir: join(root, "work", id),
    dryRun: false,
  });
}

test("three profiles share provisioning and stay valid WormVolt definitions", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  const created = [];
  for (const [profile, id, purpose] of [
    ["basic", "my-notes", "Project knowledge"],
    ["dev", "project-dev", "Implementation context"],
    ["agent", "helper-context", "Helper context"],
  ]) {
    const result = await create(app, root, profile, id, purpose);
    created.push(result);
    assert.equal(result.status, "created");
    assert.notEqual(result.vaultRoot, result.workingDirectory);
    assert.match(result.next, /kraken /);
    const definition = parseVolt(
      JSON.parse(await readFile(join(result.vaultRoot, "volt.json"), "utf8")),
    );
    assert.equal(definition.schemaVersion, 1);
    assert.equal(definition.id, id);
    assert.equal(definition.autonomy.mode, "manual");
    assert.deepEqual(definition.connections, []);
    assert.equal("profile" in definition, false);
    const manifest = JSON.parse(
      await readFile(join(result.vaultRoot, "kraken.json"), "utf8"),
    );
    assert.equal(manifest.profile, profile);
    assert.equal(manifest.workingDirectory, result.workingDirectory);
    assert.equal(manifest.vaultRoot, result.vaultRoot);
    const report = await app.validateVolt(id);
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    const workFile = join(result.workingDirectory, "keep.txt");
    await writeFile(workFile, "KEEP");
    assert.equal(await readFile(workFile, "utf8"), "KEEP");
  }
  assert.deepEqual(
    (await app.listVolts()).map((vault) => vault.id),
    ["helper-context", "my-notes", "project-dev"],
  );
  const devReadme = await readFile(
    join(created[1].vaultRoot, "prompts/README.md"),
    "utf8",
  );
  assert.match(devReadme, /not Git history/);
  const agentReadme = await readFile(
    join(created[2].vaultRoot, "README.md"),
    "utf8",
  );
  assert.match(agentReadme, /does not launch/);
  assert.equal(
    await lstat(join(created[0].vaultRoot, "briefs")).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("dry run writes nothing and a repeated create preserves edits", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  const path = join(root, "my notes");
  const workdir = join(root, "work dir");
  const dry = await app.createVolt({
    id: "my-notes",
    profile: "basic",
    path,
    purpose: "Project knowledge",
    workdir,
    dryRun: true,
  });
  assert.equal(dry.status, "dry-run");
  assert.equal(
    await lstat(path).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal((await app.listVolts()).length, 0);
  const created = await app.createVolt({
    id: "my-notes",
    profile: "basic",
    path,
    purpose: "Project knowledge",
    workdir,
    dryRun: false,
  });
  assert.equal(created.status, "created");
  assert.match(created.vaultRoot, /my notes$/);
  const readme = join(created.vaultRoot, "README.md");
  const edited = `${await readFile(readme, "utf8")}\nEdited by a person.\n`;
  await writeFile(readme, edited);
  const again = await app.createVolt({
    id: "my-notes",
    profile: "basic",
    path,
    purpose: "A different purpose",
    workdir,
    dryRun: false,
  });
  assert.equal(again.status, "unchanged");
  assert.equal(await readFile(readme, "utf8"), edited);
  assert.equal(
    JSON.parse(await readFile(join(created.vaultRoot, "kraken.json"), "utf8"))
      .purpose,
    "Project knowledge",
  );
  assert.equal((await app.listVolts()).length, 1);
  const restarted = appAt(root);
  assert.equal((await restarted.listVolts())[0].id, "my-notes");
});

test("incompatible content, nested paths and symlinks fail before registration", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  const blocked = join(root, "blocked");
  await mkdir(blocked);
  await writeFile(join(blocked, "README.md"), "keep me");
  await writeFile(join(blocked, "knowledge"), "not a directory");
  await rejectsCode(
    app.createVolt({
      id: "blocked",
      profile: "basic",
      path: blocked,
      purpose: "Nope",
      workdir: join(root, "blocked-work"),
      dryRun: false,
    }),
    "INCOMPATIBLE_VAULT",
  );
  assert.equal(await readFile(join(blocked, "README.md"), "utf8"), "keep me");
  assert.equal(
    await lstat(join(blocked, "kraken.json")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal((await app.listVolts()).length, 0);

  const vault = join(root, "vault");
  await rejectsCode(
    app.createVolt({
      id: "nested",
      profile: "basic",
      path: vault,
      purpose: "Nested",
      workdir: join(vault, "src"),
      dryRun: false,
    }),
    "CONFLICTING_PATH",
  );
  assert.equal(
    await lstat(vault).then(
      () => true,
      () => false,
    ),
    false,
  );

  const target = join(root, "target");
  const link = join(root, "link");
  await mkdir(target);
  await symlink(target, link);
  await rejectsCode(
    app.createVolt({
      id: "linked",
      profile: "basic",
      path: link,
      purpose: "Linked",
      workdir: join(root, "linked-work"),
      dryRun: false,
    }),
    "UNSAFE_PATH",
  );
  assert.equal(
    await lstat(join(target, "volt.json")).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("interrupted provisioning is not listed until it can be completed in place", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  const created = await app.createVolt({
    id: "partial",
    profile: "dev",
    path: join(root, "partial"),
    purpose: "Resume me",
    workdir: join(root, "partial-work"),
    dryRun: false,
  });
  const readme = join(created.vaultRoot, "README.md");
  const edited = "person edited this\n";
  await writeFile(readme, edited);
  await rm(join(created.vaultRoot, "provisioning", "state.json"));
  await rm(join(root, "registry.json"));
  assert.equal((await appAt(root).listVolts()).length, 0);
  const report = await appAt(root).validateVolt(created.vaultRoot);
  assert.equal(report.ok, false);
  assert.equal(
    report.issues.some((issue) => issue.code === "INCOMPLETE_PROVISIONING"),
    true,
  );
  const resumed = await appAt(root).createVolt({
    id: "partial",
    profile: "dev",
    path: created.vaultRoot,
    purpose: "Resume me",
    workdir: created.workingDirectory,
    dryRun: false,
  });
  assert.equal(resumed.status, "created");
  assert.equal(await readFile(readme, "utf8"), edited);
  assert.equal((await appAt(root).listVolts()).length, 1);
  assert.equal((await appAt(root).validateVolt("partial")).ok, true);
});

test("a second id cannot take an existing vault path", async (t) => {
  const root = await tempRoot(t);
  const app = appAt(root);
  const path = join(root, "one");
  await app.createVolt({
    id: "one",
    profile: "basic",
    path,
    purpose: "First",
    workdir: join(root, "one-work"),
    dryRun: false,
  });
  await rejectsCode(
    app.createVolt({
      id: "two",
      profile: "basic",
      path,
      purpose: "Second",
      workdir: join(root, "two-work"),
      dryRun: false,
    }),
    "CONFLICTING_PATH",
  );
  assert.deepEqual(
    (await app.listVolts()).map((vault) => vault.id),
    ["one"],
  );
});
