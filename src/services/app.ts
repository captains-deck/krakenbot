import type { Principal } from "@wormvolt/core";
import { createHost, localOperator, type Host } from "./host.js";
import { createVolt } from "./provision.js";
import { inspectVolt, listVolts, validateVolt } from "./vaults.js";
import { addPrompt, revisePrompt } from "./prompts.js";
import { attachContext, defineAgent, listAgents } from "./agents.js";
import { exportContext } from "./context.js";
import type {
  AgentResult,
  CreateVoltInput,
  ExportResult,
  Inspection,
  PromptResult,
  ProvisionResult,
  ValidationReport,
  VaultSummary,
  AgentView,
} from "./types.js";

export interface KrakenApp {
  listVolts(): Promise<VaultSummary[]>;
  createVolt(input: CreateVoltInput): Promise<ProvisionResult>;
  inspectVolt(ref: string): Promise<Inspection>;
  validateVolt(ref: string): Promise<ValidationReport>;
  addPrompt(input: {
    volt: string;
    name: string;
    file: string;
  }): Promise<PromptResult>;
  revisePrompt(input: {
    volt: string;
    promptId: string;
    file: string;
    message: string;
  }): Promise<PromptResult>;
  defineAgent(input: {
    agentId: string;
    volt: string;
    instructions: string;
  }): Promise<AgentResult>;
  attachContext(input: {
    agentId: string;
    context: string;
    include: string;
    access: string;
  }): Promise<AgentResult>;
  listAgents(): Promise<AgentView[]>;
  exportContext(input: {
    agentId: string;
    output: string;
  }): Promise<ExportResult>;
}

export function createKrakenApp(
  options: {
    cwd?: string;
    registryPath?: string;
    principal?: Principal;
    now?: () => string;
  } = {},
): KrakenApp {
  const host: Host = createHost(options);
  return {
    listVolts: () => listVolts(host),
    createVolt: (input) => createVolt(host, input),
    inspectVolt: (ref) => inspectVolt(host, ref),
    validateVolt: (ref) => validateVolt(host, ref),
    addPrompt: (input) => addPrompt(host, input),
    revisePrompt: (input) => revisePrompt(host, input),
    defineAgent: (input) => defineAgent(host, input),
    attachContext: (input) => attachContext(host, input),
    listAgents: () => listAgents(host),
    exportContext: (input) => exportContext(host, input),
  };
}

export { localOperator };
