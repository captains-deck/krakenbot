import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPlan } from "./captainsVoltPlan.mjs";

/**
 * Writes a Captain’s Volt plan to a real filesystem root.
 * Existing files are left unchanged so a retry can resume.
 */
export async function provisionCaptainsFilesystem(input) {
  const root = path.resolve(input.cwd || process.cwd(), input.path || "");
  const now = new Date().toISOString();
  const plan = buildPlan({
    voltId: input.voltId,
    title: input.title,
    description: input.description || "",
    voltType: input.voltType,
    modules: input.modules || [],
    environment: input.environment,
    project: input.project || null,
    mission: input.mission || null,
    creationRequestId: input.creationRequestId || "cr-localcli0001",
    krakenRunId: input.krakenRunId || "kr-localcli0001",
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    storage: { kind: "filesystem", root },
  });
  const files = plan.files.map((file) => file.path);
  if (input.dryRun) return { voltId: input.voltId, written: [], preserved: [], dryRun: true, files, templateVersion: plan.templateVersion };
  const written = [];
  const preserved = [];
  for (const file of plan.files) {
    const target = path.resolve(root, file.path);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      const error = new Error("A planned file escaped the vault root.");
      error.code = "INVALID_PATH";
      throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, file.contents, { flag: "wx" });
      written.push(file.path);
    } catch (error) {
      if (error && error.code === "EEXIST") preserved.push(file.path);
      else throw error;
    }
  }
  return { voltId: input.voltId, written, preserved, dryRun: false, files, templateVersion: plan.templateVersion };
}
