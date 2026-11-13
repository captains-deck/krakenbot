import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { KrakenError } from "../errors.js";
import {
  parsePromptManifest,
  type PromptManifest,
} from "../domain/manifest.js";
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
import { resolveVault, touchManifest } from "./vaults.js";
import { promptView, type PromptResult, type PromptView } from "./types.js";

const PROMPT_LIMIT = 256 * 1024;

export async function listPromptsInVault(
  vaultRoot: string,
): Promise<PromptView[]> {
  const root = join(vaultRoot, "prompts");
  if ((await pathKind(root)) !== "directory") return [];
  const entries = await readdir(root, { withFileTypes: true });
  const prompts: PromptView[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "manifest.json");
    if ((await pathKind(manifestPath)) !== "file") continue;
    prompts.push(promptView(parsePromptManifest(await readJson(manifestPath))));
  }
  prompts.sort((left, right) => left.id.localeCompare(right.id));
  return prompts;
}

export async function addPrompt(
  host: Host,
  input: { volt: string; name: string; file: string },
): Promise<PromptResult> {
  const loaded = await requireDevVolt(host, input.volt);
  const promptId = parseVaultId(input.name, "Prompt name");
  const text = await readPromptFile(input.file, host.cwd);
  const hash = sha256(text);
  const revisionPath = insideVault(
    loaded.vaultRoot,
    `prompts/${promptId}/revisions/r1.md`,
  );
  const manifestPath = insideVault(
    loaded.vaultRoot,
    `prompts/${promptId}/manifest.json`,
  );
  if ((await pathKind(manifestPath)) === "file") {
    throw new KrakenError(
      "PROMPT_EXISTS",
      `Prompt ${promptId} already exists in ${loaded.manifest.id}. Revise it with: kraken prompt revise ${loaded.manifest.id} ${promptId} --file <path> --message "<what changed>".`,
    );
  }
  await writeRevision(revisionPath, text, hash);
  const manifest: PromptManifest = parsePromptManifest({
    schemaVersion: 1,
    id: promptId,
    name: promptId,
    currentRevision: "r1",
    revisions: [
      {
        id: "r1",
        message: "Initial prompt",
        sha256: hash,
        createdAt: host.now(),
      },
    ],
  });
  await writeAtomic(manifestPath, jsonText(manifest));
  await writeAtomic(
    insideVault(loaded.vaultRoot, `prompts/${promptId}/current.md`),
    text,
  );
  await touchManifest(host, loaded.manifest);
  return result("created", loaded.manifest.id, promptId, manifest);
}

export async function revisePrompt(
  host: Host,
  input: { volt: string; promptId: string; file: string; message: string },
): Promise<PromptResult> {
  const loaded = await requireDevVolt(host, input.volt);
  const promptId = parseVaultId(input.promptId, "Prompt id");
  const message = input.message.trim();
  if (message.length === 0 || message.length > 200) {
    throw new KrakenError(
      "INVALID_MESSAGE",
      'A revision needs a change description of 1 to 200 characters. Example: --message "Clarify expected output".',
    );
  }
  const text = await readPromptFile(input.file, host.cwd);
  const hash = sha256(text);
  const manifestPath = insideVault(
    loaded.vaultRoot,
    `prompts/${promptId}/manifest.json`,
  );
  if ((await pathKind(manifestPath)) !== "file") {
    throw new KrakenError(
      "PROMPT_NOT_FOUND",
      `Prompt ${promptId} is not in ${loaded.manifest.id}. Add it with: kraken prompt add ${loaded.manifest.id} --name ${promptId} --file <path>.`,
    );
  }
  const manifest = parsePromptManifest(await readJson(manifestPath));
  const current = manifest.revisions.find(
    (revision) => revision.id === manifest.currentRevision,
  );
  if (current?.sha256 === hash) {
    await writeAtomic(
      insideVault(loaded.vaultRoot, `prompts/${promptId}/current.md`),
      text,
    );
    return result("unchanged", loaded.manifest.id, promptId, manifest);
  }
  const nextNumber =
    manifest.revisions.reduce(
      (max, revision) => Math.max(max, Number(revision.id.slice(1))),
      0,
    ) + 1;
  const nextId = `r${nextNumber}`;
  await writeRevision(
    insideVault(loaded.vaultRoot, `prompts/${promptId}/revisions/${nextId}.md`),
    text,
    hash,
  );
  const next = parsePromptManifest({
    ...manifest,
    currentRevision: nextId,
    revisions: [
      ...manifest.revisions,
      { id: nextId, message, sha256: hash, createdAt: host.now() },
    ],
  });
  await writeAtomic(manifestPath, jsonText(next));
  await writeAtomic(
    insideVault(loaded.vaultRoot, `prompts/${promptId}/current.md`),
    text,
  );
  await touchManifest(host, loaded.manifest);
  return result("revised", loaded.manifest.id, promptId, next);
}

async function writeRevision(
  path: string,
  text: string,
  hash: string,
): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "file") {
    const existing = await readUserText(
      path,
      "Existing revision",
      PROMPT_LIMIT,
    );
    if (sha256(existing) !== hash) {
      throw new KrakenError(
        "REVISION_CONFLICT",
        `${path} already exists with different content. Prompt revision history is not overwritten.`,
      );
    }
    return;
  }
  if (kind !== "missing") {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${path} is not a file. No revision was written.`,
    );
  }
  const created = await createIfAbsent(path, text);
  if (created !== "created") {
    const existing = await readUserText(
      path,
      "Existing revision",
      PROMPT_LIMIT,
    );
    if (sha256(existing) !== hash) {
      throw new KrakenError(
        "REVISION_CONFLICT",
        `${path} appeared with different content. Prompt revision history is not overwritten.`,
      );
    }
  }
}

function result(
  status: PromptResult["status"],
  vaultId: string,
  promptId: string,
  manifest: PromptManifest,
): PromptResult {
  const current = manifest.revisions.find(
    (revision) => revision.id === manifest.currentRevision,
  );
  return {
    status,
    vaultId,
    promptId,
    revision: manifest.currentRevision,
    message: current?.message ?? "",
    sha256: current?.sha256 ?? "",
    revisions: promptView(manifest).revisions,
  };
}

async function requireDevVolt(host: Host, ref: string) {
  const loaded = await resolveVault(host, ref);
  if (!loaded.complete) {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${loaded.vaultRoot} is not a completed vault. Finish provisioning before adding prompts.`,
    );
  }
  if (loaded.manifest.profile !== "dev") {
    throw new KrakenError(
      "WRONG_PROFILE",
      `${loaded.manifest.id} is a ${loaded.manifest.profile} vault. Prompt revisions require a DevVolt. Create one with: kraken volt create <id> --profile dev --path <path>.`,
    );
  }
  return loaded;
}

async function readPromptFile(file: string, cwd: string): Promise<string> {
  const text = await readUserText(
    await canonicalPath(cwd, file),
    "Prompt file",
    PROMPT_LIMIT,
  );
  if (text.trim().length === 0) {
    throw new KrakenError(
      "EMPTY_PROMPT",
      "The prompt file is empty. Write the prompt, then retry.",
    );
  }
  return text;
}
