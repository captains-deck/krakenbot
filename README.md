# KrakenBot

KrakenBot is a local orchestrator for [WormVolt](../WormVolt) vaults. It
provisions a vault, stores DevVolt prompt revisions, defines an agent, attaches
an explicit slice of context and exports a handoff bundle. The same application
services back the CLI and the terminal UI.

This proof of concept does not call a model provider, open a network service or
require credentials. Defining an agent does not launch one.

## Relationship to WormVolt

`volt.json` stays a WormVolt schemaVersion 1 definition. KrakenBot parses it
with `@wormvolt/core` and checks read, write and share through WormVolt's
`requirePermission`. Profile, working directory, timestamps, context entry
points, role labels and integration declarations live in `kraken.json` because
WormVolt rejects unknown keys. The decision record is
[docs/decisions/0001-krakenbot-and-wormvolt.md](docs/decisions/0001-krakenbot-and-wormvolt.md).

Generated vaults stay in manual autonomy with no worm connections. Prompt
revision files are KrakenBot history, not Git history and not WormVolt
propagation snapshots.

## Setup

Requirements: Node.js 24 and pnpm 11.19.0. This repo expects the WormVolt
checkout as a sibling directory, `../WormVolt`, because `@wormvolt/core` is a
`file:` dependency. If pnpm is not on your path:

```sh
corepack pnpm --version
```

From this directory:

```sh
pnpm install
pnpm check
```

`check` runs Prettier, TypeScript and the tests. Tests use temporary directories
and synthetic files.

Run the CLI with:

```sh
pnpm exec kraken --help
```

The workspace registry defaults to `./.kraken/registry.json`. Override it with
`--registry <file>` or `KRAKEN_REGISTRY`. Created vaults stay in that registry
across process restarts.

## Walkthrough

From an empty working directory:

```sh
pnpm exec kraken volt create my-notes --profile basic --path "./volts/my notes" --purpose "Project knowledge"
pnpm exec kraken volt create project-dev --profile dev --path ./volts/project-dev --workdir ./repo --purpose "Development context"
pnpm exec kraken volt create helper-context --profile agent --path ./volts/helper-context --purpose "Helper context"
pnpm exec kraken volt list
pnpm exec kraken volt inspect project-dev
pnpm exec kraken volt validate my-notes --json
```

`--dry-run` prints the file plan and writes nothing. Running the same create
command again keeps files you have edited.

Quote paths that contain spaces. The working directory is not filled with vault
files. When `--workdir` is omitted, it defaults to the vault path. The two paths
may be the same, and they must not contain each other.

Add a prompt to the DevVolt, then revise it. Earlier revision files stay as they
were:

```sh
printf 'Implement the feature.\n' > prompt.md
pnpm exec kraken prompt add project-dev --name implement-feature --file ./prompt.md
printf 'Implement the feature.\nName the files you change.\n' > prompt.md
pnpm exec kraken prompt revise project-dev implement-feature --file ./prompt.md --message "Clarify expected output"
```

Revisions are `prompts/implement-feature/revisions/r1.md`, `r2.md`, and so on.
`current.md` is the latest revision. This is not a Git history.

Define an agent and attach one file. A vault-wide pattern such as `**` is
rejected. `context/public.md` does not include `context/secret.md`.

```sh
printf 'Use only the attached context.\n' > instructions.md
printf 'Visible note\n' > "./volts/my notes/context/public.md"
pnpm exec kraken agent define helper --volt helper-context --instructions ./instructions.md
pnpm exec kraken agent attach helper --context my-notes --include context/public.md --access read
pnpm exec kraken context export helper --output "./exports/helper context.md"
```

The export says that the agent was not launched and that a model was not called.
It also states that exported instructions do not enforce restrictions on an
external assistant after handoff. WormVolt read and share checks run while the
files are selected. After the bundle exists, KrakenBot does not control what an
external assistant does with it. The command refuses to overwrite the output
path.

Open the terminal UI on the same services:

```sh
pnpm exec kraken ui
```

Inside it: `create`, `profile basic`, `name`, `purpose`, `path`, `workdir`,
`preview`, `confirm`, `list`, `open <id>`, `validate <id>`, `agents`, and
`export <agent> <output>`. Arrow keys move through menus in an interactive
terminal. `back` returns to the menu and `quit` leaves. After confirm, the
screen shows the next useful command.

## Layout

A vault is a directory of Markdown and JSON. Obsidian can open it. KrakenBot
does not require Obsidian or a plugin.

```text
<vault-root>/
  volt.json
  kraken.json
  README.md
  knowledge/
  context/
  working-memory/
  agent-definitions/
  provisioning/
  history/
  archive/
```

DevVolt also has `briefs/`, `prompts/`, `decisions/` and `handovers/`. AgentVolt
also has `instructions/`, `sessions/` and `handovers/`. Starter files explain
what belongs in each folder. `provisioning/state.json` is written only after
those files are in place, and the registry is updated after that.

`knowledge/welcome.md` is a WormVolt record. Other notes in `context/` are
ordinary Markdown. A link in a note does not grant access to its target.

## What is implemented

- Shared provisioning for Basic WormVolt, DevVolt and AgentVolt.
- CLI and keyboard terminal UI over one service layer.
- Dry run, create-if-absent repeat runs, and registry discovery after restart.
- Clear failures for invalid ids, incompatible files, nested paths, symlinks and
  incomplete provisioning.
- Immutable DevVolt prompt revisions with a change description.
- Agent definitions, explicit context attachment, and a manual handoff export
  that omits files outside the include pattern.
- WormVolt permission checks for read, share and, when requested, write.
- Tests against temporary vaults.
- `kraken model` for a pinned local release. See [docs/model-deployment.md](docs/model-deployment.md).

The local operator is the trusted principal `kraken-operator` in the `owner`
group. Group names in `volt.json` do not authenticate anyone. That matches
WormVolt's host-supplied principal.

## Deferred

Cloud model hosting, autonomous worm sync, multi-agent scheduling, remote
development-agent execution, Git integration, and moving a vault without
editing its absolute paths. Local Sentient Potato deployment is a separate
command; see [docs/model-deployment.md](docs/model-deployment.md). Command Chest, Captain's Deck and Helm
are not separate runtimes here. A future provider adapter can sit beside the
manual handoff renderer and call the same services. It should not invent a
second policy engine.
