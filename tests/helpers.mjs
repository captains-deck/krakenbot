import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKrakenApp } from "../dist/index.js";

export const cli = fileURLToPath(
  new URL("../dist/cli/main.js", import.meta.url),
);

export async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "krakenbot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function appAt(root) {
  return createKrakenApp({
    cwd: root,
    registryPath: join(root, "registry.json"),
  });
}

export function registryPath(root) {
  return join(root, "registry.json");
}

export function run(root, args, input) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, "--registry", registryPath(root), ...args],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(input ?? "");
  });
}

export async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}
