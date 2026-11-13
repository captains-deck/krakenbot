import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  link,
  rename,
  unlink,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { KrakenError } from "../errors.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function pathKind(
  path: string,
): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Resolve a user path without following a symlink at the requested location. */
export async function canonicalPath(
  cwd: string,
  input: string,
): Promise<string> {
  if (input.trim().length === 0) {
    throw new KrakenError("INVALID_PATH", "A path is required.");
  }
  const abs = resolve(cwd, input);
  if (abs.includes("\0")) {
    throw new KrakenError(
      "INVALID_PATH",
      "The path contains a null character.",
    );
  }
  const kind = await pathKind(abs);
  if (kind === "symlink") {
    throw new KrakenError(
      "UNSAFE_PATH",
      `${abs} is a symlink. Choose the real directory so provisioning cannot follow a link.`,
    );
  }
  if (kind !== "missing") return realpath(abs);

  const missing: string[] = [];
  let cursor = abs;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    missing.push(basename(cursor));
    const parentKind = await pathKind(parent);
    if (parentKind === "missing") {
      cursor = parent;
      continue;
    }
    if (parentKind === "symlink") {
      throw new KrakenError(
        "UNSAFE_PATH",
        `${parent} is a symlink. Choose a real parent directory.`,
      );
    }
    if (parentKind === "file") {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${parent} is a file, so ${abs} cannot be created inside it.`,
      );
    }
    if (parentKind !== "directory") {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${parent} cannot contain ${abs}.`,
      );
    }
    return join(await realpath(parent), ...missing.reverse());
  }
}

export function pathsConflict(
  vaultRoot: string,
  workingDirectory: string,
): boolean {
  if (vaultRoot === workingDirectory) return false;
  return (
    isInside(vaultRoot, workingDirectory) ||
    isInside(workingDirectory, vaultRoot)
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
}

export function insideVault(root: string, relativePath: string): string {
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new KrakenError(
      "UNSAFE_PATH",
      "A vault-relative path must stay inside the vault.",
    );
  }
  const abs = resolve(root, relativePath);
  const rel = relative(root, abs);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new KrakenError(
      "UNSAFE_PATH",
      "A vault-relative path must stay inside the vault.",
    );
  }
  return abs;
}

export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new KrakenError("FILE_NOT_FOUND", `${path} was not found.`);
    }
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KrakenError(
      "INVALID_JSON",
      `${path} is not valid JSON. Fix the file and retry.`,
    );
  }
}

export async function readUserText(
  path: string,
  label: string,
  maxBytes: number,
): Promise<string> {
  const abs = resolve(path);
  let handle;
  try {
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new KrakenError(
        "FILE_NOT_FOUND",
        `${label} was not found at ${abs}. Check the path and retry.`,
      );
    }
    if (code === "ELOOP" || code === "EMLINK") {
      throw new KrakenError(
        "UNSAFE_PATH",
        `${label} must be a regular file, not a symlink.`,
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new KrakenError("INVALID_PATH", `${label} must be a regular file.`);
    }
    if (info.size > maxBytes) {
      throw new KrakenError(
        "FILE_TOO_LARGE",
        `${label} is larger than ${maxBytes} bytes. Split it or choose a smaller file.`,
      );
    }
    const bytes = await handle.readFile();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new KrakenError("FILE_NOT_TEXT", `${label} must be UTF-8 text.`);
    }
  } finally {
    await handle.close();
  }
}

export async function createIfAbsent(
  path: string,
  contents: string,
): Promise<"created" | "preserved"> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o644);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "preserved";
    if (code === "EISDIR") {
      throw new KrakenError(
        "INCOMPATIBLE_VAULT",
        `${path} is a directory and KrakenBot needs that path to be a file. Move it aside and retry.`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return "created";
}

export async function writeAtomic(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function createExclusive(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.kraken-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await link(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new KrakenError(
        "OUTPUT_EXISTS",
        `Refusing to overwrite ${path}. Choose a new --output path.`,
      );
    }
    throw error;
  }
  await unlink(temporary).catch(() => undefined);
}

export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  return files;
}

async function walk(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const abs = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, abs, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      entry.name.startsWith(".kraken-") ||
      entry.name.startsWith(".wormvolt-")
    )
      continue;
    files.push(relative(root, abs).split(sep).join("/"));
  }
}
