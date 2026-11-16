import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchModel } from "../../CaptainsDeck/worker/modelPoc.mjs";
import { profileChecksum } from "../../Relay/cloudflare/relay-inference/contract.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const volt = join(root, "examples", "sentient-potato-volt");
const releaseFile = join(root, "..", "model-manifest", "releases", "sentient-potato", "0.1.0-rc.1", "release.json");
const relayDir = join(root, "..", "Relay", "cloudflare", "relay-inference");
const accountId = process.env.SMOKE_ACCOUNT || "local-captain";
const environmentId = process.env.SMOKE_ENVIRONMENT || "local-harbour";
const port = Number(process.env.PORT || 8788);
const phase = process.argv[2] || "up";

function listen(child) {
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { logs += chunk; process.stderr.write(chunk); });
  return () => logs;
}

function kraken(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli/main.js", "model", ...args], { cwd: root, env: { ...process.env, ...env } });
    const logs = listen(child);
    child.on("exit", (code) => (code === 0 ? resolve(logs()) : reject(new Error(`kraken model ${args[0]} exited ${code}\n${logs()}`))));
  });
}

async function portFree(target) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(target, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function ask(env, text, key = crypto.randomUUID()) {
  const scope = { accountId, environmentId, environmentName: "Local harbour" };
  const posted = await dispatchModel(new Request("http://127.0.0.1/api/model-poc/questions", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ text }),
  }), env, scope);
  const created = await posted.json();
  if (posted.status !== 201 && posted.status !== 200) return { status: posted.status, created };
  const deadline = Date.now() + 70000;
  let latest = created;
  while (Date.now() < deadline && !["completed", "failed", "expired"].includes(latest.status)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const read = await dispatchModel(new Request(`http://127.0.0.1/api/model-poc/questions/${created.requestId}`), env, scope);
    latest = await read.json();
  }
  return { status: posted.status, created, latest };
}

async function startRelay(env) {
  if (!await portFree(port)) throw new Error(`127.0.0.1:${port} is already in use.`);
  const child = spawn(process.execPath, ["server.mjs"], { cwd: relayDir, env: { ...process.env, ...env, PORT: String(port) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  listen(child);
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return child.pid;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relay did not start.");
}

const token = process.env.RELAY_SERVICE_TOKEN || randomBytes(32).toString("hex");
const store = process.env.RELAY_STORE || join(homedir(), ".config", "aicaptain", "relay-inference", "smoke-state.json");
const env = { RELAY_SERVICE_TOKEN: token, RELAY_INFERENCE_URL: `http://127.0.0.1:${port}`, RELAY_STORE: store };
await mkdir(dirname(store), { recursive: true, mode: 0o700 });

if (phase === "up" || phase === "all") {
  const relayPid = await startRelay(env);
  await writeFile(join(homedir(), ".config", "aicaptain", "relay-inference", "smoke-token"), `${token}\n`, { mode: 0o600 });
  await kraken(["validate", volt], env);
  await kraken(["deploy", volt, "--account", accountId, "--environment", environmentId], env);
  const release = JSON.parse(await readFile(releaseFile, "utf8"));
  const expected = await profileChecksum(release);
  const key = crypto.randomUUID();
  const result = await ask(env, "What is your name?", key);
  const scope = { accountId, environmentId, environmentName: "Local harbour" };
  const replay = await dispatchModel(new Request("http://127.0.0.1/api/model-poc/questions", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ text: "What is your name?" }),
  }), env, scope);
  const replayBody = await replay.json();
  const changed = await dispatchModel(new Request("http://127.0.0.1/api/model-poc/questions", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1", "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ text: "A different question" }),
  }), env, scope);
  await changed.json();
  const malformed = await fetch(`http://127.0.0.1:${port}/v1/inference/requests`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Aicaptain-Account": accountId, "X-Aicaptain-Environment": environmentId }, body: "{" });
  await malformed.text();
  const evidence = {
    relayPid,
    requestId: result.latest?.requestId,
    traceId: result.latest?.traceId,
    status: result.latest?.status,
    profileChecksum: result.latest?.profileChecksum,
    expectedProfileChecksum: expected,
    profileMatches: result.latest?.profileChecksum === expected,
    answer: result.latest?.output?.text || "",
    replayStatus: replay.status,
    replaySameRequest: replayBody.requestId === result.latest?.requestId,
    changedKeyStatus: changed.status,
    malformedStatus: malformed.status,
  };
  await writeFile(join(volt, "models", "local", "smoke-evidence.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...evidence, answer: evidence.answer.slice(0, 240) }));
  if (result.latest?.status !== "completed" || !evidence.profileMatches) process.exitCode = 1;
}

if (phase === "down" || phase === "all") {
  if (!process.env.RELAY_SERVICE_TOKEN) {
    env.RELAY_SERVICE_TOKEN = (await readFile(join(homedir(), ".config", "aicaptain", "relay-inference", "smoke-token"), "utf8")).trim();
    env.RELAY_INFERENCE_URL = `http://127.0.0.1:${port}`;
  }
  await kraken(["stop", volt], env);
  const stopped = await kraken(["status", volt], env);
  console.log(stopped);
  await kraken(["restart", volt], env);
  const count = await new Promise((resolve) => {
    const child = spawn("ps", ["-ax", "-o", "command="]);
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.on("exit", () => resolve(text.split("\n").filter((line) => line.includes("llama-server") && line.includes("889ea3b9143cdc32146c7d530ce5f3d452ec18069086f6f4167ce9ae72a9691f")).length));
  });
  const exported = join(tmpdir(), "sentient-potato-smoke-export");
  await kraken(["export", volt, "--output", exported], env);
  const exportedText = await readFile(join(exported, "models", "deployments", "sentient-potato.record.json"), "utf8");
  console.log(JSON.stringify({ llamaProcesses: count, exportContainsToken: exportedText.includes(env.RELAY_SERVICE_TOKEN), exportContainsRunnerSecret: exportedText.includes("secret://") }));
  if (count !== 1) process.exitCode = 1;
}
