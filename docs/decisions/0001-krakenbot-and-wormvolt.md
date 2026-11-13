# ADR 0001: KrakenBot beside WormVolt

Status: accepted for this local proof of concept.

## Context

WormVolt already defines a volt as Markdown plus a strict version-1 `volt.json`:
identity, purpose, knowledge location, record fields, audience, security groups,
action policy, autonomy and connection ids. `@wormvolt/core` parses that
document, evaluates `requirePermission`, and stores `markdown-json-v1` records.
Unknown keys are rejected. The local executor can propagate records only when
both volts are in `event` autonomy.

KrakenBot is the orchestrator for vaults, agent definitions and context
handoffs. It needs a profile, a working directory that may differ from the
vault, provisioning metadata, context entry points and an explicit agent
attachment list. Those facts do not fit the WormVolt definition, and this
milestone does not run WormVolt propagation or a model provider.

## Decision

KrakenBot is a separate Node.js 24 and pnpm project. It depends on the local
WormVolt checkout (`@wormvolt/core`) and does not modify that repository.

Every provisioned directory contains:

- `volt.json`, a WormVolt schemaVersion 1 definition produced and later checked
  with `parseVolt`. Policy decisions call `requirePermission`. KrakenBot does
  not reimplement group matching.
- `kraken.json`, a KrakenBot schemaVersion 1 orchestration manifest. It records
  the profile (`basic`, `dev` or `agent`), vault root, working directory,
  provisioning template version, timestamps, context entry points, role labels
  and integration declarations.

Role labels are not grants. A role id must name a WormVolt security group, and
the grants stay in `volt.json`. Integration declarations are stored only. None
are executed.

Generated vaults use manual autonomy, an empty `connections` list, and no
transform or publish grant. Background WormVolt transfer therefore stays denied
by WormVolt's own autonomy check. The local operator principal is
`kraken-operator` in the `owner` group. That is a trusted host identity, the
same kind of principal WormVolt already expects. It is not an account system.

Handoff export is not `VoltService.transfer`. WormVolt schemaVersion 1 has no
export action. KrakenBot treats leaving the vault as `read` plus `share`, which
are the existing actions, and checks them again at export time. `read-write`
also requires `write`, but this milestone only reads. A future WormVolt action
specifically for export would be a core schema change and is not assumed here.

Prompt history lives under `prompts/<id>/revisions/` because a WormVolt record
is an immutable create-if-absent snapshot, not a revisable document. Those files
are not Git commits. Knowledge records in `knowledge/` remain WormVolt's format
and are written with `LocalFilesystemStore` when the starter record is first
created.

The manual handoff adapter only renders a bundle from files the application
service has already selected. It has no execute method and does not call a
provider. Defining or attaching an agent writes a record whose status is
`defined`.

## Consequences

- A vault can be opened and edited without KrakenBot or Obsidian.
- Repeating provisioning uses create-if-absent and will not reset edited files.
- A vault is registered only after `provisioning/state.json` is written.
- Exported instructions do not constrain an external assistant after the bundle
  is written. The bundle says so.
- Moving a vault folder is not rewritten automatically. `kraken.json` and the
  registry keep absolute paths.
- Live provider execution, worm connections, background sync, Git, scheduling
  and remote connectors remain deferred. They should be new adapters that call
  these services, not a second policy engine.
