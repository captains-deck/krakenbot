import { join } from "node:path";
import { KrakenError } from "../errors.js";
import { assertExplicitInclude, matchesInclude } from "../domain/glob.js";
import { parsePromptManifest } from "../domain/manifest.js";
import {
  HANDOFF_BOUNDARY,
  renderHandoff,
  type HandoffFile,
} from "../adapters/manual-handoff.js";
import {
  canonicalPath,
  createExclusive,
  insideVault,
  pathKind,
  readJson,
  readUserText,
  sha256,
  walkFiles,
} from "../storage/fs.js";
import type { Host } from "./host.js";
import { findAgent } from "./agents.js";
import { assertVaultPermission } from "./permissions.js";
import { resolveVault } from "./vaults.js";
import type { ExportResult } from "./types.js";

const CONTEXT_LIMIT = 1024 * 1024;

export async function exportContext(
  host: Host,
  input: { agentId: string; output: string },
): Promise<ExportResult> {
  const found = await findAgent(host, input.agentId);
  if (!found.vault.complete) {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${found.vault.vaultRoot} is not complete, so its agent cannot be exported.`,
    );
  }
  assertVaultPermission(
    found.vault.definition,
    host.principal,
    "read",
    found.vault.manifest.id,
  );
  assertVaultPermission(
    found.vault.definition,
    host.principal,
    "share",
    found.vault.manifest.id,
  );
  const instructions = await readUserText(
    insideVault(found.vault.vaultRoot, found.agent.instructionsPath),
    "Agent instructions",
    CONTEXT_LIMIT,
  );
  if (sha256(instructions) !== found.agent.instructionsSha256) {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${found.agent.instructionsPath} no longer matches the hash stored on ${found.agent.id}. The export was not written. Define a new agent name if the instructions should change.`,
    );
  }
  const files: HandoffFile[] = [];
  for (const attachment of found.agent.attachments) {
    assertExplicitInclude(attachment.include);
    const source = await resolveVault(host, attachment.contextVoltId);
    if (!source.complete) {
      throw new KrakenError(
        "INCOMPLETE_PROVISIONING",
        `Context vault ${attachment.contextVoltId} is not complete. The export was not written.`,
      );
    }
    assertVaultPermission(
      source.definition,
      host.principal,
      "read",
      source.manifest.id,
    );
    assertVaultPermission(
      source.definition,
      host.principal,
      "share",
      source.manifest.id,
    );
    if (attachment.access === "read-write") {
      assertVaultPermission(
        source.definition,
        host.principal,
        "write",
        source.manifest.id,
      );
    }
    const selected = (await walkFiles(source.vaultRoot)).filter(
      (relativePath) => matchesInclude(attachment.include, relativePath),
    );
    for (const relativePath of selected) {
      const text = await readUserText(
        insideVault(source.vaultRoot, relativePath),
        relativePath,
        CONTEXT_LIMIT,
      );
      const revision = await revisionOf(source.vaultRoot, relativePath);
      files.push({
        vaultId: source.manifest.id,
        relativePath,
        access: attachment.access,
        sha256: sha256(text),
        revision: revision?.id ?? null,
        revisionMessage: revision?.message ?? null,
        text,
      });
    }
  }
  const output = await canonicalPath(host.cwd, input.output);
  if ((await pathKind(output)) !== "missing") {
    throw new KrakenError(
      "OUTPUT_EXISTS",
      `Refusing to overwrite ${output}. Choose a new --output path.`,
    );
  }
  const body = renderHandoff({
    agentId: found.agent.id,
    voltId: found.vault.manifest.id,
    instructionsPath: found.agent.instructionsPath,
    instructionsSha256: found.agent.instructionsSha256,
    instructions,
    attachments: found.agent.attachments.map((attachment) => ({
      contextVoltId: attachment.contextVoltId,
      include: attachment.include,
      access: attachment.access,
    })),
    files,
  });
  await createExclusive(output, body);
  return {
    ok: true,
    agentId: found.agent.id,
    voltId: found.vault.manifest.id,
    output,
    adapter: "manual-handoff",
    launched: false,
    enforcementAfterHandoff: false,
    warning: HANDOFF_BOUNDARY,
    files: files.map((file) => ({
      vaultId: file.vaultId,
      path: file.relativePath,
      sha256: file.sha256,
      revision: file.revision,
      access: file.access,
    })),
  };
}

async function revisionOf(
  vaultRoot: string,
  relativePath: string,
): Promise<{ id: string; message: string } | null> {
  const revision =
    /^prompts\/([a-z0-9][a-z0-9-]{0,63})\/revisions\/(r[1-9][0-9]{0,5})\.md$/.exec(
      relativePath,
    );
  const current = /^prompts\/([a-z0-9][a-z0-9-]{0,63})\/current\.md$/.exec(
    relativePath,
  );
  const promptId = revision?.[1] ?? current?.[1];
  if (!promptId) return null;
  const manifestPath = join(vaultRoot, "prompts", promptId, "manifest.json");
  if ((await pathKind(manifestPath)) !== "file") {
    return revision?.[2] ? { id: revision[2], message: "" } : null;
  }
  const manifest = parsePromptManifest(await readJson(manifestPath));
  const id = revision?.[2] ?? manifest.currentRevision;
  const match = manifest.revisions.find((item) => item.id === id);
  return match ? { id: match.id, message: match.message } : null;
}
