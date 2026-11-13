import { identifier, parseVolt, type VoltDefinition } from "@wormvolt/core";
import { KrakenError } from "../errors.js";
import {
  parseManifest,
  type KrakenManifest,
  type Profile,
} from "./manifest.js";

export const TEMPLATE_VERSION = "1";

export function parseProfile(value: string): Profile {
  if (value === "basic" || value === "dev" || value === "agent") return value;
  throw new KrakenError(
    "INVALID_PROFILE",
    'Profile must be basic, dev or agent. Example: kraken volt create my-notes --profile basic --path ./volts/my-notes --purpose "Project knowledge".',
  );
}

export function parseVaultId(value: string, label = "Vault id"): string {
  const parsed = identifier.safeParse(value);
  if (!parsed.success) {
    throw new KrakenError(
      "INVALID_ID",
      `${label} must start with a letter or digit and then use only lowercase letters, digits and hyphens, with at most 64 characters. For example: my-notes.`,
    );
  }
  return parsed.data;
}

export function profileLabel(profile: Profile): string {
  if (profile === "basic") return "Basic WormVolt";
  if (profile === "dev") return "DevVolt";
  return "AgentVolt";
}

export function profileTemplate(
  profile: Profile,
): KrakenManifest["provisioning"]["profileTemplate"] {
  if (profile === "basic") return "kraken-basic";
  if (profile === "dev") return "kraken-dev";
  return "kraken-agent";
}

export function defaultPurpose(profile: Profile): string {
  if (profile === "basic")
    return "General-purpose knowledge and working context";
  if (profile === "dev")
    return "Development briefs, prompts, decisions and handovers";
  return "Agent definition, instructions and permitted context";
}

export function nextAction(profile: Profile, id: string): string {
  if (profile === "basic") {
    return `Add working notes under context/, then run: kraken volt validate ${id}`;
  }
  if (profile === "dev") {
    return `Record a prompt: kraken prompt add ${id} --name implement-feature --file ./prompt.md`;
  }
  return `Define an agent without launching one: kraken agent define helper --volt ${id} --instructions ./instructions.md`;
}

export function profileDirectories(profile: Profile): string[] {
  const common = [
    "knowledge",
    "context",
    "working-memory",
    "agent-definitions",
    "provisioning",
    "history",
    "archive",
  ];
  if (profile === "dev")
    return [...common, "briefs", "prompts", "decisions", "handovers"];
  if (profile === "agent")
    return [...common, "instructions", "sessions", "handovers"];
  return common;
}

export function contextEntryPoints(profile: Profile): string[] {
  const points = ["README.md", "context/README.md"];
  if (profile === "dev") points.push("briefs/README.md", "prompts/README.md");
  if (profile === "agent") points.push("instructions/README.md");
  return points;
}

export interface StarterInput {
  id: string;
  profile: Profile;
  purpose: string;
  vaultRoot: string;
  workingDirectory: string;
  createdAt: string;
}

export interface StarterFile {
  relativePath: string;
  contents: string;
}

export function starterFiles(input: StarterInput): StarterFile[] {
  const definition = vaultDefinition(input);
  const manifest = orchestrationManifest(input);
  const files: StarterFile[] = [
    { relativePath: "volt.json", contents: json(definition) },
    { relativePath: "kraken.json", contents: json(manifest) },
    { relativePath: "README.md", contents: rootReadme(input) },
    { relativePath: "knowledge/README.md", contents: knowledgeReadme() },
    { relativePath: "context/README.md", contents: contextReadme() },
    {
      relativePath: "working-memory/README.md",
      contents: workingMemoryReadme(),
    },
    {
      relativePath: "agent-definitions/README.md",
      contents: agentDefinitionsReadme(),
    },
    { relativePath: "provisioning/README.md", contents: provisioningReadme() },
    { relativePath: "history/README.md", contents: historyReadme() },
    { relativePath: "archive/README.md", contents: archiveReadme() },
  ];
  if (input.profile === "dev") {
    files.push(
      { relativePath: "briefs/README.md", contents: briefsReadme() },
      { relativePath: "prompts/README.md", contents: promptsReadme() },
      { relativePath: "decisions/README.md", contents: decisionsReadme() },
      { relativePath: "handovers/README.md", contents: devHandoverReadme() },
    );
  }
  if (input.profile === "agent") {
    files.push(
      {
        relativePath: "instructions/README.md",
        contents: instructionsReadme(),
      },
      { relativePath: "sessions/README.md", contents: sessionsReadme() },
      { relativePath: "handovers/README.md", contents: agentHandoverReadme() },
    );
  }
  return files;
}

export function vaultDefinition(input: StarterInput): VoltDefinition {
  return parseVolt({
    schemaVersion: 1,
    id: input.id,
    name: input.id,
    purpose: input.purpose,
    knowledge: { location: "knowledge", format: "markdown-json-v1" },
    structure: {
      template: profileTemplate(input.profile),
      allowedFields: ["title", "summary", "notes"],
      requiredFields: ["title", "summary"],
    },
    audience: "private",
    securityGroups: ["owner"],
    policy: {
      read: ["owner"],
      transform: [],
      write: ["owner"],
      share: ["owner"],
      publish: [],
    },
    autonomy: { mode: "manual", actions: ["read", "write", "share"] },
    connections: [],
  });
}

export function orchestrationManifest(input: StarterInput): KrakenManifest {
  return parseManifest({
    schemaVersion: 1,
    id: input.id,
    profile: input.profile,
    purpose: input.purpose,
    vaultRoot: input.vaultRoot,
    workingDirectory: input.workingDirectory,
    provisioning: {
      template: "kraken-common",
      version: TEMPLATE_VERSION,
      profileTemplate: profileTemplate(input.profile),
    },
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    contextEntryPoints: contextEntryPoints(input.profile),
    roles: [{ id: "owner", description: "Local KrakenBot operator" }],
    autonomy: { mode: "manual", actions: ["read", "write", "share"] },
    integrations: [],
  });
}

export function welcomeRecord(input: StarterInput): {
  id: "welcome";
  fields: { title: string; summary: string; notes: string };
} {
  return {
    id: "welcome",
    fields: {
      title: profileLabel(input.profile),
      summary: `Starter record. ${input.purpose}`.slice(0, 4000),
      notes:
        "Structured WormVolt record. Human notes belong in context/. This record is not propagated because the vault stays in manual autonomy with no connections.",
    },
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rootReadme(input: StarterInput): string {
  const work =
    input.workingDirectory === input.vaultRoot
      ? "The working directory is this vault."
      : `The working directory is \`${input.workingDirectory}\`. KrakenBot does not copy that directory into the vault.`;
  return `# ${input.id}

${profileLabel(input.profile)}. ${input.purpose}

This folder is an Obsidian-compatible WormVolt. You can read and edit the
Markdown in any editor. KrakenBot does not require Obsidian, an Obsidian plugin
or an AI provider.

## Where to put information

- \`context/\` holds working context you may later attach to an agent.
- \`knowledge/\` holds structured WormVolt records (\`markdown-json-v1\`).
- \`working-memory/\` holds temporary notes that are not shared by default.
- \`archive/\` is for notes you retire yourself.

${profileSpecific(input.profile)}

## Definition

\`volt.json\` is the WormVolt version-1 definition: identity, purpose, knowledge
format, groups, action policy and autonomy. KrakenBot validates it with
WormVolt and does not add fields there.

\`kraken.json\` is the KrakenBot orchestration manifest: profile, vault root,
working directory, provisioning version, timestamps, context entry points, role
labels and integration declarations. Role labels do not grant access. Grants
live only in \`volt.json\` and are checked with WormVolt's permission function.

${work}

The local operator group \`owner\` may read, write and share. Transform and
publish are not granted. Autonomy is manual, and \`connections\` is empty, so
this vault does not run background WormVolt propagation.

A Markdown link does not grant an agent access to its target.
`;
}

function profileSpecific(profile: Profile): string {
  if (profile === "dev") {
    return `## DevVolt

- \`briefs/\` holds the problem or change you are working on.
- \`prompts/\` holds reusable prompts. Each revision is an immutable file under \`prompts/<id>/revisions/\`. Prompt revision history is not Git history.
- \`decisions/\` holds decisions worth keeping.
- \`handovers/\` holds notes for the next person or session.

Record a prompt with \`kraken prompt add\`. Revise it with \`kraken prompt revise\` and a short change description.`;
  }
  if (profile === "agent") {
    return `## AgentVolt

- \`instructions/\` holds the instruction text copied for a defined agent.
- \`agent-definitions/\` holds the agent record. Its status stays \`defined\`.
- \`sessions/\` is space for later session notes. This milestone does not write a live session.
- \`handovers/\` holds notes prepared for a person or the next session.

Defining or attaching an agent does not launch it. \`kraken context export\` writes a manual handoff bundle. Exported instructions do not enforce restrictions on an external assistant after handoff.`;
  }
  return `## Basic WormVolt

Use this vault for general knowledge and working context. Add Markdown under
\`context/\`. A later AgentVolt can attach an explicit selection such as
\`context/**\`; it will not receive the rest of this vault unless that path is
named too.`;
}

function knowledgeReadme(): string {
  return `# Knowledge

Put reviewed WormVolt records here. A record is a Markdown file whose name
matches its id, with the heading \`WormVolt record\` and one JSON fence.
KrakenBot seeds \`welcome.md\`. Editing that file is preserved if you provision
again.

Arbitrary notes belong in \`context/\`, not in this record format.
`;
}

function contextReadme(): string {
  return `# Context

Put the notes an agent may need here. Nothing in this folder is attached to an
agent until you name an include pattern, for example \`context/**\` or
\`context/public/**\`.

Files outside the pattern stay out of the handoff bundle.
`;
}

function workingMemoryReadme(): string {
  return `# Working memory

Temporary notes for the work in front of you. They are not selected unless an
include pattern names \`working-memory/\`.
`;
}

function agentDefinitionsReadme(): string {
  return `# Agent definitions

Each agent is a JSON file with status \`defined\` and adapter \`manual-handoff\`.
Creating this file does not launch an agent or call a model provider.

Attachments list a context vault, an include pattern and an access boundary.
They do not copy that vault into this one.
`;
}

function provisioningReadme(): string {
  return `# Provisioning

\`state.json\` is written only after the starter files are in place. KrakenBot
registers the vault after that marker exists. A directory without \`state.json\`
is incomplete and is left out of \`kraken volt list\`.

Provisioning never overwrites a file that is already here. Run the same create
command again to fill in files that are still missing.
`;
}

function historyReadme(): string {
  return `# History

Reserved for later orchestration history. Prompt revisions are stored with the
prompt under \`prompts/\`, not in this folder, and they are not Git commits.
`;
}

function archiveReadme(): string {
  return `# Archive

Move retired notes here yourself. KrakenBot does not delete vault files.
`;
}

function briefsReadme(): string {
  return `# Briefs

Describe the change, the constraint and the expected result. A brief is human
Markdown. It becomes agent context only when an include pattern names it.
`;
}

function promptsReadme(): string {
  return `# Prompts

\`kraken prompt add\` creates \`prompts/<id>/revisions/r1.md\`, a manifest and
\`current.md\`. \`kraken prompt revise\` appends the next immutable revision and
records your change description.

Prompt revision history is not Git history. Do not edit files in \`revisions/\`;
add a new revision instead. \`current.md\` is the checkout of the latest
revision.
`;
}

function decisionsReadme(): string {
  return `# Decisions

Record a decision, the reason and the date in your own Markdown. KrakenBot does
not rewrite these files.
`;
}

function devHandoverReadme(): string {
  return `# Handovers

Write what the next session needs: the current prompt revision, open decisions
and where the work lives. This folder is not a Git log.
`;
}

function instructionsReadme(): string {
  return `# Instructions

\`kraken agent define\` copies instruction Markdown here. Editing the copy later
does not by itself change the stored hash; define the agent again only when no
definition exists. This folder does not start an agent.
`;
}

function sessionsReadme(): string {
  return `# Sessions

Space for notes about a future session. This milestone does not launch an agent
and does not write session transcripts.
`;
}

function agentHandoverReadme(): string {
  return `# Handovers

Use this folder for a human summary of what the defined agent is allowed to
see. The export bundle is a separate file you choose with \`--output\`.
`;
}
