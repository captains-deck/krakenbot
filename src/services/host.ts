import { join } from "node:path";
import type { Principal } from "@wormvolt/core";

export interface Host {
  cwd: string;
  registryPath: string;
  principal: Principal;
  now(): string;
}

export const localOperator: Principal = {
  id: "kraken-operator",
  groups: ["owner"],
};

export function createHost(
  options: {
    cwd?: string;
    registryPath?: string;
    principal?: Principal;
    now?: () => string;
  } = {},
): Host {
  const cwd = options.cwd ?? process.cwd();
  return {
    cwd,
    registryPath: options.registryPath ?? join(cwd, ".kraken", "registry.json"),
    principal: options.principal ?? localOperator,
    now: options.now ?? (() => new Date().toISOString()),
  };
}
