import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { KrakenError } from "../errors.js";
import {
  parseAgentDefinition,
  type AgentDefinition,
  type ContextAccess,
} from "../domain/manifest.js";
import { assertExplicitInclude } from "../domain/glob.js";
import { parseVaultId } from "../domain/profiles.js";
import {
  canonicalPath,
  createIfAbsent,
  insideVault,
  jsonText,
  pathKind,
  readJson,
  readUserText,
  sha256,
  writeAtomic,
} from "../storage/fs.js";
import type { Host } from "./host.js";
import { assertVaultPermission } from "./permissions.js";
import { listVolts, resolveVault, touchManifest } from "./vaults.js";
import { agentView, type AgentResult, type AgentView } from "./types.js";

const INSTRUCTION_LIMIT = 256 * 1024;

export async function listAgentsInVault(
  vaultRoot: string,
): Promise<AgentView[]> {
  const root = join(vaultRoot, "agent-definitions");
  if ((await pathKind(root)) !== "directory") return [];
  const entries = await readdir(root, { withFileTypes: true });
  const agents: AgentView[] = [];
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !entry.name.endsWith(".json")
    )
      continue;
    agents.push(
      agentView(parseAgentDefinition(await readJson(join(root, entry.name)))),
    );
  }
  agents.sort((left, right) => left.id.localeCompare(right.id));
  return agents;
}

export async function listAgents(host: Host): Promise<AgentView[]> {
  const vaults = await listVolts(host);
  const agents: AgentView[] = [];
  for (const vault of vaults) {
    if (vault.profile !== "agent" || !vault.available) continue;
    agents.push(...(await listAgentsInVault(vault.vaultRoot)));
  }
  return agents;
}

export async function defineAgent(
  host: Host,
  input: { agentId: string; volt: string; instructions: string },
): Promise<AgentResult> {
  const loaded = await requireAgentVolt(host, input.volt);
  const agentId = parseVaultId(input.agentId, "Agent name");
  const text = await readInstructions(input.instructions, host.cwd);
  const hash = sha256(text);
  const definitionPath = insideVault(
    loaded.vaultRoot,
    `agent-definitions/${agentId}.json`,
  );
  const instructionsPath = `instructions/${agentId}.md`;
  const instructionsFull = insideVault(loaded.vaultRoot, instructionsPath);
  if ((await pathKind(definitionPath)) === "file") {
    const existing = parseAgentDefinition(await readJson(definitionPath));
    if (
      existing.instructionsSha256 === hash &&
      existing.voltId === loaded.manifest.id
    ) {
      return { status: "unchanged", agent: agentView(existing) };
    }
    throw new KrakenError(
      "AGENT_ALREADY_DEFINED",
      `Agent ${agentId} is already defined in ${loaded.manifest.id}. The existing definition was kept. Defining an agent does not launch it.`,
    );
  }
  const instructionKind = await pathKind(instructionsFull);
  if (instructionKind === "file") {
    const existing = await readUserText(
      instructionsFull,
      "Instructions",
      INSTRUCTION_LIMIT,
    );
    if (sha256(existing) !== hash) {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${instructionsPath} already exists with different content. KrakenBot did not overwrite it or write a definition.`,
      );
    }
  } else if (instructionKind !== "missing") {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${instructionsPath} is not a file. Move it aside before defining ${agentId}.`,
    );
  } else {
    await createIfAbsent(instructionsFull, text);
  }
  const now = host.now();
  const agent = parseAgentDefinition({
    schemaVersion: 1,
    id: agentId,
    name: agentId,
    voltId: loaded.manifest.id,
    status: "defined",
    adapter: "manual-handoff",
    instructionsPath,
    instructionsSha256: hash,
    attachments: [],
    createdAt: now,
    updatedAt: now,
  });
  const created = await createIfAbsent(definitionPath, jsonText(agent));
  if (created === "preserved") {
    const existing = parseAgentDefinition(await readJson(definitionPath));
    if (existing.instructionsSha256 !== hash) {
      throw new KrakenError(
        "AGENT_ALREADY_DEFINED",
        `Agent ${agentId} was defined while this command ran. Inspect it before trying again.`,
      );
    }
    return { status: "unchanged", agent: agentView(existing) };
  }
  await touchManifest(host, loaded.manifest);
  return { status: "defined", agent: agentView(agent) };
}

export async function attachContext(
  host: Host,
  input: { agentId: string; context: string; include: string; access: string },
): Promise<AgentResult> {
  const agentId = parseVaultId(input.agentId, "Agent name");
  assertExplicitInclude(input.include);
  const access = parseAccess(input.access);
  const found = await findAgent(host, agentId);
  const contextVault = await resolveVault(host, input.context);
  if (!contextVault.complete) {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${contextVault.vaultRoot} is not a completed vault, so it cannot be attached.`,
    );
  }
  assertVaultPermission(
    contextVault.definition,
    host.principal,
    "read",
    contextVault.manifest.id,
  );
  assertVaultPermission(
    contextVault.definition,
    host.principal,
    "share",
    contextVault.manifest.id,
  );
  if (access === "read-write") {
    assertVaultPermission(
      contextVault.definition,
      host.principal,
      "write",
      contextVault.manifest.id,
    );
  }
  const duplicate = found.agent.attachments.find(
    (attachment) =>
      attachment.contextVoltId === contextVault.manifest.id &&
      attachment.include === input.include,
  );
  if (duplicate) {
    if (duplicate.access === access)
      return { status: "unchanged", agent: agentView(found.agent) };
    throw new KrakenError(
      "CONFLICTING_ATTACHMENT",
      `${agentId} already includes ${input.include} from ${contextVault.manifest.id} with access ${duplicate.access}. The attachment was kept.`,
    );
  }
  const next: AgentDefinition = parseAgentDefinition({
    ...found.agent,
    updatedAt: host.now(),
    attachments: [
      ...found.agent.attachments,
      {
        contextVoltId: contextVault.manifest.id,
        include: input.include,
        access,
      },
    ],
  });
  await writeAtomic(found.path, jsonText(next));
  await touchManifest(host, found.vault.manifest);
  return { status: "attached", agent: agentView(next) };
}

export async function findAgent(
  host: Host,
  agentId: string,
): Promise<{
  agent: AgentDefinition;
  path: string;
  vault: Awaited<ReturnType<typeof resolveVault>>;
}> {
  const matches: { agent: AgentDefinition; path: string; vaultId: string }[] =
    [];
  for (const summary of await listVolts(host)) {
    if (summary.profile !== "agent" || !summary.available) continue;
    const path = join(
      summary.vaultRoot,
      "agent-definitions",
      `${agentId}.json`,
    );
    if ((await pathKind(path)) !== "file") continue;
    const agent = parseAgentDefinition(await readJson(path));
    if (agent.id === agentId)
      matches.push({ agent, path, vaultId: summary.id });
  }
  const match = matches[0];
  if (!match) {
    throw new KrakenError(
      "AGENT_NOT_FOUND",
      `No defined agent named ${agentId}. Define one with: kraken agent define ${agentId} --volt <agentvolt> --instructions <file>. This defines the agent and does not launch it.`,
    );
  }
  if (matches.length > 1) {
    throw new KrakenError(
      "AMBIGUOUS_AGENT",
      `Agent ${agentId} is defined in ${matches.map((item) => item.vaultId).join(", ")}. Use a distinct agent name in each AgentVolt.`,
    );
  }
  return {
    agent: match.agent,
    path: match.path,
    vault: await resolveVault(host, match.vaultId),
  };
}

async function requireAgentVolt(host: Host, ref: string) {
  const loaded = await resolveVault(host, ref);
  if (!loaded.complete) {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${loaded.vaultRoot} is not a completed vault. Finish provisioning before defining an agent.`,
    );
  }
  if (loaded.manifest.profile !== "agent") {
    throw new KrakenError(
      "WRONG_PROFILE",
      `${loaded.manifest.id} is a ${loaded.manifest.profile} vault. Agents belong in an AgentVolt. Create one with: kraken volt create <id> --profile agent --path <path>.`,
    );
  }
  return loaded;
}

function parseAccess(value: string): ContextAccess {
  if (value === "read" || value === "read-write") return value;
  throw new KrakenError(
    "INVALID_ACCESS",
    "Access must be read or read-write. Example: --access read. read-write records a boundary; this milestone still only reads during export.",
  );
}

async function readInstructions(file: string, cwd: string): Promise<string> {
  const text = await readUserText(
    await canonicalPath(cwd, file),
    "Instructions file",
    INSTRUCTION_LIMIT,
  );
  if (text.trim().length === 0) {
    throw new KrakenError(
      "EMPTY_INSTRUCTIONS",
      "The instructions file is empty. Write the instructions, then retry.",
    );
  }
  return text;
}
