/** Contract for a future enrolled execution host. This module does not open a connection or a shell. */

const OPERATIONS = new Set(["verify-artifact", "start-runtime", "stop-runtime"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;

function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function validateRemoteJob(job) {
  if (!object(job)) return "Job must be a JSON object.";
  const allowed = ["schemaVersion", "jobId", "deploymentId", "executionHostId", "operation", "releaseRef"];
  if (Object.keys(job).some((key) => !allowed.includes(key))) return "Job contains an unsupported field. Shell commands are not part of this contract.";
  if (job.schemaVersion !== 1 || !UUID.test(job.jobId || "") || !SLUG.test(job.deploymentId || "") || typeof job.executionHostId !== "string" || !job.executionHostId) return "Job identity is invalid.";
  if (!OPERATIONS.has(job.operation)) return "Operation must be verify-artifact, start-runtime or stop-runtime.";
  if (!object(job.releaseRef) || !SLUG.test(job.releaseRef.modelId || "") || typeof job.releaseRef.releaseVersion !== "string" || !SHA.test(job.releaseRef.artifactSha256 || "")) return "Job release reference is invalid.";
  return "";
}

export function submitRemoteJob(job) {
  const problem = validateRemoteJob(job);
  if (problem) return { schemaVersion: 1, status: "rejected", code: "invalid_job", message: problem, executed: false };
  return {
    schemaVersion: 1,
    status: "unimplemented",
    code: "REMOTE_AGENT_UNAVAILABLE",
    jobId: job.jobId,
    executed: false,
    message: "Remote development-agent execution is specified but not implemented. No job was sent, no artifact was fetched, and no shell was started.",
    progress: [],
    artifacts: [],
  };
}
