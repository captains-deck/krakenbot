import type { VoltDefinition } from "@wormvolt/core";
import type {
  AgentDefinition,
  ContextAccess,
  KrakenManifest,
  Profile,
  PromptManifest,
} from "../domain/manifest.js";

export interface CreateVoltInput {
  id: string;
  profile: string;
  path: string;
  purpose: string | null;
  workdir: string | null;
  dryRun: boolean;
}

export interface ProvisionResult {
  status: "created" | "unchanged" | "dry-run";
  id: string;
  profile: Profile;
  purpose: string;
  vaultRoot: string;
  workingDirectory: string;
  created: string[];
  preserved: string[];
  next: string;
}

export interface VaultSummary {
  id: string;
  profile: Profile;
  purpose: string;
  vaultRoot: string;
  workingDirectory: string;
  available: boolean;
  registered: boolean;
}

export interface Inspection {
  id: string;
  profile: Profile;
  purpose: string;
  name: string;
  vaultRoot: string;
  workingDirectory: string;
  registered: boolean;
  complete: boolean;
  schemaVersion: 1;
  profileTemplate: string;
  provisioningVersion: string;
  createdAt: string;
  updatedAt: string;
  contextEntryPoints: string[];
  autonomy: KrakenManifest["autonomy"];
  policy: VoltDefinition["policy"];
  securityGroups: string[];
  audience: VoltDefinition["audience"];
  connections: string[];
  integrations: KrakenManifest["integrations"];
  agents: AgentView[];
  prompts: PromptView[];
  next: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  id: string;
  vaultRoot: string;
  issues: ValidationIssue[];
}

export interface PromptView {
  id: string;
  currentRevision: string;
  revisions: {
    id: string;
    message: string;
    sha256: string;
    createdAt: string;
  }[];
}

export interface PromptResult {
  status: "created" | "revised" | "unchanged";
  vaultId: string;
  promptId: string;
  revision: string;
  message: string;
  sha256: string;
  revisions: PromptView["revisions"];
}

export interface AgentView {
  id: string;
  name: string;
  voltId: string;
  status: "defined";
  adapter: "manual-handoff";
  instructionsPath: string;
  instructionsSha256: string;
  attachments: {
    contextVoltId: string;
    include: string;
    access: ContextAccess;
  }[];
}

export interface AgentResult {
  status: "defined" | "unchanged" | "attached";
  agent: AgentView;
}

export interface ExportFileReceipt {
  vaultId: string;
  path: string;
  sha256: string;
  revision: string | null;
  access: ContextAccess;
}

export interface ExportResult {
  ok: true;
  agentId: string;
  voltId: string;
  output: string;
  adapter: "manual-handoff";
  launched: false;
  enforcementAfterHandoff: false;
  warning: string;
  files: ExportFileReceipt[];
}

export interface LoadedVault {
  registered: boolean;
  vaultRoot: string;
  workingDirectory: string;
  manifest: KrakenManifest;
  definition: VoltDefinition;
  complete: boolean;
}

export function agentView(agent: AgentDefinition): AgentView {
  return {
    id: agent.id,
    name: agent.name,
    voltId: agent.voltId,
    status: "defined",
    adapter: "manual-handoff",
    instructionsPath: agent.instructionsPath,
    instructionsSha256: agent.instructionsSha256,
    attachments: agent.attachments.map((attachment) => ({
      contextVoltId: attachment.contextVoltId,
      include: attachment.include,
      access: attachment.access,
    })),
  };
}

export function promptView(prompt: PromptManifest): PromptView {
  return {
    id: prompt.id,
    currentRevision: prompt.currentRevision,
    revisions: prompt.revisions.map((revision) => ({
      id: revision.id,
      message: revision.message,
      sha256: revision.sha256,
      createdAt: revision.createdAt,
    })),
  };
}
