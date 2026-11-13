import { KrakenError } from "./errors.js";
import type {
  AgentResult,
  ExportResult,
  Inspection,
  PromptResult,
  ProvisionResult,
  ValidationReport,
  VaultSummary,
} from "./services/types.js";

export function formatProvision(result: ProvisionResult): string {
  const creating = result.status === "dry-run" ? "Would create" : "Created";
  const preserving =
    result.status === "dry-run" ? "Would preserve" : "Preserved";
  const lines = [
    `${result.status} ${result.id} (${result.profile})`,
    `Vault: ${result.vaultRoot}`,
    `Working directory: ${result.workingDirectory}`,
    `Purpose: ${result.purpose}`,
    `${creating}:`,
    ...bullets(result.created),
    `${preserving}:`,
    ...bullets(result.preserved),
  ];
  if (result.status === "dry-run") {
    lines.push("No files were written. The registry was not changed.");
  }
  lines.push(`Next: ${result.next}`);
  return `${lines.join("\n")}\n`;
}

export function formatVaultList(vaults: VaultSummary[]): string {
  if (vaults.length === 0) {
    return 'No vaults are registered.\nCreate one with: kraken volt create <id> --profile basic --path <path> --purpose "<purpose>"\n';
  }
  return `${vaults
    .map(
      (vault) =>
        `${vault.id}\t${vault.profile}\t${vault.available ? "available" : "missing"}\t${vault.vaultRoot}`,
    )
    .join("\n")}\n`;
}

export function formatInspection(inspection: Inspection): string {
  const lines = [
    `${inspection.id} (${inspection.profile})`,
    `Name: ${inspection.name}`,
    `Purpose: ${inspection.purpose}`,
    `Vault: ${inspection.vaultRoot}`,
    `Working directory: ${inspection.workingDirectory}`,
    `Registered: ${inspection.registered ? "yes" : "no"}`,
    `Provisioning: ${inspection.complete ? "complete" : "incomplete"}`,
    `WormVolt schema: ${inspection.schemaVersion}`,
    `Template: ${inspection.profileTemplate} @ ${inspection.provisioningVersion}`,
    `Created: ${inspection.createdAt}`,
    `Updated: ${inspection.updatedAt}`,
    `Audience: ${inspection.audience}`,
    `Autonomy: ${inspection.autonomy.mode} [${inspection.autonomy.actions.join(", ")}]`,
    `Security groups: ${inspection.securityGroups.join(", ") || "(none)"}`,
    `Connections: ${inspection.connections.join(", ") || "(none)"}`,
    "Policy:",
    ...Object.entries(inspection.policy).map(
      ([action, groups]) => `  ${action}: ${groups.join(", ") || "(none)"}`,
    ),
    "Context entry points:",
    ...bullets([...inspection.contextEntryPoints]),
    `Integrations: ${
      inspection.integrations.length === 0
        ? "(none declared; none are executed)"
        : inspection.integrations
            .map((item) => `${item.id} ${item.kind} ${item.status}`)
            .join(", ")
    }`,
    "Agents:",
    ...(inspection.agents.length === 0
      ? ["- (none)"]
      : inspection.agents.map(
          (agent) =>
            `- ${agent.id} status=${agent.status} adapter=${agent.adapter} attachments=${agent.attachments.length}`,
        )),
    "Prompts:",
    ...(inspection.prompts.length === 0
      ? ["- (none)"]
      : inspection.prompts.map(
          (prompt) =>
            `- ${prompt.id} current=${prompt.currentRevision} revisions=${prompt.revisions.length}`,
        )),
    `Next: ${inspection.next}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatValidation(report: ValidationReport): string {
  if (report.ok) return `valid ${report.id}\n${report.vaultRoot}\n`;
  return `invalid ${report.id}\n${report.issues
    .map((issue) => `- ${issue.code}: ${issue.message}`)
    .join("\n")}\n`;
}

export function formatPrompt(result: PromptResult): string {
  const history = result.revisions
    .map((revision) => `- ${revision.id}: ${revision.message}`)
    .join("\n");
  return `${result.status} ${result.vaultId} ${result.promptId} ${result.revision}\n${history}\n`;
}

export function formatAgent(result: AgentResult): string {
  const attachments =
    result.agent.attachments.length === 0
      ? "- (no context attached)"
      : result.agent.attachments
          .map(
            (attachment) =>
              `- ${attachment.contextVoltId} ${attachment.include} (${attachment.access})`,
          )
          .join("\n");
  return [
    `${result.status} ${result.agent.id}`,
    "Status: defined",
    "Launched: no",
    `Adapter: ${result.agent.adapter}`,
    `Vault: ${result.agent.voltId}`,
    `Instructions: ${result.agent.instructionsPath}`,
    "Context:",
    attachments,
    "",
  ].join("\n");
}

export function formatExport(result: ExportResult): string {
  const files =
    result.files.length === 0
      ? "- (no context files selected)"
      : result.files
          .map(
            (file) =>
              `- ${file.vaultId}:${file.path} ${file.sha256} revision=${file.revision ?? "none"} access=${file.access}`,
          )
          .join("\n");
  return [
    `exported ${result.agentId}`,
    `Output: ${result.output}`,
    "Launched: no",
    `Adapter: ${result.adapter}`,
    result.warning,
    "Files:",
    files,
    "",
  ].join("\n");
}

export function formatThrown(error: unknown): string {
  if (error instanceof KrakenError)
    return `error: ${error.code}\n${error.message}`;
  if (error instanceof Error) return `error: INTERNAL\n${error.message}`;
  return "error: INTERNAL\nThe command failed.";
}

function bullets(items: readonly string[]): string[] {
  if (items.length === 0) return ["- (none)"];
  return items.map((item) => `- ${item}`);
}
