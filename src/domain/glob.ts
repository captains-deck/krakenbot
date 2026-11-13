import { KrakenError } from "../errors.js";

const ALLOWED_PREFIXES = [
  "context/",
  "knowledge/",
  "briefs/",
  "prompts/",
  "decisions/",
  "handovers/",
  "working-memory/",
  "instructions/",
  "sessions/",
] as const;

export function assertExplicitInclude(pattern: string): void {
  if (
    pattern.length === 0 ||
    pattern.length > 256 ||
    pattern.startsWith("/") ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    pattern
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new KrakenError(
      "INVALID_INCLUDE",
      "Include must be a relative pattern such as context/**. Absolute paths, blank segments and '..' are not allowed.",
    );
  }
  if (!/^[a-zA-Z0-9_.*\-/]+$/.test(pattern)) {
    throw new KrakenError(
      "INVALID_INCLUDE",
      "Include may contain only letters, numbers, '/', '.', '_', '-' and '*'. Quote the pattern so your shell does not expand it.",
    );
  }
  if (
    pattern === "*" ||
    pattern === "**" ||
    pattern === "**/*" ||
    pattern === "**/**"
  ) {
    throw new KrakenError(
      "IMPLICIT_CONTEXT",
      "Include must name an explicit location such as context/**. A vault-wide pattern is not allowed.",
    );
  }
  if (!ALLOWED_PREFIXES.some((prefix) => pattern.startsWith(prefix))) {
    throw new KrakenError(
      "IMPLICIT_CONTEXT",
      `Include must start with one of: ${ALLOWED_PREFIXES.join(", ")}. Attaching an agent does not grant the rest of the vault.`,
    );
  }
}

export function matchesInclude(pattern: string, relativePath: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source +=
      char !== undefined && "\\^$+?.()|[]{}".includes(char)
        ? `\\${char}`
        : char;
  }
  return new RegExp(`${source}$`);
}
