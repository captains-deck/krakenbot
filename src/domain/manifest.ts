import { isAbsolute } from "node:path";
import { identifier } from "@wormvolt/core";
import { z } from "zod";
import { KrakenError, formatZod } from "../errors.js";

export const profiles = ["basic", "dev", "agent"] as const;
export const profileSchema = z.enum(profiles);
export type Profile = z.infer<typeof profileSchema>;

const timestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "Expected an ISO-8601 UTC timestamp",
  );

const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0"),
    "Expected an absolute path",
  );

const relativePath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a safe relative path",
  );

const wormAction = z.enum(["read", "transform", "write", "share", "publish"]);

export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: identifier,
    profile: profileSchema,
    purpose: z.string().min(1).max(4000),
    vaultRoot: absolutePath,
    workingDirectory: absolutePath,
    provisioning: z.strictObject({
      template: z.literal("kraken-common"),
      version: z.literal("1"),
      profileTemplate: z.enum(["kraken-basic", "kraken-dev", "kraken-agent"]),
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
    contextEntryPoints: z.array(relativePath).min(1).max(32),
    roles: z
      .array(
        z.strictObject({
          id: identifier,
          description: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(32),
    autonomy: z.strictObject({
      mode: z.enum(["manual", "event"]),
      actions: z.array(wormAction).max(5),
    }),
    integrations: z
      .array(
        z.strictObject({
          id: identifier,
          kind: z.string().min(1).max(64),
          status: z.literal("declared"),
        }),
      )
      .max(32),
  })
  .superRefine((value, ctx) => {
    const roles = new Set<string>();
    for (const role of value.roles) {
      if (roles.has(role.id)) {
        ctx.addIssue({ code: "custom", message: `Duplicate role ${role.id}` });
      }
      roles.add(role.id);
    }
  });

export type KrakenManifest = z.infer<typeof manifestSchema>;

export const provisionStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal("complete"),
  id: identifier,
  profile: profileSchema,
  templateVersion: z.literal("1"),
  completedAt: timestamp,
});
export type ProvisionState = z.infer<typeof provisionStateSchema>;

export const registrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    vaults: z.array(
      z.strictObject({
        id: identifier,
        profile: profileSchema,
        vaultRoot: absolutePath,
        workingDirectory: absolutePath,
        registeredAt: timestamp,
      }),
    ),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const roots = new Set<string>();
    for (const vault of value.vaults) {
      if (ids.has(vault.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate vault id ${vault.id}`,
        });
      }
      if (roots.has(vault.vaultRoot)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate vault path for ${vault.id}`,
        });
      }
      ids.add(vault.id);
      roots.add(vault.vaultRoot);
    }
  });
export type WorkspaceRegistry = z.infer<typeof registrySchema>;
export type RegistryEntry = WorkspaceRegistry["vaults"][number];

const revisionId = z.string().regex(/^r[1-9][0-9]{0,5}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const promptManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: identifier,
    name: identifier,
    currentRevision: revisionId,
    revisions: z
      .array(
        z.strictObject({
          id: revisionId,
          message: z.string().min(1).max(200),
          sha256: digest,
          createdAt: timestamp,
        }),
      )
      .min(1)
      .max(1000),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const revision of value.revisions) {
      if (ids.has(revision.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate revision ${revision.id}`,
        });
      }
      ids.add(revision.id);
    }
    if (
      !value.revisions.some((revision) => revision.id === value.currentRevision)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "currentRevision is missing from revisions",
      });
    }
    const last = value.revisions.at(-1);
    if (last && last.id !== value.currentRevision) {
      ctx.addIssue({
        code: "custom",
        message: "currentRevision must be the latest revision",
      });
    }
  });
export type PromptManifest = z.infer<typeof promptManifestSchema>;

export const accessSchema = z.enum(["read", "read-write"]);
export type ContextAccess = z.infer<typeof accessSchema>;

export const agentDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  name: identifier,
  voltId: identifier,
  status: z.literal("defined"),
  adapter: z.literal("manual-handoff"),
  instructionsPath: relativePath,
  instructionsSha256: digest,
  attachments: z
    .array(
      z.strictObject({
        contextVoltId: identifier,
        include: z.string().min(1).max(256),
        access: accessSchema,
      }),
    )
    .max(64),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export function parseManifest(value: unknown): KrakenManifest {
  return parseWith(manifestSchema, value, "INVALID_MANIFEST");
}

export function parseProvisionState(value: unknown): ProvisionState {
  return parseWith(provisionStateSchema, value, "INCOMPLETE_PROVISIONING");
}

export function parseRegistry(value: unknown): WorkspaceRegistry {
  return parseWith(registrySchema, value, "REGISTRY_INVALID");
}

export function parsePromptManifest(value: unknown): PromptManifest {
  return parseWith(promptManifestSchema, value, "INVALID_PROMPT");
}

export function parseAgentDefinition(value: unknown): AgentDefinition {
  return parseWith(agentDefinitionSchema, value, "INVALID_AGENT");
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new KrakenError(code, formatZod(parsed.error));
  return parsed.data;
}
