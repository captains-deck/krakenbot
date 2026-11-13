import type { ContextAccess } from "../domain/manifest.js";

/**
 * Provider execution is not part of this milestone.
 * A later adapter can add an execute operation beside this handoff renderer.
 * This module only formats files that the application service has already selected.
 */
export const manualHandoffAdapter = "manual-handoff" as const;

export const HANDOFF_BOUNDARY =
  "Exported instructions do not enforce restrictions on an external assistant after handoff. WormVolt policy is applied only while KrakenBot selects the files. After the bundle is written, this program does not control the assistant.";

export interface HandoffFile {
  vaultId: string;
  relativePath: string;
  access: ContextAccess;
  sha256: string;
  revision: string | null;
  revisionMessage: string | null;
  text: string;
}

export interface HandoffMaterial {
  agentId: string;
  voltId: string;
  instructionsPath: string;
  instructionsSha256: string;
  instructions: string;
  attachments: {
    contextVoltId: string;
    include: string;
    access: ContextAccess;
  }[];
  files: HandoffFile[];
}

export function renderHandoff(material: HandoffMaterial): string {
  const lines = [
    "# KrakenBot context handoff",
    "",
    `Agent: ${material.agentId}`,
    `Agent vault: ${material.voltId}`,
    "Status: defined",
    `Adapter: ${manualHandoffAdapter}`,
    "Launched: no",
    "",
    "This bundle is a manual handoff. KrakenBot did not call a model provider and did not launch an agent.",
    "",
    HANDOFF_BOUNDARY,
    "",
    "## Instructions",
    "",
    `Source: ${material.voltId}:${material.instructionsPath}`,
    `SHA-256: ${material.instructionsSha256}`,
    "",
    material.instructions.trimEnd(),
    "",
    "## Selected context",
    "",
  ];
  if (material.files.length === 0) {
    lines.push("No files matched the attached include patterns.", "");
  }
  for (const file of material.files) {
    lines.push(
      `### ${file.vaultId}: ${file.relativePath}`,
      "",
      `- Access: ${file.access}`,
      `- SHA-256: ${file.sha256}`,
      `- Revision: ${file.revision ?? "none"}`,
    );
    if (file.revisionMessage)
      lines.push(`- Change description: ${file.revisionMessage}`);
    lines.push("", file.text.trimEnd(), "");
  }
  lines.push("## Selection receipt", "");
  if (material.attachments.length === 0) {
    lines.push("- Attachments: none", "");
  }
  for (const attachment of material.attachments) {
    lines.push(
      `- ${attachment.contextVoltId} \`${attachment.include}\` (${attachment.access})`,
    );
  }
  lines.push(
    "",
    `Included files: ${material.files.length}`,
    "Files that did not match an include pattern were not read into this bundle.",
    "",
  );
  return `${lines.join("\n")}\n`;
}
