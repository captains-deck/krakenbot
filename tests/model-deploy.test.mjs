import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRelayRequest } from "../../Relay/cloudflare/relay-inference/http.mjs";
import { createMemoryStore } from "../../Relay/cloudflare/relay-inference/store.mjs";
import { profileChecksum } from "../../Relay/cloudflare/relay-inference/contract.mjs";
import { answerQuestion, buildCompletionBody, handleJob } from "../runtime/local-runner.mjs";
import { deployModel, exportModel, restartModel, stopModel, validateModel } from "../runtime/modelDeploy.mjs";
import { submitRemoteJob } from "../runtime/remoteAgent.mjs";
import { tempRoot } from "./helpers.mjs";

const SERVICE = "service-token-0123456789abcdef";
const EXAMPLE = fileURLToPath(new URL("../examples/sentient-potato-volt", import.meta.url));
const RELEASE = {
  schema_version: 1,
  id: "sentient-potato",
  version: "0.1.0-rc.1",
  system: "You are Sentient Potato.",
  generation: { temperature: 0.7, top_p: 0.8, top_k: 20, max_tokens: 512, enable_thinking: false },
  runtime: { engine: "llama.cpp", context_tokens: 4096, context_character_budget: 2048 },
  hardware: { suggested_ram_gb: 4 },
  artifact: { sha256: "ab".repeat(32), format: "GGUF" },
  upstream: { license: "Apache-2.0" },
};

async function fixture(t) {
  const root = await tempRoot(t);
  const volt = join(root, "volt");
  await cp(EXAMPLE, volt, { recursive: true });
  const specPath = join(volt, "models", "deployments", "sentient-potato.desired.json");
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  spec.artifactSha256 = RELEASE.artifact.sha256;
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const store = createMemoryStore();
  const started = [];
  const living = new Map();
  const previousHome = process.env.KRAKEN_RUNNER_HOME;
  process.env.KRAKEN_RUNNER_HOME = join(root, "secrets");
  await mkdir(process.env.KRAKEN_RUNNER_HOME, { recursive: true });
  t.after(() => { if (previousHome === undefined) delete process.env.KRAKEN_RUNNER_HOME; else process.env.KRAKEN_RUNNER_HOME = previousHome; });
  async function fetchImpl(url, init = {}) {
    return handleRelayRequest(new Request(url, init), { RELAY_SERVICE_TOKEN: SERVICE }, store);
  }
  const input = {
    voltPath: volt,
    specPath,
    accountId: "acct-1",
    environmentId: "env-1",
    relay: { token: SERVICE, relayUrl: "http://127.0.0.1:9" },
    hardware: { platform: "darwin", arch: "arm64", ramGb: 16 },
    fetch: fetchImpl,
    resolveRuntime: async () => ({ release: RELEASE, command: ["/usr/bin/false", RELEASE.artifact.sha256] }),
    portBusy: async () => false,
    waitForReady: async () => true,
    sleep: async () => {},
    now: () => "2026-11-15T22:00:00.000Z",
    alive: (pid) => living.has(pid),
    command: async (pid) => living.get(pid) || "",
    kill: (pid) => { living.delete(pid); },
    startProcess: async (spec) => {
      started.push(spec.role);
      const pid = spec.role === "llama" ? 4100 : 4101;
      living.set(pid, spec.role === "llama" ? RELEASE.artifact.sha256 : "sentient-potato-local");
      if (spec.role === "runner") await fetchImpl(new URL("/v1/inference/poll", "http://127.0.0.1:9"), { headers: { Authorization: `Bearer ${spec.env.RUNNER_TOKEN}` } });
      return { pid };
    },
  };
  return { volt, specPath, input, started, store };
}

test("the example volt matches the canonical release and keeps the prompt out of the volt", async () => {
  const report = await validateModel({ voltPath: EXAMPLE });
  assert.equal(report.ok, true);
  assert.equal(report.implemented, true);
  assert.equal(report.systemPromptCopied, false);
  assert.equal(report.artifactPresent, true);
  const desired = await readFile(join(EXAMPLE, "models", "deployments", "sentient-potato.desired.json"), "utf8");
  assert.equal(desired.includes("You are Sentient Potato"), false);
});

test("a member cannot validate and a foreign volt field is rejected", async (t) => {
  const { volt } = await fixture(t);
  await assert.rejects(validateModel({ voltPath: volt, principal: { id: "member-1", groups: ["member"] }, releaseRoot: EXAMPLE, specPath: join(volt, "models", "deployments", "sentient-potato.desired.json") }), /WormVolt policy denied write/);
  const definition = JSON.parse(await readFile(join(volt, "volt.json"), "utf8"));
  definition.extra = true;
  await writeFile(join(volt, "volt.json"), JSON.stringify(definition));
  await assert.rejects(validateModel({ voltPath: volt, specPath: join(volt, "models", "deployments", "sentient-potato.desired.json"), releaseRoot: EXAMPLE }), /volt.json/);
});

test("deploy verifies, enrolls, reuses, stops and restarts without a second healthy runtime", async (t) => {
  const { volt, input, started } = await fixture(t);
  const first = await deployModel(input);
  assert.equal(first.reused, false);
  assert.deepEqual(started, ["llama", "runner"]);
  const record = await readFile(join(volt, "models", "deployments", "sentient-potato-local.record.json"), "utf8");
  const token = (await readFile(join(process.env.KRAKEN_RUNNER_HOME, "sentient-potato-local"), "utf8")).trim();
  assert.equal(record.includes(token), false);
  assert.equal(record.includes(RELEASE.system), false);
  assert.equal(JSON.parse(record).profileChecksum, await profileChecksum(RELEASE));
  const second = await deployModel(input);
  assert.equal(second.reused, true);
  assert.deepEqual(started, ["llama", "runner"]);
  const stopped = await stopModel(input);
  assert.equal(stopped.status, "stopped");
  const restarted = await restartModel(input);
  assert.equal(restarted.reused, false);
  assert.deepEqual(started, ["llama", "runner", "llama", "runner"]);
  const exported = await exportModel({ voltPath: volt, output: join(volt, "..", "export") });
  const exportedRecord = await readFile(join(exported.output, "models", "deployments", "sentient-potato-local.record.json"), "utf8");
  assert.equal(exportedRecord.includes(token), false);
  await assert.rejects(readFile(join(exported.output, "models", "local", "state.json")));
  const recordPath = join(volt, "models", "deployments", "sentient-potato-local.record.json");
  const currentToken = (await readFile(join(process.env.KRAKEN_RUNNER_HOME, "sentient-potato-local"), "utf8")).trim();
  const original = await readFile(recordPath, "utf8");
  await writeFile(recordPath, original.replace("Apache-2.0", currentToken));
  await assert.rejects(exportModel({ voltPath: volt, output: join(volt, "..", "poison") }), /credential/);
  await writeFile(recordPath, original);
});

test("restart can explicitly migrate scope, revokes the old runner and preserves scope when omitted", async (t) => {
  const { volt, input, store, started } = await fixture(t);
  await deployModel(input);
  const oldToken = (await readFile(join(process.env.KRAKEN_RUNNER_HOME, "sentient-potato-local"), "utf8")).trim();
  await assert.rejects(restartModel({ ...input, accountId: "hosted-account", environmentId: undefined }), /both the account and environment/);
  assert.equal(input.alive(4100), true);
  await restartModel({ ...input, accountId: "hosted-account", environmentId: "hosted-environment" });
  assert.equal((await store.poll(oldToken)).status, 401);
  const record = JSON.parse(await readFile(join(volt, "models", "deployments", "sentient-potato-local.record.json"), "utf8"));
  assert.equal(record.ownership.accountId, "hosted-account");
  assert.equal(record.ownership.environmentId, "hosted-environment");
  await restartModel({ ...input, accountId: undefined, environmentId: undefined });
  assert.deepEqual(started, ["llama", "runner", "llama", "runner", "llama", "runner"]);
});

test("restart rejects pinned ownership changes before stopping the runtime", async (t) => {
  const { input, specPath } = await fixture(t);
  await deployModel(input);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  spec.ownership.accountId = input.accountId;
  await writeFile(specPath, JSON.stringify(spec));
  await assert.rejects(restartModel({ ...input, accountId: "another-account", environmentId: "another-environment" }), /specification account/);
  assert.equal(input.alive(4100), true);
  assert.equal(input.alive(4101), true);
});

test("insufficient hardware, a failed start and a remote agent do not leave a running model", async (t) => {
  const { input, started } = await fixture(t);
  await assert.rejects(deployModel({ ...input, hardware: { ...input.hardware, ramGb: 1 } }), /suggests 4 GB/);
  assert.deepEqual(started, []);
  await assert.rejects(deployModel({ ...input, waitForReady: async () => false }), /did not become ready/);
  assert.equal(input.alive(4100), false);
  const remote = structuredClone(JSON.parse(await readFile(input.specPath, "utf8")));
  remote.executionHost.kind = "remote-agent";
  await writeFile(input.specPath, JSON.stringify(remote));
  await assert.rejects(deployModel(input), /not implemented/);
  const rejected = submitRemoteJob({ schemaVersion: 1, jobId: crypto.randomUUID(), deploymentId: "sentient-potato-local", executionHostId: "mac-remote", operation: "start-runtime", releaseRef: { modelId: "sentient-potato", releaseVersion: "0.1.0-rc.1", artifactSha256: "ab".repeat(32) } });
  assert.equal(rejected.executed, false);
  assert.equal(rejected.code, "REMOTE_AGENT_UNAVAILABLE");
});

test("the runner applies the release profile and does not execute an expired request", async () => {
  const body = buildCompletionBody(RELEASE, "What is your name?");
  assert.equal(body.messages[0].content, RELEASE.system);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
  let called = false;
  const checksum = await profileChecksum(RELEASE);
  const expired = await handleJob({ profileChecksum: checksum, deadline: "2000-01-01T00:00:00.000Z", input: { text: "late" } }, RELEASE, { now: () => Date.now(), llamaBase: "http://127.0.0.1:9/v1", fetchImpl: async () => { called = true; throw new Error("executed"); } });
  assert.equal(expired.status, "expired");
  assert.equal(called, false);
  const answered = await answerQuestion(RELEASE, "http://127.0.0.1:9/v1", "What is your name?", 1000, async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.messages[0].content, RELEASE.system);
    return Response.json({ choices: [{ message: { content: "I am Sentient Potato." } }] });
  });
  assert.equal(answered.text, "I am Sentient Potato.");
  const source = await readFile(fileURLToPath(new URL("../runtime/local-runner.mjs", import.meta.url)), "utf8");
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("submitRemoteJob"), false);
});
