import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KrakenError } from "../errors.js";

export function demoPipelineCli(): string {
  const configured = process.env.AICAPTAIN_DEMO_PIPELINE;
  if (configured && existsSync(configured)) return configured;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(
      directory,
      "aicaptain-digital-hub/demo-pipelines/cli.mjs",
    );
    if (existsSync(candidate)) return candidate;
    directory = resolve(directory, "..");
  }
  throw new KrakenError(
    "USAGE",
    "The demo pipeline is not in this workspace. Set AICAPTAIN_DEMO_PIPELINE to demo-pipelines/cli.mjs.",
  );
}

export function runDemoCli(args: string[]): string {
  const result = spawnSync(process.execPath, [demoPipelineCli(), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw new KrakenError("USAGE", result.error.message);
  if (result.status !== 0) {
    throw new KrakenError(
      "USAGE",
      (result.stderr || result.stdout || "The demo command failed.").trim(),
    );
  }
  return result.stdout;
}
