import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKrakenApp } from "../dist/index.js";
import { appAt, rejectsCode, tempRoot } from "./helpers.mjs";

const SENTINEL = "DO_NOT_EXPORT_SENTINEL";

async function fixture(root) {
  const app = appAt(root);
  const notes = await app.createVolt({
    id: "my-notes",
    profile: "basic",
    path: join(root, "notes"),
    purpose: "Project knowledge",
    workdir: join(root, "notes-work"),
    dryRun: false,
  });
  const dev = await app.createVolt({
    id: "project-dev",
    profile: "dev",
    path: join(root, "dev"),
    purpose: "Development context",
    workdir: join(root, "repo"),
    dryRun: false,
  });
  const agent = await app.createVolt({
    id: "helper-context",
    profile: "agent",
    path: join(root, "agent"),
    purpose: "Helper context",
    workdir: join(root, "agent-work"),
    dryRun: false,
  });
  await mkdirPublic(notes.vaultRoot);
  await writeFile(
    join(root, "instructions.md"),
    "Answer from the selected context only.\n",
  );
  await writeFile(join(root, "prompt.md"), "Implement the feature.\n");
  await app.addPrompt({
    volt: "project-dev",
    name: "implement-feature",
    file: join(root, "prompt.md"),
  });
  return { app, notes, dev, agent };
}

async function mkdirPublic(vaultRoot) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(vaultRoot, "context", "public"), { recursive: true });
  await writeFile(
    join(vaultRoot, "context", "public", "brief.md"),
    "Public brief\n",
  );
  await writeFile(join(vaultRoot, "context", "secret.md"), `${SENTINEL}\n`);
}

test("an agent definition can export only the selected context", async (t) => {
  const root = await tempRoot(t);
  const { app, notes, dev, agent } = await fixture(root);
  const defined = await app.defineAgent({
    agentId: "helper",
    volt: "helper-context",
    instructions: join(root, "instructions.md"),
  });
  assert.equal(defined.agent.status, "defined");
  assert.equal(defined.agent.adapter, "manual-handoff");
  await rejectsCode(
    app.attachContext({
      agentId: "helper",
      context: "my-notes",
      include: "**",
      access: "read",
    }),
    "IMPLICIT_CONTEXT",
  );
  const attached = await app.attachContext({
    agentId: "helper",
    context: "my-notes",
    include: "context/public/**",
    access: "read",
  });
  assert.equal(attached.status, "attached");
  await app.attachContext({
    agentId: "helper",
    context: "project-dev",
    include: "prompts/implement-feature/current.md",
    access: "read",
  });
  const output = join(root, "exports", "helper context.md");
  const exported = await app.exportContext({ agentId: "helper", output });
  assert.equal(exported.launched, false);
  assert.equal(exported.enforcementAfterHandoff, false);
  assert.equal(exported.adapter, "manual-handoff");
  const bundle = await readFile(output, "utf8");
  assert.match(bundle, /Launched: no/);
  assert.match(bundle, /do not enforce restrictions on an external assistant/);
  assert.match(bundle, /Public brief/);
  assert.match(bundle, /Implement the feature/);
  assert.match(bundle, /revision=r1|Revision: r1/);
  assert.equal(bundle.includes(SENTINEL), false);
  assert.equal(JSON.stringify(exported).includes(SENTINEL), false);
  const agentFiles = await readFile(
    join(agent.vaultRoot, "instructions", "helper.md"),
    "utf8",
  );
  assert.match(agentFiles, /selected context/);
  assert.equal(agentFiles.includes(SENTINEL), false);
  assert.equal(
    await readFile(join(notes.vaultRoot, "context", "secret.md"), "utf8").then(
      (text) => text.includes(SENTINEL),
    ),
    true,
  );
  const devPrompt = await readFile(
    join(dev.vaultRoot, "prompts/implement-feature/revisions/r1.md"),
    "utf8",
  );
  assert.equal(devPrompt, "Implement the feature.\n");
  await rejectsCode(
    app.exportContext({ agentId: "helper", output }),
    "OUTPUT_EXISTS",
  );
});

test("removing share denies the handoff and writes no bundle", async (t) => {
  const root = await tempRoot(t);
  const { app, notes } = await fixture(root);
  await app.defineAgent({
    agentId: "helper",
    volt: "helper-context",
    instructions: join(root, "instructions.md"),
  });
  const definitionPath = join(notes.vaultRoot, "volt.json");
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  definition.policy.share = [];
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  await rejectsCode(
    app.attachContext({
      agentId: "helper",
      context: "my-notes",
      include: "context/public/**",
      access: "read",
    }),
    "DENIED_SHARE",
  );
  const agentJson = JSON.parse(
    await readFile(
      join(root, "agent", "agent-definitions", "helper.json"),
      "utf8",
    ),
  );
  assert.deepEqual(agentJson.attachments, []);
  definition.policy.share = ["owner"];
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  await app.attachContext({
    agentId: "helper",
    context: "my-notes",
    include: "context/public/**",
    access: "read",
  });
  definition.policy.share = [];
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  const output = join(root, "blocked.md");
  await rejectsCode(
    app.exportContext({ agentId: "helper", output }),
    "DENIED_SHARE",
  );
  await assert.rejects(readFile(output, "utf8"), /ENOENT/);
});

test("a principal outside the owner group cannot read a vault into a handoff", async (t) => {
  const root = await tempRoot(t);
  const { app } = await fixture(root);
  await app.defineAgent({
    agentId: "helper",
    volt: "helper-context",
    instructions: join(root, "instructions.md"),
  });
  const outsider = createKrakenApp({
    cwd: root,
    registryPath: join(root, "registry.json"),
    principal: { id: "outsider", groups: [] },
  });
  await rejectsCode(
    outsider.exportContext({ agentId: "helper", output: join(root, "out.md") }),
    "DENIED_READ",
  );
});
