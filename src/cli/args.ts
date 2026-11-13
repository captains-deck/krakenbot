import { KrakenError } from "../errors.js";

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const BOOLEANS = new Set(["help", "json", "dry-run"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(
        ...argv
          .slice(index + 1)
          .filter((item): item is string => item !== undefined),
      );
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      const name = body.slice(0, equals);
      flags.set(name, body.slice(equals + 1));
      continue;
    }
    if (BOOLEANS.has(body)) {
      flags.set(body, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new KrakenError(
        "USAGE",
        `Option --${body} needs a value. Run kraken --help for command syntax.`,
      );
    }
    flags.set(body, next);
    index += 1;
  }
  return { positionals, flags };
}

export function optionalString(
  flags: Map<string, string | true>,
  name: string,
): string | null {
  if (!flags.has(name)) return null;
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new KrakenError(
      "USAGE",
      `Option --${name} needs a value. Run kraken --help for command syntax.`,
    );
  }
  return value;
}

export function requiredString(
  flags: Map<string, string | true>,
  name: string,
  hint: string,
): string {
  const value = optionalString(flags, name);
  if (value === null) throw new KrakenError("USAGE", hint);
  return value;
}

export function requiredPositional(
  values: readonly string[],
  index: number,
  hint: string,
): string {
  const value = values[index];
  if (value === undefined || value.length === 0)
    throw new KrakenError("USAGE", hint);
  return value;
}
