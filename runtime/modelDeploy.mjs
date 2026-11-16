import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openSync } from "node:fs";
import { access, appendFile, chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVolt, requirePermission } from "@wormvolt/core";
import { profileChecksum } from "../../Relay/cloudflare/relay-inference/contract.mjs";
import { executableLocally, validateDesired } from "./deploymentSchema.mjs";
import { submitRemoteJob } from "./remoteAgent.mjs";

export class DeployError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeployError";
    this.code = code;
  }
}

const OPERATOR = { id: "kraken-operator", groups: ["owner"] };
const RUNNER = fileURLToPath(new URL("./local-runner.mjs", import.meta.url));
export const DEFAULT_RELEASE_ROOT = fileURLToPath(new URL("../../model-manifest", import.meta.url));

export function detectHardware() {
  return { arch: process.arch, platform: process.platform, ramGb: totalmem() / 1024 ** 3 };
}

export function safeText(value) {
  return String(value || "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Fa-f0-9]{64}/g, "[redacted-digest]").slice(0, 500);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path, value, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.writing-${process.pid}`;
  await writeFile(temporary, jsonText(value), { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function paths(voltPath, deploymentId) {
  const local = join(voltPath, "models", "local");
  return {
    local,
    spec: join(voltPath, "models", "deployments", "sentient-potato.desired.json"),
    record: join(voltPath, "models", "deployments", `${deploymentId}.record.json`),
    state: join(local, "state.json"),
    binding: join(local, "binding.json"),
    history: join(local, "history.jsonl"),
    llamaLog: join(local, "llama.log"),
    runnerLog: join(local, "runner.log"),
    lock: join(local, "lock"),
  };
}

async function history(file, entry) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function withLock(lock, work) {
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch {
    throw new DeployError("DEPLOYMENT_BUSY", "Another deployment operation is already running for this volt.");
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function verifyArtifact(file, expected) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== expected) throw new DeployError("ARTIFACT_MISMATCH", "The local weights do not match the pinned release checksum.");
  return { digest, size: (await stat(file)).size };
}

function execFileAsync(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function defaultResolveRuntime({ releaseRoot, cacheDir, llamaServer, modelId, version, port }) {
  await access(llamaServer, constants.X_OK);
  const script = [
    "import json",
    "from pathlib import Path",
    "from blackshuck.registry import recipe, server_command",
    `release = recipe(${JSON.stringify(modelId)}, ${JSON.stringify(version)})`,
    `command = server_command(release, Path(${JSON.stringify(cacheDir)}), ${JSON.stringify(llamaServer)}, ${Number(port)})`,
    'print(json.dumps({"release": release, "command": command}))',
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(process.env.PYTHON || "python3", ["-c", script], { cwd: releaseRoot, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    throw new DeployError("RELEASE_UNAVAILABLE", `The pinned release could not be resolved. ${safeText(error.stderr || error.message)}`);
  }
}

export function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultCommand(pid) {
  return new Promise((resolvePromise) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 2000 }, (error, stdout) => resolvePromise(error ? "" : String(stdout)));
  });
}

export function defaultKill(pid, signal) {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already exited */ } }
}

export async function defaultPortBusy(port) {
  const net = await import("node:net");
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (busy) => { socket.destroy(); resolvePromise(busy); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function defaultWaitForReady(port, timeoutMs, fetchImpl, sleep) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const body = await response.json().catch(() => ({}));
          if (!body.status || body.status === "ok") return true;
        }
      } catch { /* still loading */ }
      try {
        const models = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1000) });
        if (models.ok) return true;
      } catch { /* runtime still starting */ }
    await sleep(500);
  }
  return false;
}

export function defaultStartProcess(spec) {
  const logFd = openSync(spec.logPath, "w", 0o600);
  const child = spawn(spec.command[0], spec.command.slice(1), { cwd: spec.cwd, detached: true, stdio: ["ignore", logFd, logFd], env: spec.env });
  child.unref();
  return { pid: child.pid };
}

async function loadVolt(voltPath, principal, action) {
  let definition;
  try {
    definition = parseVolt(JSON.parse(await readFile(join(voltPath, "volt.json"), "utf8")));
  } catch (error) {
    throw new DeployError("INVALID_VOLT", `volt.json could not be parsed as a WormVolt definition. ${error instanceof Error ? error.message : ""}`.trim());
  }
  try {
    requirePermission(definition, principal, action);
  } catch {
    throw new DeployError("PERMISSION_DENIED", `WormVolt policy denied ${action} on ${definition.id} for ${principal.id}.`);
  }
  return definition;
}

async function loadSpec(specPath, definition, accountId, environmentId) {
  let spec;
  try { spec = await readJson(specPath); } catch { throw new DeployError("INVALID_SPEC", `Could not read the deployment specification at ${specPath}.`); }
  const problem = validateDesired(spec);
  if (problem) throw new DeployError("INVALID_SPEC", problem);
  if (spec.ownership.voltId && spec.ownership.voltId !== definition.id) throw new DeployError("OWNERSHIP_MISMATCH", "The specification volt id does not match volt.json.");
  if (spec.ownership.accountId && accountId && spec.ownership.accountId !== accountId) throw new DeployError("OWNERSHIP_MISMATCH", "The specification account does not match the requested account.");
  if (spec.ownership.environmentId && environmentId && spec.ownership.environmentId !== environmentId) throw new DeployError("OWNERSHIP_MISMATCH", "The specification environment does not match the requested environment.");
  return spec;
}

function runnerHome() {
  return process.env.KRAKEN_RUNNER_HOME || join(homedir(), ".config", "aicaptain", "kraken-runners");
}

function tokenPath(deploymentId) {
  return join(runnerHome(), deploymentId);
}

async function relayCall(deps, relayUrl, token, accountId, environmentId, path, init = {}) {
  const response = await deps.fetch(new URL(path, relayUrl), {
    ...init,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Aicaptain-Account": accountId,
      "X-Aicaptain-Environment": environmentId,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function requireRelay() {
  const token = process.env.RELAY_SERVICE_TOKEN || "";
  const relayUrl = process.env.RELAY_INFERENCE_URL || "";
  if (token.length < 32 || !relayUrl) throw new DeployError("CREDENTIAL_MISSING", "Set RELAY_INFERENCE_URL and RELAY_SERVICE_TOKEN in the environment. Do not put them in the volt, a flag, or a URL.");
  const parsed = new URL(relayUrl);
  if (parsed.username || parsed.password) throw new DeployError("CREDENTIAL_MISSING", "RELAY_INFERENCE_URL must not contain credentials.");
  return { token, relayUrl };
}

function depsOf(input) {
  return {
    fetch: input.fetch || globalThis.fetch,
    resolveRuntime: input.resolveRuntime || defaultResolveRuntime,
    startProcess: input.startProcess || (async (spec) => defaultStartProcess({ ...spec, logPath: spec.logPath })),
    alive: input.alive || defaultAlive,
    command: input.command || defaultCommand,
    kill: input.kill || defaultKill,
    portBusy: input.portBusy || defaultPortBusy,
    waitForReady: input.waitForReady || ((port, timeout) => defaultWaitForReady(port, timeout, input.fetch || globalThis.fetch, (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))),
    sleep: input.sleep || ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))),
    hardware: input.hardware || detectHardware(),
    now: input.now || (() => new Date().toISOString()),
  };
}

async function matched(deps, pid, needle) {
  if (!pid || !deps.alive(pid)) return false;
  return (await deps.command(pid)).includes(needle);
}

async function stopPids(deps, state) {
  for (const [pid, needle] of [[state?.pids?.runner, state?.runnerNeedle], [state?.pids?.llama, state?.llamaNeedle]]) {
    if (!pid || !deps.alive(pid)) continue;
    if (!(await deps.command(pid)).includes(needle || "")) throw new DeployError("REFUSED_KILL", `Refusing to signal process ${pid} because it is not the recorded runtime.`);
    deps.kill(pid, "SIGTERM");
  }
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (![state?.pids?.runner, state?.pids?.llama].some((pid) => pid && deps.alive(pid))) return;
    await deps.sleep(200);
  }
  for (const pid of [state?.pids?.runner, state?.pids?.llama]) if (pid && deps.alive(pid)) deps.kill(pid, "SIGKILL");
}

function recordFor(spec, release, checksum, ownership) {
  return {
    schemaVersion: 1,
    deploymentId: spec.deploymentId,
    modelId: release.id,
    releaseVersion: release.version,
    artifactSha256: release.artifact.sha256,
    provenance: { source: "model-manifest", path: spec.releaseRef.path, license: release.upstream?.license || "unspecified" },
    profileChecksum: checksum,
    runtime: { engine: release.runtime.engine, contextTokens: release.runtime.context_tokens, testedVersion: release.runtime.tested_version || "" },
    executionHostId: spec.executionHost.id,
    executionHostKind: spec.executionHost.kind,
    hostingMode: spec.hostingMode,
    management: spec.management,
    portal: spec.portal,
    arrangement: spec.arrangement,
    ownership,
    relay: { contract: "relay-inference/1" },
    limits: spec.limits,
    health: spec.health,
    lifecycle: spec.lifecycle,
    secretRefs: spec.secretRefs,
    resolvedAt: ownership.resolvedAt,
  };
}

async function declareIntegration(voltPath, deploymentId) {
  const path = join(voltPath, "kraken.json");
  let manifest;
  try { manifest = JSON.parse(await readFile(path, "utf8")); } catch { return false; }
  if (!manifest || (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) || !Array.isArray(manifest.integrations)) return false;
  if (!manifest.integrations.some((item) => item?.id === deploymentId)) manifest.integrations.push({ id: deploymentId, kind: "model-deployment", status: "declared" });
  await writeFile(path, jsonText(manifest));
  return true;
}

export async function validateModel(input) {
  const principal = input.principal || OPERATOR;
  const definition = await loadVolt(input.voltPath, principal, "write");
  const specPath = input.specPath || join(input.voltPath, "models", "deployments", "sentient-potato.desired.json");
  const spec = await loadSpec(specPath, definition, input.accountId, input.environmentId);
  const releaseRoot = input.releaseRoot || DEFAULT_RELEASE_ROOT;
  const release = JSON.parse(await readFile(join(releaseRoot, spec.releaseRef.path), "utf8"));
  if (release.id !== spec.modelId || release.version !== spec.releaseVersion || release.artifact?.sha256 !== spec.artifactSha256) {
    throw new DeployError("RELEASE_MISMATCH", "The specification does not match the canonical model-manifest release.");
  }
  const blob = join(input.cacheDir || join(releaseRoot, ".cache", "models"), "blobs", `${release.artifact.sha256}.gguf`);
  let artifactPresent = false;
  try { await access(blob); artifactPresent = true; } catch { artifactPresent = false; }
  return {
    ok: true,
    voltId: definition.id,
    deploymentId: spec.deploymentId,
    implemented: executableLocally(spec),
    remoteAgentImplemented: false,
    profileChecksum: await profileChecksum(release),
    artifactPresent,
    systemPromptCopied: false,
  };
}

export async function deployModel(input) {
  const deps = depsOf(input);
  const principal = input.principal || OPERATOR;
  const definition = await loadVolt(input.voltPath, principal, "write");
  const specPath = input.specPath || paths(input.voltPath).spec;
  const spec = await loadSpec(specPath, definition, input.accountId, input.environmentId);
  if (!input.accountId || !input.environmentId) throw new DeployError("OWNERSHIP_REQUIRED", "Deploy needs the account id and environment id that Captain’s Deck will resolve for the signed-in Captain.");
  if (spec.executionHost.kind === "remote-agent") {
    const remote = submitRemoteJob({ schemaVersion: 1, jobId: crypto.randomUUID(), deploymentId: spec.deploymentId, executionHostId: spec.executionHost.id, operation: "start-runtime", releaseRef: { modelId: spec.modelId, releaseVersion: spec.releaseVersion, artifactSha256: spec.artifactSha256 } });
    throw new DeployError(remote.code, remote.message);
  }
  if (!executableLocally(spec)) throw new DeployError("MODE_UNAVAILABLE", `${spec.arrangement} on ${spec.hostingMode} is documented but not implemented. This command only starts local execution.`);
  const located = paths(input.voltPath, spec.deploymentId);
  return withLock(located.lock, async () => {
    const releaseRoot = input.releaseRoot || DEFAULT_RELEASE_ROOT;
    const cacheDir = input.cacheDir || join(releaseRoot, ".cache", "models");
    const llamaServer = input.llamaServer || join(releaseRoot, ".runtime", "ollama-0.40.16", "llama-server");
    const resolved = await deps.resolveRuntime({ releaseRoot, cacheDir, llamaServer, modelId: spec.modelId, version: spec.releaseVersion, port: spec.runtime.port });
    const release = resolved.release;
    if (release.id !== spec.modelId || release.version !== spec.releaseVersion || release.artifact.sha256 !== spec.artifactSha256) throw new DeployError("RELEASE_MISMATCH", "The resolver returned a different release from the specification.");
    if (deps.hardware.platform !== "darwin" && deps.hardware.platform !== "linux") throw new DeployError("INSUFFICIENT_HARDWARE", "Local execution is implemented for macOS and Linux.");
    if (deps.hardware.ramGb + 0.25 < Number(release.hardware?.suggested_ram_gb || 0)) throw new DeployError("INSUFFICIENT_HARDWARE", `This release suggests ${release.hardware.suggested_ram_gb} GB of memory. This machine reports ${deps.hardware.ramGb.toFixed(1)} GB.`);
    const checksum = await profileChecksum(release);
    let state = null;
    try { state = await readJson(located.state); } catch { state = null; }
    const sameRelease = state?.release?.artifactSha256 === release.artifact.sha256 && state?.port === spec.runtime.port;
    const llamaAlive = sameRelease && await matched(deps, state?.pids?.llama, release.artifact.sha256);
    const runnerAlive = sameRelease && await matched(deps, state?.pids?.runner, spec.deploymentId);
    if (!input.force && spec.lifecycle.reuseRunningProcess && llamaAlive && runnerAlive && state.status === "ready") {
      let relayUpdated = false;
      try {
        const relay = input.relay || requireRelay();
        const serving = await relayCall(deps, relay.relayUrl, relay.token, input.accountId, input.environmentId, "/v1/availability", { method: "POST", body: JSON.stringify({ schemaVersion: 1, deploymentId: spec.deploymentId, availability: "serving" }) });
        relayUpdated = serving.status === 200;
      } catch { relayUpdated = false; }
      return { ok: true, reused: true, relayUpdated, deploymentId: spec.deploymentId, profileChecksum: checksum, status: "ready" };
    }
    if (await deps.portBusy(spec.runtime.port) && !llamaAlive) throw new DeployError("PORT_IN_USE", `127.0.0.1:${spec.runtime.port} is already in use. Stop the other process or choose another loopback port in the specification.`);
    const { token: serviceToken, relayUrl } = input.relay || requireRelay();
    await mkdir(located.local, { recursive: true, mode: 0o700 });
    await writeFile(join(located.local, ".gitignore"), "*\n!.gitignore\n", { mode: 0o600 });
    const ownership = { accountId: input.accountId, environmentId: input.environmentId, voltId: definition.id, resolvedAt: deps.now() };
    const record = recordFor(spec, release, checksum, ownership);
    await writeJson(located.record, record, 0o644);
    let llamaPid = null;
    let runnerPid = null;
    let runnerToken = "";
    try {
      if (!llamaAlive) {
        await stopPids(deps, state).catch(() => {});
        const started = await deps.startProcess({ role: "llama", command: resolved.command, cwd: releaseRoot, logPath: located.llamaLog, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: process.env.TMPDIR || tmpdir() } });
        llamaPid = started.pid;
        const ready = await deps.waitForReady(spec.runtime.port, spec.health.readyTimeoutSeconds * 1000);
        if (!ready) throw new DeployError("START_FAILED", "llama-server did not become ready on loopback. See models/local/llama.log.");
      } else llamaPid = state.pids.llama;
      const enrolled = await relayCall(deps, relayUrl, serviceToken, input.accountId, input.environmentId, "/v1/enroll", { method: "POST", body: JSON.stringify({ schemaVersion: 1, accountId: input.accountId, environmentId: input.environmentId, voltId: definition.id, deploymentId: spec.deploymentId, executionHostId: spec.executionHost.id, modelId: release.id, releaseVersion: release.version, artifactSha256: release.artifact.sha256, profileChecksum: checksum, hostingMode: spec.hostingMode, management: spec.management, arrangement: spec.arrangement, maxInputCharacters: spec.limits.maxInputCharacters }) });
      if (enrolled.status !== 201 || typeof enrolled.body.token !== "string") throw new DeployError("RELAY_REJECTED", enrolled.body?.error?.message || "Relay did not enroll the runner.");
      runnerToken = enrolled.body.token;
      await mkdir(runnerHome(), { recursive: true, mode: 0o700 });
      await writeFile(tokenPath(spec.deploymentId), `${runnerToken}\n`, { mode: 0o600 });
      await chmod(tokenPath(spec.deploymentId), 0o600);
      if (!runnerAlive || input.force) {
        const started = await deps.startProcess({ role: "runner", command: [process.execPath, RUNNER, spec.deploymentId], cwd: input.voltPath, logPath: located.runnerLog, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: process.env.TMPDIR || tmpdir(), RELAY_INFERENCE_URL: relayUrl, RUNNER_TOKEN: runnerToken, LLAMA_BASE_URL: `http://127.0.0.1:${spec.runtime.port}/v1`, RELEASE_FILE: join(releaseRoot, spec.releaseRef.path), DEPLOYMENT_ID: spec.deploymentId } });
        runnerPid = started.pid;
      } else runnerPid = state.pids.runner;
      const serving = await relayCall(deps, relayUrl, serviceToken, input.accountId, input.environmentId, "/v1/availability", { method: "POST", body: JSON.stringify({ schemaVersion: 1, deploymentId: spec.deploymentId, availability: "serving" }) });
      if (serving.status !== 200) throw new DeployError("RELAY_REJECTED", "Relay did not mark the deployment serving.");
      const deadline = Date.now() + 20000;
      let available = false;
      while (Date.now() < deadline) {
        const current = await relayCall(deps, relayUrl, serviceToken, input.accountId, input.environmentId, "/v1/routes/current");
        if (current.body?.availability === "available") { available = true; break; }
        await deps.sleep(300);
      }
      if (!available) throw new DeployError("RUNNER_OFFLINE", "The runner did not connect to Relay. The model was not left advertised.");
      const next = { schemaVersion: 1, deploymentId: spec.deploymentId, status: "ready", release: { modelId: release.id, releaseVersion: release.version, artifactSha256: release.artifact.sha256, profileChecksum: checksum }, port: spec.runtime.port, pids: { llama: llamaPid, runner: runnerPid }, llamaNeedle: release.artifact.sha256, runnerNeedle: spec.deploymentId, updatedAt: deps.now(), lastError: "" };
      await writeJson(located.state, next, 0o600);
      await writeJson(located.binding, { schemaVersion: 1, deploymentId: spec.deploymentId, executionHostId: spec.executionHost.id, loopback: `http://127.0.0.1:${spec.runtime.port}`, releaseFile: join(releaseRoot, spec.releaseRef.path), artifactCache: cacheDir, relayOrigin: new URL(relayUrl).origin, secretRefs: spec.secretRefs }, 0o600);
      await history(located.history, { at: deps.now(), action: input.force ? "restart" : "start", outcome: "ready", deploymentId: spec.deploymentId, artifactSha256: release.artifact.sha256, note: "Loopback runtime ready and runner connected." });
      await declareIntegration(input.voltPath, spec.deploymentId);
      return { ok: true, reused: false, deploymentId: spec.deploymentId, profileChecksum: checksum, status: "ready", record: located.record };
    } catch (error) {
      await stopPids(deps, { pids: { llama: llamaPid, runner: runnerPid }, llamaNeedle: release.artifact.sha256, runnerNeedle: spec.deploymentId }).catch(() => {});
      if (runnerToken) await relayCall(deps, relayUrl, serviceToken, input.accountId, input.environmentId, "/v1/revoke", { method: "POST", body: JSON.stringify({ deploymentId: spec.deploymentId }) }).catch(() => {});
      const wrapped = error instanceof DeployError ? error : new DeployError("START_FAILED", safeText(error.message));
      await writeJson(located.state, { schemaVersion: 1, deploymentId: spec.deploymentId, status: "failed", release: { modelId: spec.modelId, releaseVersion: spec.releaseVersion, artifactSha256: spec.artifactSha256, profileChecksum: checksum }, port: spec.runtime.port, pids: { llama: null, runner: null }, llamaNeedle: spec.artifactSha256, runnerNeedle: spec.deploymentId, updatedAt: deps.now(), lastError: safeText(wrapped.message) }, 0o600).catch(() => {});
      await history(located.history, { at: deps.now(), action: "start", outcome: "failed", deploymentId: spec.deploymentId, artifactSha256: spec.artifactSha256, note: safeText(wrapped.message) }).catch(() => {});
      throw wrapped;
    }
  });
}

export async function stopModel(input) {
  const deps = depsOf(input);
  await loadVolt(input.voltPath, input.principal || OPERATOR, "write");
  const deploymentId = input.deploymentId || "sentient-potato-local";
  const located = paths(input.voltPath, deploymentId);
  return withLock(located.lock, async () => {
    let state;
    try { state = await readJson(located.state); } catch { throw new DeployError("NOTHING_RUNNING", "No local deployment state exists. Nothing was stopped."); }
    await stopPids(deps, state);
    let relayUpdated = false;
    try {
      const record = await readJson(located.record);
      const relay = input.relay || requireRelay();
      const revoked = await relayCall(deps, relay.relayUrl, relay.token, record.ownership.accountId, record.ownership.environmentId, "/v1/revoke", { method: "POST", body: JSON.stringify({ deploymentId }) });
      relayUpdated = revoked.status === 200;
    } catch { relayUpdated = false; }
    state.status = "stopped";
    state.pids = { llama: null, runner: null };
    state.updatedAt = deps.now();
    state.lastError = relayUpdated ? "" : "Local processes were stopped. Relay could not be updated.";
    await writeJson(located.state, state, 0o600);
    await history(located.history, { at: deps.now(), action: "stop", outcome: relayUpdated ? "stopped" : "stopped-relay-pending", deploymentId, artifactSha256: state.release?.artifactSha256 || "", note: state.lastError || "Stopped." });
    return { ok: true, status: "stopped", relayUpdated };
  });
}

export async function restartModel(input) {
  const deploymentId = input.deploymentId || "sentient-potato-local";
  const record = JSON.parse(await readFile(join(input.voltPath, "models", "deployments", `${deploymentId}.record.json`), "utf8"));
  const accountId = input.accountId || record.ownership.accountId;
  const environmentId = input.environmentId || record.ownership.environmentId;
  const changingScope = accountId !== record.ownership.accountId || environmentId !== record.ownership.environmentId;
  if (changingScope && (!input.accountId || !input.environmentId)) throw new DeployError("OWNERSHIP_REQUIRED", "Changing restart scope requires both the account and environment from the signed-in Captain.");
  // Validate explicit ownership and write permission before stopping a healthy runtime.
  const definition = await loadVolt(input.voltPath, input.principal || OPERATOR, "write");
  await loadSpec(input.specPath || paths(input.voltPath).spec, definition, accountId, environmentId);
  await stopModel({ ...input, deploymentId });
  return deployModel({ ...input, accountId, environmentId, force: true });
}

export async function statusModel(input) {
  const deploymentId = input.deploymentId || "sentient-potato-local";
  const located = paths(input.voltPath, deploymentId);
  let state = null;
  let record = null;
  try { state = await readJson(located.state); } catch { state = null; }
  try { record = await readJson(located.record); } catch { record = null; }
  let relay = null;
  if (record && process.env.RELAY_SERVICE_TOKEN && process.env.RELAY_INFERENCE_URL) {
    try {
      const current = await relayCall(depsOf(input), process.env.RELAY_INFERENCE_URL, process.env.RELAY_SERVICE_TOKEN, record.ownership.accountId, record.ownership.environmentId, "/v1/routes/current");
      relay = current.status === 200 ? { availability: current.body.availability, reason: current.body.reason, profileChecksum: current.body.profileChecksum } : { availability: "unavailable", reason: current.body?.error?.code || "relay_error" };
    } catch { relay = { availability: "unavailable", reason: "relay_unreachable" }; }
  }
  return { ok: true, deploymentId, local: state ? { status: state.status, port: state.port, release: state.release, lastError: state.lastError } : null, relay };
}

export async function exportModel(input) {
  await loadVolt(input.voltPath, input.principal || OPERATOR, "share");
  const output = resolve(input.output);
  await mkdir(output, { recursive: true });
  const names = ["volt.json", "kraken.json", "models/README.md"];
  let deployments = [];
  try { deployments = await readdir(join(input.voltPath, "models", "deployments")); } catch { deployments = []; }
  const files = [...names, ...deployments.filter((name) => name.endsWith(".json")).map((name) => join("models", "deployments", name))];
  const tokenFile = tokenPath("sentient-potato-local");
  let secret = "";
  try { secret = (await readFile(tokenFile, "utf8")).trim(); } catch { secret = ""; }
  for (const relative of files) {
    const source = join(input.voltPath, relative);
    let text;
    try { text = await readFile(source, "utf8"); } catch { continue; }
    if (relative.startsWith("models/local")) throw new DeployError("EXPORT_BLOCKED", "Local runtime state cannot be exported.");
    if ((secret && text.includes(secret)) || /Bearer\s+\S+/.test(text) || text.includes("RELAY_SERVICE_TOKEN=")) {
      await rm(output, { recursive: true, force: true });
      throw new DeployError("EXPORT_BLOCKED", "Export stopped because a credential would have been copied. Remove it from the shareable deployment files.");
    }
    const destination = join(output, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, text);
  }
  return { ok: true, output, omitted: ["models/local", "weights", "runner credentials"] };
}
