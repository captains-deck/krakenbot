import {
  BoundaryError,
  requirePermission,
  type Action,
  type Principal,
  type VoltDefinition,
} from "@wormvolt/core";
import { KrakenError } from "../errors.js";

export function assertVaultPermission(
  definition: VoltDefinition,
  principal: Principal,
  action: Action,
  vaultId: string,
): void {
  try {
    requirePermission(definition, principal, action);
  } catch (error) {
    if (error instanceof BoundaryError) {
      throw new KrakenError(
        error.code,
        `WormVolt policy denied ${action} on ${vaultId} for principal ${principal.id}. ${permissionHint(action)}`,
      );
    }
    throw error;
  }
}

function permissionHint(action: Action): string {
  if (action === "share") {
    return "Share is required before selected context can leave the vault. Grants live in volt.json.";
  }
  if (action === "read") {
    return "Read is required before KrakenBot can copy selected files. Grants live in volt.json.";
  }
  if (action === "write") {
    return "Write is required before a read-write attachment can be recorded. Grants live in volt.json.";
  }
  return "Grants live in volt.json.";
}
