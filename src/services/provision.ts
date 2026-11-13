import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BoundaryError, LocalFilesystemStore } from "@wormvolt/core";
import { KrakenError } from "../errors.js";
import {
  parseManifest,
  parseProvisionState,
  type KrakenManifest,
  type Profile,
  type ProvisionState,
} from "../domain/manifest.js";
import {
  defaultPurpose,
  nextAction,
  parseProfile,
  parseVaultId,
  profileDirectories,
  profileTemplate,
  starterFiles,
  welcomeRecord,
  type StarterFile,
} from "../domain/profiles.js";
import {
  canonicalPath,
  createIfAbsent,
  insideVault,
  jsonText,
  pathKind,
  pathsConflict,
  readJson,
} from "../storage/fs.js";
import { loadRegistry, registerVault } from "../storage/registry.js";
import type { Host } from "./host.js";
import { parseDefinition } from "./vaults.js";
import type { CreateVoltInput, ProvisionResult } from "./types.js";
import type { VoltDefinition } from "@wormvolt/core";

interface ExistingVault {
  volt: VoltDefinition | null;
  manifest: KrakenManifest | null;
  state: ProvisionState | null;
}

export async function createVolt(
  host: Host,
  input: CreateVoltInput,
): Promise<ProvisionResult> {
  const id = parseVaultId(input.id);
  const profile = parseProfile(input.profile);
  const requestedPurpose =
    (input.purpose ?? "").trim() || defaultPurpose(profile);
  if (requestedPurpose.length > 4000) {
    throw new KrakenError(
      "INVALID_PURPOSE",
      "Purpose must be 4000 characters or fewer.",
    );
  }
  const vaultRoot = await canonicalPath(host.cwd, input.path);
  const workingDirectory = await canonicalPath(
    host.cwd,
    input.workdir ?? input.path,
  );
  if (pathsConflict(vaultRoot, workingDirectory)) {
    throw new KrakenError(
      "CONFLICTING_PATH",
      `Vault path and working directory must not contain each other. Vault: ${vaultRoot}. Working directory: ${workingDirectory}. Use the same path for both, or two directories that do not nest.`,
    );
  }
  await assertRegistryAllows(host, id, profile, vaultRoot);
  await assertPathAvailable(vaultRoot, "Vault path");
  await assertPathAvailable(workingDirectory, "Working directory");

  const existing = await readExisting(vaultRoot);
  assertCompatible(existing, id, profile, vaultRoot, workingDirectory);
  const purpose =
    existing.manifest?.purpose ?? existing.volt?.purpose ?? requestedPurpose;
  const createdAt = existing.manifest?.createdAt ?? host.now();
  const files = starterFiles({
    id,
    profile,
    purpose,
    vaultRoot,
    workingDirectory,
    createdAt,
  });
  const state: ProvisionState = {
    schemaVersion: 1,
    status: "complete",
    id,
    profile,
    templateVersion: "1",
    completedAt: existing.state?.completedAt ?? host.now(),
  };
  await assertLayout(vaultRoot, profile, files);

  const created: string[] = [];
  const preserved: string[] = [];
  const welcomePath = "knowledge/welcome.md";
  const account = async (
    relativePath: string,
    present: boolean,
  ): Promise<void> => {
    if (present) preserved.push(relativePath);
    else created.push(relativePath);
  };
  for (const file of files) {
    await account(
      file.relativePath,
      (await pathKind(insideVault(vaultRoot, file.relativePath))) === "file",
    );
  }
  await account(
    welcomePath,
    (await pathKind(insideVault(vaultRoot, welcomePath))) === "file",
  );
  await account("provisioning/state.json", existing.state !== null);

  const base = {
    id,
    profile,
    purpose,
    vaultRoot,
    workingDirectory,
    created,
    preserved,
  };
  if (input.dryRun) {
    return {
      ...base,
      status: "dry-run",
      next: `Repeat without --dry-run to provision ${id}.`,
    };
  }

  if (workingDirectory !== vaultRoot)
    await mkdir(workingDirectory, { recursive: true });
  await mkdir(vaultRoot, { recursive: true });
  for (const directory of profileDirectories(profile)) {
    await mkdir(insideVault(vaultRoot, directory), { recursive: true });
  }

  const written: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    if (file.relativePath === "volt.json" && existing.volt) {
      kept.push(file.relativePath);
      continue;
    }
    if (file.relativePath === "kraken.json" && existing.manifest) {
      kept.push(file.relativePath);
      continue;
    }
    await place(vaultRoot, file, written, kept);
  }
  if ((await pathKind(insideVault(vaultRoot, welcomePath))) === "file") {
    kept.push(welcomePath);
  } else {
    await writeWelcome(vaultRoot, {
      id,
      profile,
      purpose,
      vaultRoot,
      workingDirectory,
      createdAt,
    });
    written.push(welcomePath);
  }
  if (existing.state) {
    kept.push("provisioning/state.json");
  } else {
    await place(
      vaultRoot,
      { relativePath: "provisioning/state.json", contents: jsonText(state) },
      written,
      kept,
    );
  }
  await registerVault(host.registryPath, {
    id,
    profile,
    vaultRoot,
    workingDirectory,
    registeredAt: host.now(),
  });
  return {
    status: written.length === 0 ? "unchanged" : "created",
    id,
    profile,
    purpose,
    vaultRoot,
    workingDirectory,
    created: written,
    preserved: kept,
    next: nextAction(profile, id),
  };
}

async function place(
  vaultRoot: string,
  file: StarterFile,
  written: string[],
  kept: string[],
): Promise<void> {
  const result = await createIfAbsent(
    insideVault(vaultRoot, file.relativePath),
    file.contents,
  );
  if (result === "created") written.push(file.relativePath);
  else kept.push(file.relativePath);
}

async function writeWelcome(
  vaultRoot: string,
  input: {
    id: string;
    profile: Profile;
    purpose: string;
    vaultRoot: string;
    workingDirectory: string;
    createdAt: string;
  },
): Promise<void> {
  try {
    const store = await LocalFilesystemStore.open(vaultRoot, "knowledge");
    await store.create(welcomeRecord(input));
  } catch (error) {
    if (error instanceof BoundaryError) {
      throw new KrakenError(
        error.code,
        `Could not write the starter knowledge record (${error.code}). Existing files were kept. Fix the knowledge directory and repeat the create command.`,
      );
    }
    throw error;
  }
}

async function assertRegistryAllows(
  host: Host,
  id: string,
  profile: Profile,
  vaultRoot: string,
): Promise<void> {
  const registry = await loadRegistry(host.registryPath);
  const sameId = registry.vaults.find((vault) => vault.id === id);
  if (
    sameId &&
    (sameId.vaultRoot !== vaultRoot || sameId.profile !== profile)
  ) {
    throw new KrakenError(
      "CONFLICTING_PATH",
      `Vault id ${id} is already registered at ${sameId.vaultRoot} (${sameId.profile}). Inspect it with: kraken volt inspect ${id}`,
    );
  }
  const sameRoot = registry.vaults.find(
    (vault) => vault.vaultRoot === vaultRoot,
  );
  if (sameRoot && sameRoot.id !== id) {
    throw new KrakenError(
      "CONFLICTING_PATH",
      `${vaultRoot} is already registered as ${sameRoot.id}. Choose a different --path.`,
    );
  }
}

async function assertPathAvailable(path: string, label: string): Promise<void> {
  const kind = await pathKind(path);
  if (kind === "missing" || kind === "directory") return;
  throw new KrakenError(
    kind === "symlink" ? "UNSAFE_PATH" : "INCOMPATIBLE_VAULT",
    `${label} ${path} is a ${kind}. Choose a real directory.`,
  );
}

async function readExisting(vaultRoot: string): Promise<ExistingVault> {
  return {
    volt: await readVolt(vaultRoot),
    manifest: await readManifest(vaultRoot),
    state: await readState(vaultRoot),
  };
}

async function readVolt(vaultRoot: string): Promise<VoltDefinition | null> {
  const path = join(vaultRoot, "volt.json");
  const kind = await pathKind(path);
  if (kind === "missing") return null;
  if (kind !== "file") {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${path} is a ${kind}. KrakenBot needs volt.json to be a WormVolt definition file and did not change it.`,
    );
  }
  try {
    return parseDefinition(await readJson(path));
  } catch (error) {
    const message =
      error instanceof KrakenError
        ? error.message
        : "The file could not be parsed.";
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `Existing volt.json is not a valid WormVolt definition. ${message} KrakenBot did not change the directory.`,
    );
  }
}

async function readManifest(vaultRoot: string): Promise<KrakenManifest | null> {
  const path = join(vaultRoot, "kraken.json");
  const kind = await pathKind(path);
  if (kind === "missing") return null;
  if (kind !== "file") {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${path} is a ${kind}. KrakenBot needs kraken.json to be the orchestration manifest and did not change it.`,
    );
  }
  try {
    return parseManifest(await readJson(path));
  } catch (error) {
    const message =
      error instanceof KrakenError
        ? error.message
        : "The file could not be parsed.";
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `Existing kraken.json is not a valid KrakenBot manifest. ${message} KrakenBot did not change the directory.`,
    );
  }
}

async function readState(vaultRoot: string): Promise<ProvisionState | null> {
  const path = join(vaultRoot, "provisioning", "state.json");
  const kind = await pathKind(path);
  if (kind === "missing") return null;
  if (kind !== "file") {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${path} is a ${kind}. Remove that conflict and repeat provisioning. Other files were not changed.`,
    );
  }
  try {
    return parseProvisionState(await readJson(path));
  } catch (error) {
    const message =
      error instanceof KrakenError
        ? error.message
        : "The file could not be parsed.";
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `provisioning/state.json is not a completion marker. ${message} KrakenBot did not overwrite it.`,
    );
  }
}

function assertCompatible(
  existing: ExistingVault,
  id: string,
  profile: Profile,
  vaultRoot: string,
  workingDirectory: string,
): void {
  if (existing.volt && existing.volt.id !== id) {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      `${vaultRoot} already contains volt.json for ${existing.volt.id}. Choose a different --path, or repeat create with id ${existing.volt.id}. No files were changed.`,
    );
  }
  if (
    existing.volt &&
    existing.volt.structure.template !== profileTemplate(profile)
  ) {
    throw new KrakenError(
      "INCOMPATIBLE_PROFILE",
      `${vaultRoot} uses WormVolt template ${existing.volt.structure.template}, which is not ${profileTemplate(profile)}. No files were changed.`,
    );
  }
  if (
    existing.manifest &&
    (existing.manifest.id !== id || existing.manifest.profile !== profile)
  ) {
    throw new KrakenError(
      "INCOMPATIBLE_PROFILE",
      `${vaultRoot} is already a ${existing.manifest.profile} vault named ${existing.manifest.id}. No files were changed.`,
    );
  }
  if (existing.manifest && existing.manifest.vaultRoot !== vaultRoot) {
    throw new KrakenError(
      "VAULT_ROOT_MISMATCH",
      `kraken.json records vault root ${existing.manifest.vaultRoot}, but this command resolved ${vaultRoot}. No files were changed.`,
    );
  }
  if (
    existing.manifest &&
    existing.manifest.workingDirectory !== workingDirectory
  ) {
    throw new KrakenError(
      "CONFLICTING_PATH",
      `This vault already uses working directory ${existing.manifest.workingDirectory}. Repeat create with that --workdir. No files were changed.`,
    );
  }
  if (
    existing.state &&
    (existing.state.id !== id || existing.state.profile !== profile)
  ) {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      "provisioning/state.json belongs to a different vault. No files were changed.",
    );
  }
  if (
    existing.volt &&
    existing.manifest &&
    existing.volt.id !== existing.manifest.id
  ) {
    throw new KrakenError(
      "INCOMPATIBLE_VAULT",
      "volt.json and kraken.json name different vault ids. No files were changed.",
    );
  }
}

async function assertLayout(
  vaultRoot: string,
  profile: Profile,
  files: StarterFile[],
): Promise<void> {
  for (const directory of profileDirectories(profile)) {
    const full = join(vaultRoot, directory);
    const kind = await pathKind(full);
    if (kind === "file" || kind === "symlink" || kind === "other") {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${full} is a ${kind}, so the ${directory}/ folder cannot be created. Move it aside and retry. No vault files were written by this attempt.`,
      );
    }
  }
  for (const file of [
    ...files,
    { relativePath: "provisioning/state.json" },
    { relativePath: "knowledge/welcome.md" },
  ]) {
    const full = join(vaultRoot, file.relativePath);
    const kind = await pathKind(full);
    if (kind === "directory" || kind === "symlink" || kind === "other") {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${full} is a ${kind}. KrakenBot will not replace it. Move it aside and retry.`,
      );
    }
  }
}
