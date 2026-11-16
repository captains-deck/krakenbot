/**
 * Captain’s Volt file plans. This module has no filesystem or network access.
 * Kraken’s local command and Captain’s Volt’s Worker both call it.
 * Schema 1 Kraken manifests stay on absolute filesystem paths. This contract is schema 2
 * and names either an R2 prefix or a real filesystem root supplied by the caller.
 */

export const TEMPLATE_VERSION = "1";
export const META_SCHEMA_VERSION = 2;

export const MODULES = [
  { id: "requirements", title: "Requirements", summary: "A starter requirements note for decisions that are known and decisions that are still open.", files: ["Requirements/Requirements.md"], requires: [] },
  { id: "technical", title: "Technical specifications", summary: "A place for constraints, interfaces and technical choices, including what has not been chosen yet.", files: ["Requirements/Technical Specs.md"], requires: [] },
  { id: "architecture", title: "Architecture", summary: "An overview of the intended shape of the work, with gaps marked as open.", files: ["Architecture/Overview.md"], requires: [] },
  { id: "integrations", title: "Integrations", summary: "Documentation for integrations you expect to use. Selecting one does not connect an external service.", files: ["Integrations/README.md"], requires: [] },
  { id: "kraken", title: "Kraken provisioning", summary: "How Kraken should provision this volt. The file records the plan; it does not launch a run by itself.", files: ["Kraken/DevProvisioning.md"], requires: [] },
  { id: "agents", title: "Agent and model configuration", summary: "Responsibilities and model assignments. An unconfigured model stays unconfigured, and defining an agent does not launch it.", files: ["Kraken/dev-agents.md"], requires: ["kraken"] },
  { id: "environment", title: "Development environment", summary: "What a development environment needs, without creating one.", files: ["Kraken/DevEnvironmentCreation.md"], requires: ["kraken"] },
  { id: "deployment", title: "Deployment workflow", summary: "The intended path from a change to a deployment target. No deployment is performed.", files: ["Kraken/DeploymentWorkflow.md"], requires: ["kraken"] },
  { id: "testing", title: "Testing", summary: "Checks worth writing before the work is called ready.", files: ["Kraken/Testing.md"], requires: ["kraken"] },
  { id: "devaudit", title: "DevAudit placeholder", summary: "A reserved folder for a future audit tool. It is not an audit service.", files: ["DevAudit/README.md"], requires: [] },
  { id: "worm", title: "Worm working memory", summary: "Working memory, worm-in and worm-out. Creating the folders does not crawl, propagate or share anything.", files: ["worm/workingMemory.md", "worm/worm-in/README.md", "worm/worm-out/README.md"], requires: [] },
  { id: "assets", title: "Asset index", summary: "A list of the files in this volt and room to add later assets.", files: ["worm/Asset Index.md"], requires: [] },
  { id: "command-chest", title: "Command Chest and Foundations Dev Prompt", summary: "An editable first development handoff. The revision in the file is the one a later build would use.", files: ["Command Chest/Foundations Dev Prompt.md"], requires: [] },
  { id: "adr", title: "Architecture decisions", summary: "A reviewable decision record. It does not replace an existing note during an upgrade.", files: ["Decisions/ADR.md"], requires: [] },
  { id: "repository", title: "Repository reference", summary: "A pointer to a repository. It does not clone or grant access.", files: ["Repositories/Repository.md"], requires: [] },
  { id: "model-manifest", title: "Model Manifest reference", summary: "A citation of a Model Manifest release. The manifest service remains the registry.", files: ["Models/Model Manifest.md"], requires: [] },
  { id: "stack", title: "Stack version", summary: "The stack identity this volt claims to use, marked declared until a test cites it.", files: ["Stacks/Stack.md"], requires: [] },
  { id: "manifest", title: "Runtime manifest", summary: "Runtime requirements and licence notes. Declared support is not tested support.", files: ["Manifests/Manifest.md"], requires: [] },
  { id: "handoff", title: "Handoff", summary: "What the next person needs. Creating it does not start an agent.", files: ["Handoff/Handoff.md"], requires: [] },
];

export const DEVELOPMENT_MODULES = MODULES.map((module) => module.id).filter((id) => id !== "integrations");

const ALWAYS = ["Summary.md", "volt.json", "kraken.json", "Volt-meta/captains-volt.json", "knowledge/welcome.md"];

export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function resolveModules(voltType, selected) {
  if (voltType === "development") return [...DEVELOPMENT_MODULES];
  if (voltType !== "scratch") throw new PlanError("INVALID_TYPE", "Choose Start From Scratch or a Development VOLT.");
  const known = new Set(MODULES.map((module) => module.id));
  const chosen = new Set();
  for (const id of selected || []) {
    if (!known.has(id)) throw new PlanError("INVALID_MODULE", `Unknown module ${id}.`);
    chosen.add(id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const module of MODULES) {
      if (!chosen.has(module.id)) continue;
      for (const need of module.requires) {
        if (!chosen.has(need)) {
          chosen.add(need);
          changed = true;
        }
      }
    }
  }
  return MODULES.map((module) => module.id).filter((id) => chosen.has(id));
}

export function moduleCatalog() {
  return MODULES.map((module) => ({ ...module, requires: [...module.requires], files: [...module.files] }));
}

export function slugVoltId(name) {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : null;
}

function snapshot(value, label) {
  if (value == null) return null;
  const id = String(value.id || "").trim();
  const title = String(value.title || "").trim();
  const description = String(value.description || "").trim();
  if (!id || !title) throw new PlanError("INVALID_CONTEXT", `${label} needs a stable id and a title.`);
  if (id.length > 120 || title.length > 200 || description.length > 2000) throw new PlanError("INVALID_CONTEXT", `${label} is too long.`);
  return { id, title, description };
}

function storageOf(storage, voltId) {
  if (!storage || typeof storage !== "object") throw new PlanError("INVALID_STORAGE", "Provisioning needs a storage contract.");
  if (storage.kind === "r2") {
    const bucket = String(storage.bucket || "");
    const keyPrefix = String(storage.keyPrefix || "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(bucket)) throw new PlanError("INVALID_STORAGE", "R2 bucket name is not valid.");
    if (!keyPrefix.startsWith("owners/") || !keyPrefix.endsWith(`/volts/${voltId}`) || keyPrefix.includes("..")) {
      throw new PlanError("INVALID_STORAGE", "R2 key prefix must point at this volt.");
    }
    return { kind: "r2", bucket, keyPrefix };
  }
  if (storage.kind === "filesystem") {
    const root = String(storage.root || "");
    if (!root.startsWith("/") || root.includes("\0") || root.length > 1024) throw new PlanError("INVALID_STORAGE", "A local vault needs an absolute filesystem root.");
    return { kind: "filesystem", root };
  }
  throw new PlanError("INVALID_STORAGE", "Storage must be r2 or filesystem.");
}

export function buildMetadata(input, modules) {
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  if (title.length < 2 || title.length > 120) throw new PlanError("INVALID_NAME", "The volt name needs between 2 and 120 characters.");
  if (description.length > 4000) throw new PlanError("INVALID_DESCRIPTION", "The description must be 4000 characters or fewer.");
  const environment = snapshot(input.environment, "Environment");
  if (!environment) throw new PlanError("INVALID_CONTEXT", "An environment is required.");
  const project = snapshot(input.project, "Project");
  const mission = snapshot(input.mission, "Mission");
  if (mission && !project) throw new PlanError("INVALID_CONTEXT", "A mission association needs its parent project.");
  const voltType = input.voltType === "development" ? "development" : input.voltType === "scratch" ? "scratch" : null;
  if (!voltType) throw new PlanError("INVALID_TYPE", "Choose Start From Scratch or a Development VOLT.");
  const ownership = mission
    ? { kind: "project", environmentId: environment.id, projectId: project.id }
    : project
      ? { kind: "project", environmentId: environment.id, projectId: project.id }
      : { kind: "environment", environmentId: environment.id };
  const integrations = modules.includes("integrations")
    ? [{ id: "integration-notes", kind: "documentation", status: "declared" }]
    : [];
  return {
    schemaVersion: META_SCHEMA_VERSION,
    templateVersion: TEMPLATE_VERSION,
    voltId: input.voltId,
    title,
    description,
    voltType,
    environment,
    project,
    mission,
    ownership,
    modules: [...modules],
    integrations,
    creationRequestId: input.creationRequestId,
    krakenRunId: input.krakenRunId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    availableToChildren: true,
    ownerScope: ownership,
    references: mission ? [{ kind: "mission", environmentId: environment.id, projectId: project.id, missionId: mission.id, voltId: input.voltId }] : [],
  };
}

export function parseCaptainsMeta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanError("INVALID_META", "Captain’s Volt metadata must be an object.");
  if (value.schemaVersion === 1 && value.ownerScope && !value.voltType) return { legacy: true, portal: value };
  const modules = resolveModules(value.voltType, value.modules || []);
  const meta = buildMetadata({
    title: value.title,
    description: value.description || "",
    voltType: value.voltType,
    environment: value.environment,
    project: value.project,
    mission: value.mission,
    voltId: value.voltId,
    creationRequestId: value.creationRequestId,
    krakenRunId: value.krakenRunId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }, modules);
  for (const key of ["createdAt", "updatedAt", "creationRequestId", "krakenRunId", "voltId"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new PlanError("INVALID_META", `Metadata is missing ${key}.`);
  }
  return { legacy: false, portal: meta };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(id, fields) {
  return `# WormVolt record\n\n\`\`\`json\n${JSON.stringify({ id, fields }, null, 2)}\n\`\`\`\n`;
}

function contextLines(meta) {
  const lines = [`- Environment: ${meta.environment.title} (\`${meta.environment.id}\`)`];
  if (meta.environment.description) lines.push(`  ${meta.environment.description}`);
  lines.push(meta.project ? `- Project: ${meta.project.title} (\`${meta.project.id}\`)` : "- Project: none");
  if (meta.project?.description) lines.push(`  ${meta.project.description}`);
  lines.push(meta.mission ? `- Mission: ${meta.mission.title} (\`${meta.mission.id}\`)` : "- Mission: none");
  if (meta.mission?.description) lines.push(`  ${meta.mission.description}`);
  return lines.join("\n");
}

function relativeLink(from, to) {
  const fromDir = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let index = 0;
  while (index < fromDir.length && fromDir[index] === toParts[index]) index += 1;
  const up = fromDir.slice(index).map(() => "..");
  const down = toParts.slice(index).map((part) => encodeURIComponent(part));
  return [...up, ...down].join("/") || encodeURIComponent(to);
}

function summary(meta, paths) {
  const sections = paths.filter((path) => path.endsWith(".md") && path !== "Summary.md" && path !== "knowledge/welcome.md");
  const links = sections.map((path) => `- [${path.replace(/\.md$/, "")}](${relativeLink("Summary.md", path)})`).join("\n");
  return `# ${meta.title}

${meta.description || "Purpose still to be written."}

This volt has one canonical copy. The context below is linked, not copied.

${contextLines(meta)}

## Sections

${links || "No optional sections were selected."}

Structured WormVolt records live in \`knowledge/\`. Ordinary notes stay Markdown. \`volt.json\` and \`kraken.json\` are manifests, not notes.
`;
}

function requirements(meta) {
  return `# Requirements

Starter requirements for ${meta.title}.

## Known from the creation context

${contextLines(meta)}

${meta.description ? `The requested outcome is: ${meta.description}` : "No outcome description was supplied."}

## Still needed

- Who accepts this work as done.
- What is explicitly out of scope.
- Which existing notes, if any, must be treated as sources.

These are open questions, not decisions.
`;
}

function technical(meta) {
  return `# Technical Specs

Technical constraints for ${meta.title}. Nothing here has been selected unless it is written below.

## Supplied context

${contextLines(meta)}

## Open

- Runtime and repository.
- Interfaces this work must keep.
- Data that must stay private.

An empty choice is not a default decision.
`;
}

function architecture(meta) {
  return `# Architecture overview

${meta.title} does not have an agreed architecture yet.

## Context

${contextLines(meta)}

## Open

- The main parts of the system.
- What is allowed to call what.
- What must remain outside this volt.

Fill this in before treating a diagram as the design.
`;
}

function integrations() {
  return `# Integrations

This folder records integration intent. Creating it does not connect an external service.

| Integration | Status |
| --- | --- |
| None declared | Not connected |

Add a note here before claiming a service is available. A note is documentation, not a connection.
`;
}

function provisioning(meta) {
  return `# Kraken provisioning

Kraken planned this volt from template version ${TEMPLATE_VERSION}.

- Volt id: \`${meta.voltId}\`
- Type: ${meta.voltType}
- Creation request: \`${meta.creationRequestId}\`
- Kraken run: \`${meta.krakenRunId}\`

Provisioning writes files and registers the volt. It does not launch agents or deploy the product described here.
`;
}

function agents() {
  return `# Development agents

These are responsibilities only. No agent has been launched.

| Responsibility | Model | Provider | Status |
| --- | --- | --- | --- |
| Planning and context | Unconfigured | Unconfigured | Defined, not launched |
| Implementation handoff | Unconfigured | Unconfigured | Defined, not launched |
| Review | Unconfigured | Unconfigured | Defined, not launched |

Assign a model and provider in this file before expecting an agent to use one. Until then the assignment stays unconfigured.
`;
}

function environmentDoc(meta) {
  return `# Development environment

A development environment for ${meta.title} has not been created.

## Open

- Where the code will live.
- Which tools must be installed.
- Which secrets must stay out of this volt.

This note is the request, not the environment.
`;
}

function deployment(meta) {
  return `# Deployment workflow

No deployment has been run for ${meta.title}.

## Open

- The source of a release.
- The target environment.
- Who approves the release.

Write the path here before treating a target as active.
`;
}

function testing(meta) {
  return `# Testing

Checks to add for ${meta.title}. None of these have been run by provisioning.

- The volt opens and Summary.md links resolve.
- Required manifests still validate after edits.
- A change does not publish or share the volt on its own.

Add the checks that matter for this piece of work.
`;
}

function devAudit() {
  return `# DevAudit

This folder is a placeholder for a future audit tool.

Captain’s Volt does not run an audit from this file, and Kraken does not call an audit service when the folder is created. Replace this note when that tool exists.
`;
}

function workingMemory() {
  return `# Working memory

Temporary notes for this volt belong here.

Creating this folder does not start crawling, propagation or sharing. WormVolt autonomy stays manual, and connections stay empty.
`;
}

function wormIn() {
  return `# Worm in

Notes that a person may later bring into this volt.

Nothing is imported automatically. Add a file here only when you choose to.
`;
}

function wormOut() {
  return `# Worm out

Notes that a person may later take out of this volt.

Nothing is exported or shared automatically.
`;
}

function foundations(meta) {
  return `# Foundations Dev Prompt

Revision: r1

This is the initial development handoff for ${meta.title}. It has not been sent to a build. If a later build uses this file, it should use revision r1 until the revision line changes.

## Context

${contextLines(meta)}

${meta.description ? `Requested outcome: ${meta.description}` : "Requested outcome: not supplied."}

## Use

Prepare the work described above. Do not invent missing decisions. Where this prompt says an input is unresolved, leave it unresolved.

## Unresolved inputs

- Acceptance criteria.
- Repository and runtime.
- Models and providers for any agent.
- Deployment target.

Do not launch an agent from this file.
`;
}

function assetIndex(paths) {
  const rows = paths.map((path) => `| ${path} | Initial file |`).join("\n");
  return `# Asset index

Files created with this volt. Add later assets in the table.

| Path | Note |
| --- | --- |
${rows}
`;
}

function welcome(meta) {
  return record("welcome", {
    title: meta.title,
    summary: (meta.description || `Starter record for ${meta.title}`).slice(0, 4000),
    notes: "Structured WormVolt record. Human notes belong beside Summary.md. This record is not propagated.",
  });
}

function voltJson(meta) {
  return {
    schemaVersion: 1,
    id: meta.voltId,
    name: meta.title,
    purpose: (meta.description || meta.title).slice(0, 2000),
    knowledge: { location: "knowledge", format: "markdown-json-v1" },
    structure: {
      template: meta.voltType === "development" ? "captains-development" : "captains-scratch",
      allowedFields: ["title", "summary", "notes"],
      requiredFields: ["title", "summary"],
    },
    audience: "private",
    securityGroups: ["owner", "member"],
    policy: { read: ["owner", "member"], transform: [], write: ["owner"], share: ["owner"], publish: [] },
    autonomy: { mode: "manual", actions: ["read", "write", "share"] },
    connections: [],
  };
}

function krakenJson(meta, storage) {
  return {
    schemaVersion: 2,
    id: meta.voltId,
    profile: meta.voltType === "development" ? "captains-development" : "captains-scratch",
    purpose: meta.description || meta.title,
    storage,
    provisioning: {
      template: "captains-volt",
      version: TEMPLATE_VERSION,
      profileTemplate: meta.voltType === "development" ? "captains-development" : "captains-scratch",
    },
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    contextEntryPoints: ["Summary.md"],
    roles: [{ id: "owner", description: "Authenticated Captain’s Volt owner" }],
    autonomy: { mode: "manual", actions: ["read", "write", "share"] },
    integrations: meta.integrations,
  };
}

const BODIES = {
  "Requirements/Requirements.md": requirements,
  "Requirements/Technical Specs.md": technical,
  "Architecture/Overview.md": architecture,
  "Integrations/README.md": () => integrations(),
  "Kraken/DevProvisioning.md": provisioning,
  "Kraken/dev-agents.md": () => agents(),
  "Kraken/DevEnvironmentCreation.md": environmentDoc,
  "Kraken/DeploymentWorkflow.md": deployment,
  "Kraken/Testing.md": testing,
  "DevAudit/README.md": () => devAudit(),
  "worm/workingMemory.md": () => workingMemory(),
  "worm/worm-in/README.md": () => wormIn(),
  "worm/worm-out/README.md": () => wormOut(),
  "Command Chest/Foundations Dev Prompt.md": foundations,
  "Decisions/ADR.md": () => "# ADR\n\nStatus: proposed.\n\nRecord the decision here. An upgrade of this template does not replace a note that already exists.\n",
  "Repositories/Repository.md": () => "# Repository\n\nRemote: unset.\n\nThis is a reference. It does not clone the repository or grant access to it.\n",
  "Models/Model Manifest.md": () => "# Model Manifest\n\nmodelId: unset\nrelease: unset\nsupport: declared\nevidence: none\n\nModel Manifest remains the registry. This note cites a release; it does not copy one.\n",
  "Stacks/Stack.md": () => "# Stack\n\nstackId: unset\nversion: unset\nsupport: declared\n\nDeclared support is not tested support. Add the exact version and evidence before changing this claim.\n",
  "Manifests/Manifest.md": () => "# Manifest\n\nRuntime requirements, licences and deployment artefacts belong here as references. A compatibility claim needs an exact version and evidence.\n",
  "Handoff/Handoff.md": () => "# Handoff\n\nWrite what the next person needs. Creating this file does not start an agent.\n",
};

export function buildPlan(input) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.voltId || "")) throw new PlanError("INVALID_ID", "Volt id must be a lowercase slug.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.createdAt || "") || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.updatedAt || "")) {
    throw new PlanError("INVALID_TIME", "Timestamps must be ISO-8601 UTC with milliseconds.");
  }
  const modules = resolveModules(input.voltType, input.modules);
  const meta = buildMetadata(input, modules);
  const storage = storageOf(input.storage, input.voltId);
  const optional = modules.flatMap((id) => MODULES.find((module) => module.id === id).files);
  const paths = [...ALWAYS.filter((path) => path !== "worm/Asset Index.md"), ...optional];
  if (modules.includes("assets") && !paths.includes("worm/Asset Index.md")) paths.push("worm/Asset Index.md");
  const unique = [...new Set(paths)];
  const files = [];
  const markdownPaths = unique.filter((path) => path.endsWith(".md") && path !== "knowledge/welcome.md");
  for (const path of unique) {
    if (path === "Summary.md") files.push({ path, kind: "markdown", contents: summary(meta, markdownPaths) });
    else if (path === "knowledge/welcome.md") files.push({ path, kind: "record", contents: welcome(meta) });
    else if (path === "volt.json") files.push({ path, kind: "json", contents: json(voltJson(meta)) });
    else if (path === "kraken.json") files.push({ path, kind: "json", contents: json(krakenJson(meta, storage)) });
    else if (path === "Volt-meta/captains-volt.json") files.push({ path, kind: "json", contents: json(meta) });
    else if (path === "worm/Asset Index.md") files.push({ path, kind: "markdown", contents: "" });
    else files.push({ path, kind: "markdown", contents: BODIES[path](meta) });
  }
  const asset = files.find((file) => file.path === "worm/Asset Index.md");
  if (asset) asset.contents = assetIndex(files.map((file) => file.path).sort());
  return {
    templateVersion: TEMPLATE_VERSION,
    modules,
    metadata: meta,
    storage,
    files,
    required: ["Summary.md", "volt.json", "kraken.json", "Volt-meta/captains-volt.json", "knowledge/welcome.md"],
  };
}

export function previewPlan(input) {
  const plan = buildPlan(input);
  return {
    templateVersion: plan.templateVersion,
    modules: plan.modules,
    files: plan.files.map((file) => ({ path: file.path, kind: file.kind })),
    catalog: moduleCatalog(),
  };
}
