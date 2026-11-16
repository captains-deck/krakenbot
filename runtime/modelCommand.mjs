import { resolve } from "node:path";
import { DeployError, deployModel, exportModel, restartModel, statusModel, stopModel, validateModel } from "./modelDeploy.mjs";

export const MODEL_HELP = `kraken model

  deploy <volt> --account <id> --environment <id> [--spec <file>] [--release-root <path>] [--llama-server <path>] [--cache <path>]
      Resolve the pinned release, verify local weights, start it on loopback and enroll the runner with Relay.
  status <volt> [--deployment <id>]
      Show local state and Relay availability. This does not print credentials.
  stop <volt> [--deployment <id>]
      Stop the recorded local processes and revoke the runner credential.
  restart <volt> [--deployment <id>]
      Stop and start the same recorded account and environment. A different account is refused.
  validate <volt> [--spec <file>] [--release-root <path>]
      Check volt.json, the deployment specification and the canonical release. Nothing is started.
  export <volt> --output <directory>
      Copy shareable deployment metadata. models/local, weights and credentials are omitted.

Set RELAY_INFERENCE_URL and RELAY_SERVICE_TOKEN in the environment before deploy, restart or a live status.
Do not pass the service token as a flag. Repeat deploy reuses a healthy runtime instead of starting a second one.
`;

function flag(flags, name) {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : "";
}

export async function runModelCommand({ action, rest, flags, cwd }) {
  try {
    if (!action || action === "help") return { ok: true, body: { help: true }, text: MODEL_HELP };
    const voltPath = resolve(cwd, rest[0] || flag(flags, "volt"));
    if (!rest[0] && !flag(flags, "volt")) return { ok: false, body: { ok: false, code: "USAGE" }, text: MODEL_HELP };
    const deploymentId = flag(flags, "deployment") || "sentient-potato-local";
    const common = {
      voltPath,
      deploymentId,
      specPath: flag(flags, "spec") ? resolve(cwd, flag(flags, "spec")) : undefined,
      releaseRoot: flag(flags, "release-root") ? resolve(cwd, flag(flags, "release-root")) : undefined,
      llamaServer: flag(flags, "llama-server") || undefined,
      cacheDir: flag(flags, "cache") ? resolve(cwd, flag(flags, "cache")) : undefined,
      accountId: flag(flags, "account"),
      environmentId: flag(flags, "environment"),
    };
    if (action === "validate") {
      const result = await validateModel(common);
      return { ok: true, body: result, text: `Valid ${result.deploymentId}. Profile ${result.profileChecksum.slice(0, 12)}. Weights ${result.artifactPresent ? "present" : "absent"}. Local execution ${result.implemented ? "implemented" : "not implemented for this mode"}.\n` };
    }
    if (action === "deploy") {
      const result = await deployModel(common);
      return { ok: true, body: result, text: result.reused ? `Reused ${result.deploymentId}. No second runtime was started.\n` : `Deployed ${result.deploymentId}. Profile ${result.profileChecksum}.\n` };
    }
    if (action === "status") {
      const result = await statusModel(common);
      const local = result.local ? result.local.status : "absent";
      const relay = result.relay ? `${result.relay.availability}${result.relay.reason ? ` (${result.relay.reason})` : ""}` : "not checked";
      return { ok: true, body: result, text: `${deploymentId}: local ${local}; Relay ${relay}.\n` };
    }
    if (action === "stop") {
      const result = await stopModel(common);
      return { ok: true, body: result, text: result.relayUpdated ? `Stopped ${deploymentId} and revoked its runner.\n` : `Stopped ${deploymentId} locally. Relay could not be updated.\n` };
    }
    if (action === "restart") {
      const result = await restartModel(common);
      return { ok: true, body: result, text: `Restarted ${result.deploymentId}.\n` };
    }
    if (action === "export") {
      if (!flag(flags, "output")) throw new DeployError("USAGE", "export needs --output <directory>.");
      const result = await exportModel({ ...common, output: resolve(cwd, flag(flags, "output")) });
      return { ok: true, body: result, text: `Exported shareable metadata to ${result.output}. Local state and credentials were omitted.\n` };
    }
    return { ok: false, body: { ok: false, code: "USAGE" }, text: MODEL_HELP };
  } catch (error) {
    const code = error instanceof DeployError ? error.code : "DEPLOYMENT_FAILED";
    const message = error instanceof Error ? error.message : "The model command failed.";
    return { ok: false, body: { ok: false, code, message }, text: `${code}: ${message}\n` };
  }
}
