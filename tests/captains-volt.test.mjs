import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, parseCaptainsMeta } from "../runtime/captainsVoltPlan.mjs";
import { provisionCaptainsFilesystem } from "../runtime/captainsProvision.mjs";
import { run, tempRoot } from "./helpers.mjs";

const stamp = "2026-11-13T16:00:00.000Z";
const environment = { id: "environment-ai-captain-demo", title: "AI Captain Demo", description: "Demo" };

function plan(extra = {}) {
  return buildPlan({
    voltId: "harbour-notes",
    title: "Harbour notes",
    description: "A small volt",
    voltType: "development",
    modules: [],
    environment,
    project: null,
    mission: null,
    creationRequestId: "cr-1",
    krakenRunId: "kr-1",
    createdAt: stamp,
    updatedAt: stamp,
    storage: { kind: "r2", bucket: "captains-volt", keyPrefix: "owners/dev-owner/volts/harbour-notes" },
    ...extra,
  });
}

test("the development template is versioned and keeps WormVolt strict", () => {
  const built = plan();
  const paths = built.files.map((file) => file.path).sort();
  assert.deepEqual(paths, [
    "Architecture/Overview.md",
    "Command Chest/Foundations Dev Prompt.md",
    "Decisions/ADR.md",
    "DevAudit/README.md",
    "Handoff/Handoff.md",
    "Kraken/DeploymentWorkflow.md",
    "Kraken/DevEnvironmentCreation.md",
    "Kraken/DevProvisioning.md",
    "Kraken/Testing.md",
    "Kraken/dev-agents.md",
    "Manifests/Manifest.md",
    "Models/Model Manifest.md",
    "Repositories/Repository.md",
    "Requirements/Requirements.md",
    "Requirements/Technical Specs.md",
    "Stacks/Stack.md",
    "Summary.md",
    "Volt-meta/captains-volt.json",
    "knowledge/welcome.md",
    "kraken.json",
    "volt.json",
    "worm/Asset Index.md",
    "worm/workingMemory.md",
    "worm/worm-in/README.md",
    "worm/worm-out/README.md",
  ]);
  const definition = JSON.parse(built.files.find((file) => file.path === "volt.json").contents);
  assert.deepEqual(Object.keys(definition).sort(), ["audience", "autonomy", "connections", "id", "knowledge", "name", "policy", "purpose", "schemaVersion", "securityGroups", "structure"]);
  assert.equal(definition.structure.template, "captains-development");
  const manifest = JSON.parse(built.files.find((file) => file.path === "kraken.json").contents);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.profile, "captains-development");
  assert.equal(Object.hasOwn(manifest, "vaultRoot"), false);
  assert.equal(manifest.storage.kind, "r2");
  const meta = JSON.parse(built.files.find((file) => file.path === "Volt-meta/captains-volt.json").contents);
  assert.equal(meta.schemaVersion, 2);
  assert.equal(meta.ownership.kind, "environment");
  assert.equal(meta.project, null);
  assert.equal(meta.mission, null);
  assert.match(built.files.find((file) => file.path === "Command Chest/Foundations Dev Prompt.md").contents, /Revision: r1/);
  assert.match(built.files.find((file) => file.path === "Kraken/dev-agents.md").contents, /Unconfigured/);
  assert.match(built.files.find((file) => file.path === "Kraken/dev-agents.md").contents, /not launched/i);
  assert.match(built.files.find((file) => file.path === "DevAudit/README.md").contents, /does not call an audit service/);
  assert.match(built.files.find((file) => file.path === "worm/workingMemory.md").contents, /does not start crawling/);
  assert.match(built.files.find((file) => file.path === "knowledge/welcome.md").contents, /^# WormVolt record\n/);
});

test("scratch modules stay optional and dependencies are explicit", () => {
  const bare = plan({ voltType: "scratch", modules: [] });
  assert.deepEqual(bare.files.map((file) => file.path).sort(), ["Summary.md", "Volt-meta/captains-volt.json", "knowledge/welcome.md", "kraken.json", "volt.json"]);
  const withAgents = plan({ voltType: "scratch", modules: ["agents", "integrations"] });
  assert.ok(withAgents.modules.includes("kraken"));
  assert.ok(withAgents.files.some((file) => file.path === "Integrations/README.md"));
  assert.match(withAgents.files.find((file) => file.path === "Integrations/README.md").contents, /Not connected/);
  assert.equal(withAgents.metadata.integrations[0].status, "declared");
  assert.throws(() => plan({ voltType: "scratch", modules: ["nope"] }), /Unknown module/);
});

test("a mission association does not become ownership", () => {
  const built = plan({
    project: { id: "support-chatbot", title: "Support", description: "Answers" },
    mission: { id: "mission-first-knowledge-base", title: "First knowledge base", description: "Collect notes" },
  });
  assert.equal(built.metadata.ownership.kind, "project");
  assert.equal(built.metadata.references[0].missionId, "mission-first-knowledge-base");
  assert.equal(built.metadata.ownership.missionId, undefined);
});

test("legacy portal metadata stays readable", () => {
  const parsed = parseCaptainsMeta({ schemaVersion: 1, ownerScope: { kind: "project", environmentId: "environment-ai-captain-demo", projectId: "support-chatbot" }, voltId: "support-knowledge" });
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.portal.voltId, "support-knowledge");
});

test("filesystem provisioning resumes without overwriting edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "captains-volt-"));
  try {
    const input = { voltId: "harbour-notes", path: root, title: "Harbour notes", description: "A small volt", voltType: "scratch", modules: [], environment, dryRun: false };
    const first = await provisionCaptainsFilesystem(input);
    assert.equal(first.written.includes("Summary.md"), true);
    const summary = join(root, "Summary.md");
    await writeFile(summary, "# Edited by hand\n");
    const second = await provisionCaptainsFilesystem(input);
    assert.equal(second.preserved.includes("Summary.md"), true);
    assert.equal(await readFile(summary, "utf8"), "# Edited by hand\n");
    const manifest = JSON.parse(await readFile(join(root, "kraken.json"), "utf8"));
    assert.equal(manifest.storage.kind, "filesystem");
    assert.equal(manifest.storage.root, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provision-captains is a separate command and volt create still rejects a bad profile", async (t) => {
  const root = await tempRoot(t);
  const help = await run(root, ["volt", "--help"]);
  assert.match(help.stdout, /provision-captains/);
  assert.match(help.stdout, /basic\|dev\|agent/);
  const created = await run(root, ["volt", "create", "my-notes", "--profile", "captains-development", "--path", join(root, "vault")]);
  assert.notEqual(created.code, 0);
  const dry = await run(root, ["volt", "provision-captains", "harbour-notes", "--path", join(root, "harbour"), "--type", "scratch", "--title", "Harbour notes", "--environment", environment.id, "--environment-title", environment.title, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  const body = JSON.parse(dry.stdout);
  assert.equal(body.dryRun, true);
  assert.equal(body.files.includes("Summary.md"), true);
});
