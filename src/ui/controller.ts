import { defaultPurpose, profileLabel } from "../domain/profiles.js";
import {
  formatAgent,
  formatExport,
  formatInspection,
  formatProvision,
  formatThrown,
  formatValidation,
  formatVaultList,
} from "../format.js";
import type { KrakenApp } from "../services/app.js";
import type { AgentView, Inspection, VaultSummary } from "../services/types.js";

const MENU = [
  ["list", "Vaults"],
  ["create", "Create vault"],
  ["validate", "Validate"],
  ["agents", "Agents and context"],
  ["export", "Export handoff"],
  ["quit", "Quit"],
] as const;

interface Draft {
  profile: string;
  name: string;
  purpose: string;
  path: string;
  workdir: string;
}

type Screen =
  | { kind: "menu"; index: number }
  | { kind: "list"; index: number; vaults: VaultSummary[] }
  | { kind: "detail"; inspection: Inspection }
  | { kind: "create"; draft: Draft; preview: string }
  | { kind: "validate"; body: string }
  | { kind: "agents"; index: number; agents: AgentView[] }
  | { kind: "message"; body: string };

function emptyDraft(): Draft {
  return { profile: "", name: "", purpose: "", path: "", workdir: "" };
}

export class UiController {
  buffer = "";
  private note = "";
  private screen: Screen = { kind: "menu", index: 0 };

  constructor(private readonly app: KrakenApp) {}

  render(): string {
    const parts = ["KrakenBot", ""];
    if (this.note) parts.push(this.note, "");
    parts.push(this.renderScreen(), "", this.footer());
    return parts.join("\n");
  }

  async input(chunk: string): Promise<boolean> {
    if (chunk === "\u001b[A")
      return this.command(this.buffer.length === 0 ? "up" : "");
    if (chunk === "\u001b[B")
      return this.command(this.buffer.length === 0 ? "down" : "");
    if (chunk === "\u001b") return this.command("back");
    if (chunk === "\u007f" || chunk === "\b") {
      this.buffer = this.buffer.slice(0, -1);
      return false;
    }
    if (chunk === "\r" || chunk === "\n") {
      const line = this.buffer;
      this.buffer = "";
      return this.command(line.length === 0 ? "enter" : line);
    }
    if (
      chunk === "q" &&
      this.buffer.length === 0 &&
      this.screen.kind === "menu"
    ) {
      return this.command("quit");
    }
    if (chunk.startsWith("\u001b")) return false;
    if ([...chunk].every((char) => char >= " " && char <= "~"))
      this.buffer += chunk;
    return false;
  }

  async command(line: string): Promise<boolean> {
    const { cmd, arg } = splitOnce(line.trim());
    if (cmd.length === 0) return false;
    if (cmd === "quit" || cmd === "q") return true;
    try {
      if (cmd === "help") {
        this.note = helpNote();
        return false;
      }
      if (cmd === "back") {
        this.screen = { kind: "menu", index: 0 };
        return false;
      }
      if (cmd === "list" || cmd === "vaults") {
        await this.showList();
        return false;
      }
      if (cmd === "create") {
        this.screen = { kind: "create", draft: emptyDraft(), preview: "" };
        this.note =
          "Choose a profile, then set name, purpose, path and workdir.";
        return false;
      }
      if (cmd === "validate") {
        await this.showValidation(arg);
        return false;
      }
      if (cmd === "agents") {
        await this.showAgents();
        return false;
      }
      if (cmd === "open") {
        await this.showDetail(arg);
        return false;
      }
      if (cmd === "export") {
        await this.showExport(arg);
        return false;
      }
      if (this.isCreateCommand(cmd)) {
        if (this.screen.kind !== "create") {
          this.screen = { kind: "create", draft: emptyDraft(), preview: "" };
        }
        await this.createCommand(cmd, arg);
        return false;
      }
      if (this.screen.kind === "menu") return await this.menuCommand(cmd);
      if (this.screen.kind === "list") return await this.listCommand(cmd);
      if (this.screen.kind === "agents") return this.agentCommand(cmd);
      if (cmd === "up" || cmd === "down" || cmd === "enter") return false;
      this.note = `Unknown command ${cmd}. Type help.`;
      return false;
    } catch (error) {
      this.note = formatThrown(error);
      return false;
    }
  }

  private renderScreen(): string {
    const screen = this.screen;
    if (screen.kind === "menu") {
      return MENU.map(
        (item, index) =>
          `${index === screen.index ? ">" : " "} ${index + 1}. ${item[1]}`,
      ).join("\n");
    }
    if (screen.kind === "list") {
      if (screen.vaults.length === 0)
        return formatVaultList(screen.vaults).trimEnd();
      return screen.vaults
        .map(
          (vault, index) =>
            `${index === screen.index ? ">" : " "} ${vault.id}  ${vault.profile}  ${vault.available ? "available" : "missing"}`,
        )
        .join("\n");
    }
    if (screen.kind === "detail")
      return formatInspection(screen.inspection).trimEnd();
    if (screen.kind === "validate") return screen.body;
    if (screen.kind === "message") return screen.body.trimEnd();
    if (screen.kind === "agents") {
      if (screen.agents.length === 0) {
        return "No agents are defined.\nDefine one with: kraken agent define <name> --volt <agentvolt> --instructions <file>\nDefining an agent does not launch it.";
      }
      const lines = screen.agents.map(
        (agent, index) =>
          `${index === screen.index ? ">" : " "} ${agent.id}  defined  not running  ${agent.voltId}`,
      );
      const selected = screen.agents[screen.index];
      if (selected)
        lines.push(
          "",
          formatAgent({ status: "unchanged", agent: selected }).trimEnd(),
        );
      return lines.join("\n");
    }
    const profile = screen.draft.profile;
    const known =
      profile === "basic" || profile === "dev" || profile === "agent";
    return [
      "Create vault",
      `Profile: ${profile || "(required: basic, dev or agent)"}`,
      known
        ? `${profileLabel(profile)} — ${defaultPurpose(profile)}`
        : "basic: general context    dev: briefs and prompts    agent: definition and handoff",
      `Name: ${screen.draft.name || "(required id, for example my-notes)"}`,
      `Purpose: ${screen.draft.purpose || "(optional; a profile default is used)"}`,
      `Path: ${screen.draft.path || "(required)"}`,
      `Working directory: ${screen.draft.workdir || "(optional; defaults to the vault path)"}`,
      screen.preview ? `\n${screen.preview.trimEnd()}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  private footer(): string {
    return [
      "Commands: help, list, create, validate <id>, agents, export <agent> <output>, quit",
      "Create: profile <basic|dev|agent>, name <id>, purpose <text>, path <path>, workdir <path>, preview, confirm",
      "up/down move, enter selects, back returns to the menu",
    ].join("\n");
  }

  private async menuCommand(cmd: string): Promise<boolean> {
    if (this.screen.kind !== "menu") return false;
    if (cmd === "up") {
      this.screen.index = (this.screen.index + MENU.length - 1) % MENU.length;
      return false;
    }
    if (cmd === "down") {
      this.screen.index = (this.screen.index + 1) % MENU.length;
      return false;
    }
    const numbered = /^[1-6]$/.test(cmd)
      ? Number(cmd) - 1
      : cmd === "enter"
        ? this.screen.index
        : -1;
    if (numbered >= 0 && numbered < MENU.length) {
      const item = MENU[numbered];
      if (!item) return false;
      if (item[0] === "quit") return true;
      return this.command(item[0]);
    }
    this.note = `Unknown command ${cmd}. Type help.`;
    return false;
  }

  private async listCommand(cmd: string): Promise<boolean> {
    if (this.screen.kind !== "list") return false;
    if (this.screen.vaults.length === 0) {
      this.note = "No vaults yet. Type create.";
      return false;
    }
    if (cmd === "up") {
      this.screen.index =
        (this.screen.index + this.screen.vaults.length - 1) %
        this.screen.vaults.length;
      return false;
    }
    if (cmd === "down") {
      this.screen.index = (this.screen.index + 1) % this.screen.vaults.length;
      return false;
    }
    if (cmd === "enter") {
      const selected = this.screen.vaults[this.screen.index];
      if (selected) await this.showDetail(selected.id);
      return false;
    }
    this.note = `Unknown command ${cmd}. Type help.`;
    return false;
  }

  private agentCommand(cmd: string): boolean {
    if (this.screen.kind !== "agents" || this.screen.agents.length === 0)
      return false;
    if (cmd === "up") {
      this.screen.index =
        (this.screen.index + this.screen.agents.length - 1) %
        this.screen.agents.length;
      return false;
    }
    if (cmd === "down") {
      this.screen.index = (this.screen.index + 1) % this.screen.agents.length;
      return false;
    }
    this.note = `Unknown command ${cmd}. Type help.`;
    return false;
  }

  private async createCommand(cmd: string, arg: string): Promise<void> {
    if (this.screen.kind !== "create") return;
    const draft = this.screen.draft;
    if (cmd === "profile") {
      if (arg !== "basic" && arg !== "dev" && arg !== "agent") {
        this.note = "Profile must be basic, dev or agent.";
        return;
      }
      draft.profile = arg;
      this.note = "";
      return;
    }
    if (
      cmd === "name" ||
      cmd === "purpose" ||
      cmd === "path" ||
      cmd === "workdir"
    ) {
      if (arg.length === 0) {
        this.note = `${cmd} needs a value.`;
        return;
      }
      if (cmd === "name") draft.name = arg;
      if (cmd === "purpose") draft.purpose = arg;
      if (cmd === "path") draft.path = arg;
      if (cmd === "workdir") draft.workdir = arg;
      this.note = "";
      return;
    }
    if (cmd === "preview" || cmd === "confirm") {
      if (
        draft.profile.length === 0 ||
        draft.name.length === 0 ||
        draft.path.length === 0
      ) {
        this.note = "Set profile, name and path before preview or confirm.";
        return;
      }
      const result = await this.app.createVolt({
        id: draft.name,
        profile: draft.profile,
        path: draft.path,
        purpose: draft.purpose.length > 0 ? draft.purpose : null,
        workdir: draft.workdir.length > 0 ? draft.workdir : null,
        dryRun: cmd === "preview",
      });
      const text = formatProvision(result);
      if (cmd === "preview") {
        this.screen.preview = text;
        this.note = "Preview only. Type confirm to provision this vault.";
        return;
      }
      this.note = "";
      this.screen = { kind: "message", body: text };
    }
  }

  private async showList(): Promise<void> {
    const vaults = await this.app.listVolts();
    this.screen = { kind: "list", index: 0, vaults };
    this.note = "";
  }

  private async showDetail(ref: string): Promise<void> {
    if (ref.length === 0) {
      this.note = "Usage: open <id-or-path>";
      return;
    }
    const inspection = await this.app.inspectVolt(ref);
    this.screen = { kind: "detail", inspection };
    this.note = "";
  }

  private async showValidation(ref: string): Promise<void> {
    if (ref.length === 0) {
      this.screen = {
        kind: "validate",
        body: "Validate a vault with: validate <id-or-path>",
      };
      return;
    }
    const report = await this.app.validateVolt(ref);
    this.screen = {
      kind: "validate",
      body: formatValidation(report).trimEnd(),
    };
    this.note = "";
  }

  private async showAgents(): Promise<void> {
    const agents = await this.app.listAgents();
    this.screen = { kind: "agents", index: 0, agents };
    this.note =
      agents.length === 0 ? "" : "These agents are defined. None are running.";
  }

  private async showExport(arg: string): Promise<void> {
    const { cmd: agentId, arg: output } = splitOnce(arg);
    if (agentId.length === 0 || output.length === 0) {
      this.note = "Usage: export <agent> <output>";
      this.screen = {
        kind: "message",
        body: "Export writes a manual handoff and does not launch the agent.\nUsage: export <agent> <output>",
      };
      return;
    }
    const result = await this.app.exportContext({ agentId, output });
    this.note = "";
    this.screen = { kind: "message", body: formatExport(result) };
  }

  private isCreateCommand(cmd: string): boolean {
    return (
      cmd === "profile" ||
      cmd === "name" ||
      cmd === "purpose" ||
      cmd === "path" ||
      cmd === "workdir" ||
      cmd === "preview" ||
      cmd === "confirm"
    );
  }
}

function splitOnce(value: string): { cmd: string; arg: string } {
  const index = value.indexOf(" ");
  if (index === -1) return { cmd: value, arg: "" };
  return { cmd: value.slice(0, index), arg: value.slice(index + 1).trim() };
}

function helpNote(): string {
  return [
    "list shows registered vaults. open <id> shows one vault.",
    "create starts a vault. Set profile, name, purpose, path and workdir, then preview and confirm.",
    "validate <id> checks the WormVolt definition and completion marker.",
    "agents shows definitions. A definition is not a running agent.",
    "export <agent> <output> writes a manual handoff.",
    "back returns to the menu. quit leaves.",
  ].join("\n");
}
