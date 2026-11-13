import { KrakenError } from "../errors.js";
import {
  parseRegistry,
  type RegistryEntry,
  type WorkspaceRegistry,
} from "../domain/manifest.js";
import { jsonText, pathKind, readJson, writeAtomic } from "./fs.js";

export async function loadRegistry(path: string): Promise<WorkspaceRegistry> {
  const kind = await pathKind(path);
  if (kind === "missing") return { schemaVersion: 1, vaults: [] };
  if (kind !== "file") {
    throw new KrakenError(
      "REGISTRY_INVALID",
      `${path} is not a registry file. Choose another path with --registry.`,
    );
  }
  return parseRegistry(await readJson(path));
}

export async function saveRegistry(
  path: string,
  registry: WorkspaceRegistry,
): Promise<void> {
  const parsed = parseRegistry(registry);
  const ordered: WorkspaceRegistry = {
    schemaVersion: 1,
    vaults: [...parsed.vaults].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  await writeAtomic(path, jsonText(ordered));
}

export async function registerVault(
  path: string,
  entry: RegistryEntry,
): Promise<"added" | "present"> {
  const registry = await loadRegistry(path);
  const sameId = registry.vaults.find((vault) => vault.id === entry.id);
  if (sameId) {
    if (
      sameId.vaultRoot !== entry.vaultRoot ||
      sameId.profile !== entry.profile
    ) {
      throw new KrakenError(
        "CONFLICTING_PATH",
        `Vault id ${entry.id} is already registered at ${sameId.vaultRoot} (${sameId.profile}). Inspect it with: kraken volt inspect ${entry.id}`,
      );
    }
    return "present";
  }
  const sameRoot = registry.vaults.find(
    (vault) => vault.vaultRoot === entry.vaultRoot,
  );
  if (sameRoot) {
    throw new KrakenError(
      "CONFLICTING_PATH",
      `${entry.vaultRoot} is already registered as ${sameRoot.id}. Choose a different --path.`,
    );
  }
  registry.vaults.push(entry);
  await saveRegistry(path, registry);
  return "added";
}
