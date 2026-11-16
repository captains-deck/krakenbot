#!/usr/bin/env node
import { KrakenError } from "../errors.js";
import {
  formatAgent,
  formatExport,
  formatInspection,
  formatPrompt,
  formatProvision,
  formatThrown,
  formatValidation,
  formatVaultList,
} from "../format.js";
import { createKrakenApp } from "../services/app.js";
import { runUi } from "../ui/run.js";
import {
  optionalString,
  parseArgs,
  requiredPositional,
  requiredString,
} from "./args.js";
import { runDemoCli } from "./demo.js";
import { helpText } from "./help.js";

const wantsJson = process.argv.includes("--json");

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [group, action, ...rest] = parsed.positionals;
  if (
    parsed.flags.get("help") === true ||
    group === undefined ||
    group === "help"
  ) {
    process.stdout.write(helpText(group === "help" ? action : group));
    return;
  }
  const registryFlag = optionalString(parsed.flags, "registry");
  const registryFromEnv = process.env.KRAKEN_REGISTRY;
  const app = createKrakenApp({
    cwd: process.cwd(),
    ...(registryFlag
      ? { registryPath: registryFlag }
      : registryFromEnv
        ? { registryPath: registryFromEnv }
        : {}),
  });
  const json = parsed.flags.get("json") === true;
  const write = (value: unknown, text: string): void => {
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : text);
  };

  if (group === "ui") {
    await runUi(app, process.stdin, process.stdout);
    return;
  }
  if (group === "volt" && action === "create") {
    const created = await app.createVolt({
      id: requiredPositional(
        rest,
        0,
        "Usage: kraken volt create <id> --profile <basic|dev|agent> --path <path> [--workdir <path>] [--purpose <text>] [--dry-run]",
      ),
      profile: requiredString(
        parsed.flags,
        "profile",
        "Usage: kraken volt create <id> --profile <basic|dev|agent> --path <path>",
      ),
      path: requiredString(
        parsed.flags,
        "path",
        "Option --path is required. Example: --path ./volts/my-notes",
      ),
      purpose: optionalString(parsed.flags, "purpose"),
      workdir: optionalString(parsed.flags, "workdir"),
      dryRun: parsed.flags.get("dry-run") === true,
    });
    write(created, formatProvision(created));
    return;
  }
  if (group === "volt" && action === "provision-captains") {
    const usage =
      "Usage: kraken volt provision-captains <id> --path <path> --type <scratch|development> --title <text> --environment <id> --environment-title <text> [--description <text>] [--project <id> --project-title <text>] [--mission <id> --mission-title <text>] [--modules <ids>] [--dry-run]";
    const projectId = optionalString(parsed.flags, "project");
    const projectTitle = optionalString(parsed.flags, "project-title");
    const missionId = optionalString(parsed.flags, "mission");
    const missionTitle = optionalString(parsed.flags, "mission-title");
    const modules = (optionalString(parsed.flags, "modules") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const { provisionCaptainsFilesystem } = await import(
      "../../runtime/captainsProvision.mjs"
    );
    let result;
    try {
      result = await provisionCaptainsFilesystem({
        voltId: requiredPositional(rest, 0, usage),
        path: requiredString(parsed.flags, "path", usage),
        cwd: process.cwd(),
        title: requiredString(parsed.flags, "title", usage),
        description: optionalString(parsed.flags, "description") ?? "",
        voltType: requiredString(parsed.flags, "type", usage),
        modules,
        environment: {
          id: requiredString(parsed.flags, "environment", usage),
          title: requiredString(parsed.flags, "environment-title", usage),
          description: "",
        },
        project:
          projectId && projectTitle
            ? { id: projectId, title: projectTitle, description: "" }
            : null,
        mission:
          missionId && missionTitle
            ? { id: missionId, title: missionTitle, description: "" }
            : null,
        dryRun: parsed.flags.get("dry-run") === true,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        const code = (error as { code?: unknown }).code;
        throw new KrakenError(
          typeof code === "string" ? code : "INVALID_PLAN",
          error.message,
        );
      }
      throw error;
    }
    write(
      result,
      result.dryRun
        ? `Dry run for ${result.voltId}. ${result.files.length} files. Nothing was written.\n`
        : `Provisioned ${result.voltId}. Wrote ${result.written.length}. Preserved ${result.preserved.length}.\n`,
    );
    return;
  }
  if (group === "volt" && action === "list") {
    const vaults = await app.listVolts();
    write({ ok: true, vaults }, formatVaultList(vaults));
    return;
  }
  if (group === "volt" && action === "inspect") {
    const ref = requiredPositional(
      rest,
      0,
      "Usage: kraken volt inspect <id-or-path>",
    );
    const inspection = await app.inspectVolt(ref);
    write(inspection, formatInspection(inspection));
    return;
  }
  if (group === "volt" && action === "validate") {
    const ref = requiredPositional(
      rest,
      0,
      "Usage: kraken volt validate <id-or-path>",
    );
    const report = await app.validateVolt(ref);
    write(report, formatValidation(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (group === "prompt" && action === "add") {
    const added = await app.addPrompt({
      volt: requiredPositional(
        rest,
        0,
        "Usage: kraken prompt add <devvolt> --name <prompt-id> --file <path>",
      ),
      name: requiredString(
        parsed.flags,
        "name",
        "Option --name is required. Example: --name implement-feature",
      ),
      file: requiredString(
        parsed.flags,
        "file",
        "Option --file is required. Example: --file ./prompt.md",
      ),
    });
    write(added, formatPrompt(added));
    return;
  }
  if (group === "prompt" && action === "revise") {
    const revised = await app.revisePrompt({
      volt: requiredPositional(
        rest,
        0,
        'Usage: kraken prompt revise <devvolt> <prompt-id> --file <path> --message "<what changed>"',
      ),
      promptId: requiredPositional(
        rest,
        1,
        'Usage: kraken prompt revise <devvolt> <prompt-id> --file <path> --message "<what changed>"',
      ),
      file: requiredString(parsed.flags, "file", "Option --file is required."),
      message: requiredString(
        parsed.flags,
        "message",
        'Option --message is required. Example: --message "Clarify expected output"',
      ),
    });
    write(revised, formatPrompt(revised));
    return;
  }
  if (group === "agent" && action === "define") {
    const defined = await app.defineAgent({
      agentId: requiredPositional(
        rest,
        0,
        "Usage: kraken agent define <name> --volt <agentvolt> --instructions <path>",
      ),
      volt: requiredString(parsed.flags, "volt", "Option --volt is required."),
      instructions: requiredString(
        parsed.flags,
        "instructions",
        "Option --instructions is required.",
      ),
    });
    write(defined, formatAgent(defined));
    return;
  }
  if (group === "agent" && action === "attach") {
    const attached = await app.attachContext({
      agentId: requiredPositional(
        rest,
        0,
        "Usage: kraken agent attach <name> --context <volt> --include <pattern> --access <read|read-write>",
      ),
      context: requiredString(
        parsed.flags,
        "context",
        "Option --context is required.",
      ),
      include: requiredString(
        parsed.flags,
        "include",
        "Option --include is required. Example: --include 'context/**'",
      ),
      access: requiredString(
        parsed.flags,
        "access",
        "Option --access is required. Use read or read-write.",
      ),
    });
    write(attached, formatAgent(attached));
    return;
  }
  if (group === "demo" && (action === "plan" || action === "publish")) {
    const forwarded = process.argv.slice(4).filter((item, index, all) => {
      if (item === "--json" || item === "--help") return false;
      if (item === "--registry" || all[index - 1] === "--registry")
        return false;
      return true;
    });
    if (json) forwarded.push("--json");
    process.stdout.write(runDemoCli([action, ...forwarded]));
    return;
  }
  if (group === "model") {
    const { runModelCommand } = await import("../../runtime/modelCommand.mjs");
    let result: { ok: boolean; body: unknown; text: string };
    try {
      result = await runModelCommand({
        action,
        rest,
        flags: parsed.flags,
        cwd: process.cwd(),
      });
    } catch (error) {
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "DEPLOYMENT_FAILED";
      const message =
        error instanceof Error ? error.message : "The model command failed.";
      throw new KrakenError(code, message);
    }
    write(result.body, result.text);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (group === "context" && action === "export") {
    const exported = await app.exportContext({
      agentId: requiredPositional(
        rest,
        0,
        "Usage: kraken context export <agent> --output <path>",
      ),
      output: requiredString(
        parsed.flags,
        "output",
        "Option --output is required. Example: --output ./exports/helper.md",
      ),
    });
    write(exported, formatExport(exported));
    return;
  }
  throw new KrakenError(
    "USAGE",
    `Unknown command ${[group, action].filter(Boolean).join(" ")}. Run kraken --help for command syntax.`,
  );
}

main().catch((error: unknown) => {
  const formatted = formatThrown(error);
  const code = error instanceof KrakenError ? error.code : "INTERNAL";
  const message =
    error instanceof Error ? error.message : "The command failed.";
  process.stderr.write(
    wantsJson
      ? `${JSON.stringify({ ok: false, code, message })}\n`
      : `${formatted}\n`,
  );
  process.exitCode = 1;
});
