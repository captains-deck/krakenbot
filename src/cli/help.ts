const ROOT = `KrakenBot provisions WormVolt vaults and prepares agent context handoffs.

Usage:
  kraken volt create <id> --profile <basic|dev|agent> --path <path> [--workdir <path>] [--purpose <text>] [--dry-run]
  kraken volt provision-captains <id> --path <path> --type <scratch|development> --title <text> --environment <id> --environment-title <text> [--description <text>] [--project <id> --project-title <text>] [--mission <id> --mission-title <text>] [--modules <ids>] [--dry-run]
  kraken volt list
  kraken volt inspect <id-or-path>
  kraken volt validate <id-or-path>
  kraken prompt add <devvolt> --name <prompt-id> --file <path>
  kraken prompt revise <devvolt> <prompt-id> --file <path> --message <text>
  kraken agent define <name> --volt <agentvolt> --instructions <path>
  kraken agent attach <name> --context <volt> --include <pattern> --access <read|read-write>
  kraken context export <agent> --output <path>
  kraken ui

Profiles are one WormVolt resource, not three products:
  basic  General knowledge and working context
  dev    DevVolt briefs, prompts, decisions and handovers
  agent  AgentVolt definition and explicit context

Defining or attaching an agent does not launch it. Context export writes a manual handoff.

Global options:
  --registry <file>   Workspace registry. Defaults to ./.kraken/registry.json or KRAKEN_REGISTRY
  --json              JSON for list, inspect, validate and other command results
  --help              Show help for the current command

Quote include patterns so the shell does not expand them: --include 'context/**'
Run kraken <command> --help for that command.
`;

const TOPICS: Record<string, string> = {
  volt: `kraken volt

  create <id> --profile <basic|dev|agent> --path <path> [--workdir <path>] [--purpose <text>] [--dry-run]
      Provision a vault. Repeat the same command to fill gaps without overwriting edits.
  provision-captains <id> --path <path> --type <scratch|development> --title <text> --environment <id> --environment-title <text>
      Write the Captain’s Volt template. This does not use basic, dev or agent profiles and does not invent a vault root.
      Repeat the command to fill missing files without overwriting edits.
  list
      Show vaults recorded in the registry.
  inspect <id-or-path>
      Show the WormVolt definition, orchestration manifest, agents and prompts.
  validate <id-or-path>
      Check the definition, layout and completion marker.

Ids use lowercase letters, digits and hyphens, for example my-notes.
--dry-run prints the file plan and writes nothing.
`,
  prompt: `kraken prompt

  add <devvolt> --name <prompt-id> --file <path>
      Store a prompt as immutable revision r1.
  revise <devvolt> <prompt-id> --file <path> --message <text>
      Append the next revision and keep earlier revision files unchanged.

Prompt revision history is not Git history. These commands require a DevVolt.
`,
  agent: `kraken agent

  define <name> --volt <agentvolt> --instructions <path>
      Copy instructions into an AgentVolt and record status defined.
  attach <name> --context <volt> --include <pattern> --access <read|read-write>
      Record an explicit context selection. This does not copy the context vault
      and does not grant the rest of that vault.

Neither command launches an agent or calls a model provider.
`,
  context: `kraken context

  export <agent> --output <path>
      Write a manual handoff bundle for a defined agent.
      The bundle lists selected files, hashes and prompt revisions.
      Files outside the include patterns are omitted.
      WormVolt read and share permission is required on each source.
      The output file is not overwritten.

Exported instructions do not enforce restrictions on an external assistant after handoff.
`,
  ui: `kraken ui

Open the keyboard interface on the same services as the other commands.
Type help inside the interface for vault, create, validate, agent and export commands.
Arrows move through menus when the terminal is interactive.
`,
};

export function helpText(topic: string | undefined): string {
  if (topic && TOPICS[topic]) return TOPICS[topic];
  return ROOT;
}
