const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_ID = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/;
const SHA = /^[a-f0-9]{64}$/;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/;

function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unexpected(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function relative(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 256 && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function validateDesired(spec) {
  if (!object(spec)) return "Deployment specification must be a JSON object.";
  const allowed = ["schemaVersion", "deploymentId", "modelId", "releaseVersion", "artifactSha256", "releaseRef", "executionHost", "hostingMode", "management", "portal", "arrangement", "runtime", "relay", "limits", "health", "lifecycle", "secretRefs", "ownership"];
  if (unexpected(spec, allowed).length) return `Unknown deployment field: ${unexpected(spec, allowed).join(", ")}.`;
  if (spec.schemaVersion !== 1) return "Deployment schemaVersion must be 1.";
  if (!SLUG.test(spec.deploymentId || "") || !MODEL_ID.test(spec.modelId || "") || !VERSION_ID.test(spec.releaseVersion || "") || !SHA.test(spec.artifactSha256 || "")) return "Deployment identity or artifact checksum is invalid.";
  if (!object(spec.releaseRef) || spec.releaseRef.source !== "model-manifest" || !relative(spec.releaseRef.path) || unexpected(spec.releaseRef, ["source", "path"]).length) return "releaseRef must point at a model-manifest release file.";
  if (!object(spec.executionHost) || !OWNER.test(spec.executionHost.id || "") || !["local-machine", "remote-agent"].includes(spec.executionHost.kind)) return "executionHost must be a local machine or a remote agent.";
  if (!["local-execution", "aicaptain-cloud", "provider-cloud"].includes(spec.hostingMode)) return "Unknown hostingMode.";
  if (!["captain-managed", "aicaptain-managed", "provider-managed"].includes(spec.management)) return "Unknown management responsibility.";
  if (!["hosted-captains-deck", "self-hosted-portal"].includes(spec.portal)) return "Unknown portal.";
  if (!["hybrid", "self-hosted", "aicaptain-cloud", "managed-business", "managed-generic"].includes(spec.arrangement)) return "Unknown arrangement.";
  if (!object(spec.runtime) || spec.runtime.engine !== "llama.cpp" || spec.runtime.bind !== "127.0.0.1" || !Number.isInteger(spec.runtime.port) || spec.runtime.port < 1024 || spec.runtime.port > 65535) return "Runtime must be llama.cpp bound to loopback on an unprivileged port.";
  if (!object(spec.relay) || spec.relay.contract !== "relay-inference/1") return "Relay contract must be relay-inference/1.";
  if (!object(spec.limits) || spec.limits.maxInputCharacters !== 1000 || spec.limits.deadlineSeconds !== 60 || spec.limits.maxInFlight !== 1) return "V0 limits are 1000 characters, a 60 second deadline and one request in flight.";
  if (!object(spec.health) || !Number.isInteger(spec.health.readyTimeoutSeconds) || spec.health.readyTimeoutSeconds < 5 || spec.health.readyTimeoutSeconds > 300) return "Health readyTimeoutSeconds must be between 5 and 300.";
  if (!object(spec.lifecycle) || typeof spec.lifecycle.reuseRunningProcess !== "boolean" || spec.lifecycle.stopSignal !== "SIGTERM") return "Lifecycle must say whether to reuse a running process and must stop with SIGTERM.";
  if (!object(spec.secretRefs) || spec.secretRefs.runnerCredential !== `secret://aicaptain/kraken-runners/${spec.deploymentId}` || spec.secretRefs.relayServiceCredential !== "env:RELAY_SERVICE_TOKEN") return "Secret references must stay references. Do not paste credential values.";
  if (!object(spec.ownership) || spec.ownership.voltId !== undefined && !SLUG.test(spec.ownership.voltId || "")) return "ownership.voltId must be a slug when it is set.";
  for (const field of ["accountId", "environmentId"]) {
    if (spec.ownership?.[field] !== undefined && !OWNER.test(spec.ownership[field])) return `ownership.${field} is invalid.`;
  }
  return "";
}

export function executableLocally(spec) {
  return spec.hostingMode === "local-execution" && spec.management === "captain-managed" && (spec.arrangement === "hybrid" || spec.arrangement === "self-hosted") && spec.executionHost.kind === "local-machine";
}
