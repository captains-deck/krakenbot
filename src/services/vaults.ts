import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  BoundaryError,
  LocalFilesystemStore,
  parseVolt,
  type VoltDefinition,
} from "@wormvolt/core";
import { KrakenError, asKrakenError } from "../errors.js";
import {
  parseManifest,
  parseProvisionState,
  type KrakenManifest,
} from "../domain/manifest.js";
import {
  contextEntryPoints,
  nextAction,
  profileDirectories,
  profileTemplate,
} from "../domain/profiles.js";
import { loadRegistry } from "../storage/registry.js";
import {
  canonicalPath,
  insideVault,
  jsonText,
  pathKind,
  readJson,
  writeAtomic,
} from "../storage/fs.js";
import type { Host } from "./host.js";
import type {
  Inspection,
  LoadedVault,
  ValidationReport,
  VaultSummary,
} from "./types.js";

export async function listVolts(host: Host): Promise<VaultSummary[]> {
  const registry = await loadRegistry(host.registryPath);
  const summaries: VaultSummary[] = [];
  for (const entry of registry.vaults) {
    let purpose = "";
    let available = false;
    if ((await pathKind(entry.vaultRoot)) === "directory") {
      available = true;
      try {
        purpose = parseManifest(
          await readJson(join(entry.vaultRoot, "kraken.json")),
        ).purpose;
      } catch {
        purpose = "";
      }
    }
    summaries.push({
      id: entry.id,
      profile: entry.profile,
      purpose,
      vaultRoot: entry.vaultRoot,
      workingDirectory: entry.workingDirectory,
      available,
      registered: true,
    });
  }
  return summaries;
}

export async function resolveVault(
  host: Host,
  ref: string,
): Promise<LoadedVault> {
  if (ref.trim().length === 0) {
    throw new KrakenError(
      "VAULT_NOT_FOUND",
      "Name a vault id or path. List registered vaults with: kraken volt list",
    );
  }
  const registry = await loadRegistry(host.registryPath);
  const byId = registry.vaults.find((vault) => vault.id === ref);
  if (byId) return loadAt(byId.vaultRoot, byId.workingDirectory, true);
  const canonical = await canonicalPath(host.cwd, ref);
  const byPath = registry.vaults.find((vault) => vault.vaultRoot === canonical);
  if (byPath) return loadAt(byPath.vaultRoot, byPath.workingDirectory, true);
  const manifestKind = await pathKind(join(canonical, "kraken.json"));
  const definitionKind = await pathKind(join(canonical, "volt.json"));
  if (definitionKind === "file" && manifestKind !== "file") {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${canonical} has volt.json but no kraken.json, so provisioning did not finish. Repeat the create command for this path. Existing files will be kept.`,
    );
  }
  if (manifestKind === "file") {
    const manifest = parseManifest(
      await readJson(join(canonical, "kraken.json")),
    );
    return loadAt(canonical, manifest.workingDirectory, false);
  }
  throw new KrakenError(
    "VAULT_NOT_FOUND",
    `No vault is registered as ${ref}, and ${canonical} has no kraken.json. Create one with: kraken volt create <id> --profile basic --path <path> --purpose "<purpose>".`,
  );
}

async function loadAt(
  vaultRoot: string,
  workingDirectory: string,
  registered: boolean,
): Promise<LoadedVault> {
  if ((await pathKind(vaultRoot)) !== "directory") {
    throw new KrakenError(
      "VAULT_MISSING",
      `Registered vault path ${vaultRoot} is not a directory. The registry entry was kept. Restore the folder or create the vault again at this path.`,
    );
  }
  const manifestPath = join(vaultRoot, "kraken.json");
  const definitionPath = join(vaultRoot, "volt.json");
  if (
    (await pathKind(manifestPath)) !== "file" ||
    (await pathKind(definitionPath)) !== "file"
  ) {
    throw new KrakenError(
      "INCOMPLETE_PROVISIONING",
      `${vaultRoot} is missing volt.json or kraken.json. Repeat the original create command to finish provisioning without overwriting files that are already there.`,
    );
  }
  const manifest = parseManifest(await readJson(manifestPath));
  const definition = parseDefinition(await readJson(definitionPath));
  const complete =
    (await pathKind(join(vaultRoot, "provisioning", "state.json"))) === "file";
  return {
    registered,
    vaultRoot,
    workingDirectory: manifest.workingDirectory || workingDirectory,
    manifest,
    definition,
    complete,
  };
}

export function parseDefinition(value: unknown): VoltDefinition {
  try {
    return parseVolt(value);
  } catch (error) {
    throw asKrakenError(error, "INVALID_VOLT");
  }
}

export async function inspectVolt(
  host: Host,
  ref: string,
): Promise<Inspection> {
  const loaded = await resolveVault(host, ref);
  const agents =
    loaded.manifest.profile === "agent"
      ? await (await import("./agents.js")).listAgentsInVault(loaded.vaultRoot)
      : [];
  const prompts =
    loaded.manifest.profile === "dev"
      ? await (
          await import("./prompts.js")
        ).listPromptsInVault(loaded.vaultRoot)
      : [];
  return {
    id: loaded.manifest.id,
    profile: loaded.manifest.profile,
    purpose: loaded.manifest.purpose,
    name: loaded.definition.name,
    vaultRoot: loaded.vaultRoot,
    workingDirectory: loaded.manifest.workingDirectory,
    registered: loaded.registered,
    complete: loaded.complete,
    schemaVersion: 1,
    profileTemplate: loaded.manifest.provisioning.profileTemplate,
    provisioningVersion: loaded.manifest.provisioning.version,
    createdAt: loaded.manifest.createdAt,
    updatedAt: loaded.manifest.updatedAt,
    contextEntryPoints: loaded.manifest.contextEntryPoints,
    autonomy: loaded.definition.autonomy,
    policy: loaded.definition.policy,
    securityGroups: [...loaded.definition.securityGroups],
    audience: loaded.definition.audience,
    connections: [...loaded.definition.connections],
    integrations: loaded.manifest.integrations,
    agents,
    prompts,
    next: nextAction(loaded.manifest.profile, loaded.manifest.id),
  };
}

export async function validateVolt(
  host: Host,
  ref: string,
): Promise<ValidationReport> {
  const issues: ValidationReport["issues"] = [];
  let id = ref;
  let vaultRoot = ref;
  let loaded: LoadedVault | null = null;
  try {
    loaded = await resolveVault(host, ref);
    id = loaded.manifest.id;
    vaultRoot = loaded.vaultRoot;
  } catch (error) {
    if (error instanceof KrakenError) {
      return {
        ok: false,
        id,
        vaultRoot,
        issues: [{ code: error.code, message: error.message }],
      };
    }
    throw error;
  }
  const statePath = join(loaded.vaultRoot, "provisioning", "state.json");
  if ((await pathKind(statePath)) !== "file") {
    issues.push({
      code: "INCOMPLETE_PROVISIONING",
      message:
        "provisioning/state.json is missing, so this vault is not complete. Repeat the create command to finish it without overwriting existing files.",
    });
  } else {
    try {
      const state = parseProvisionState(await readJson(statePath));
      if (
        state.id !== loaded.manifest.id ||
        state.profile !== loaded.manifest.profile
      ) {
        issues.push({
          code: "INCOMPATIBLE_VAULT",
          message:
            "provisioning/state.json does not match kraken.json. Do not delete user files; compare the two JSON files.",
        });
      }
    } catch (error) {
      if (error instanceof KrakenError)
        issues.push({ code: error.code, message: error.message });
      else throw error;
    }
  }
  if (loaded.definition.id !== loaded.manifest.id) {
    issues.push({
      code: "INCOMPATIBLE_VAULT",
      message: `volt.json id ${loaded.definition.id} does not match kraken.json id ${loaded.manifest.id}.`,
    });
  }
  if (loaded.definition.purpose !== loaded.manifest.purpose) {
    issues.push({
      code: "PURPOSE_MISMATCH",
      message:
        "volt.json and kraken.json record different purposes. KrakenBot will not overwrite either file.",
    });
  }
  if (
    loaded.manifest.provisioning.profileTemplate !==
    profileTemplate(loaded.manifest.profile)
  ) {
    issues.push({
      code: "INCOMPATIBLE_PROFILE",
      message:
        "The orchestration profile does not match its WormVolt template id.",
    });
  }
  if (
    loaded.definition.structure.template !==
    loaded.manifest.provisioning.profileTemplate
  ) {
    issues.push({
      code: "INCOMPATIBLE_PROFILE",
      message: `volt.json template is ${loaded.definition.structure.template}. This ${loaded.manifest.profile} vault expects ${loaded.manifest.provisioning.profileTemplate}.`,
    });
  }
  if (
    loaded.definition.autonomy.mode !== loaded.manifest.autonomy.mode ||
    !sameMembers(
      loaded.definition.autonomy.actions,
      loaded.manifest.autonomy.actions,
    )
  ) {
    issues.push({
      code: "AUTONOMY_MIRROR_MISMATCH",
      message:
        "kraken.json autonomy does not match volt.json. WormVolt's volt.json is the policy source; update the manifest mirror or restore it from the definition.",
    });
  }
  for (const role of loaded.manifest.roles) {
    if (!loaded.definition.securityGroups.includes(role.id)) {
      issues.push({
        code: "UNKNOWN_ROLE",
        message: `Role ${role.id} is not a WormVolt security group. Add the group to volt.json before treating it as a grant, or remove the label.`,
      });
    }
  }
  if (loaded.manifest.vaultRoot !== loaded.vaultRoot) {
    issues.push({
      code: "VAULT_ROOT_MISMATCH",
      message: `kraken.json vaultRoot is ${loaded.manifest.vaultRoot}, but the vault is at ${loaded.vaultRoot}. Update the manifest if you moved the folder.`,
    });
  }
  if ((await pathKind(loaded.manifest.workingDirectory)) !== "directory") {
    issues.push({
      code: "WORKDIR_MISSING",
      message: `Working directory ${loaded.manifest.workingDirectory} is missing. Create that directory; vault files are not stored there unless it is the vault itself.`,
    });
  }
  for (const directory of profileDirectories(loaded.manifest.profile)) {
    const full = join(loaded.vaultRoot, directory);
    const kind = await pathKind(full);
    if (kind !== "directory") {
      issues.push({
        code: "MISSING_DIRECTORY",
        message: `${directory}/ is ${kind}. Repeat provisioning to recreate a missing directory, or move the conflicting file aside.`,
      });
    }
  }
  for (const entry of contextEntryPoints(loaded.manifest.profile)) {
    if ((await pathKind(insideVault(loaded.vaultRoot, entry))) !== "file") {
      issues.push({
        code: "MISSING_ENTRY_POINT",
        message: `Context entry point ${entry} is missing.`,
      });
    }
  }
  try {
    const info = await lstat(loaded.vaultRoot);
    if (info.isSymbolicLink()) {
      issues.push({
        code: "UNSAFE_PATH",
        message:
          "The vault root is a symlink. WormVolt storage refuses to follow it.",
      });
    } else {
      const store = await LocalFilesystemStore.open(
        loaded.vaultRoot,
        loaded.definition.knowledge.location,
      );
      for (const recordId of await store.list()) {
        try {
          await store.read(recordId);
        } catch (error) {
          if (error instanceof BoundaryError) {
            issues.push({
              code: error.code,
              message: `Knowledge record ${recordId} failed WormVolt validation (${error.code}). The record was not rewritten.`,
            });
          } else {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof BoundaryError) {
      issues.push({
        code: error.code,
        message: `WormVolt refused the knowledge directory (${error.code}).`,
      });
    } else if (error instanceof KrakenError) {
      issues.push({ code: error.code, message: error.message });
    } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      issues.push({
        code: "MISSING_DIRECTORY",
        message:
          "WormVolt could not open the knowledge directory. Repeat provisioning if that folder is missing.",
      });
    } else {
      throw error;
    }
  }
  return { ok: issues.length === 0, id, vaultRoot, issues };
}

function sameMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  );
}

export async function touchManifest(
  host: Host,
  manifest: KrakenManifest,
): Promise<void> {
  const next = parseManifest({ ...manifest, updatedAt: host.now() });
  await writeAtomic(join(manifest.vaultRoot, "kraken.json"), jsonText(next));
}
