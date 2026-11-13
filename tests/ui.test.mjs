import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { UiController } from "../dist/index.js";
import { appAt, tempRoot } from "./helpers.mjs";

test("the terminal session can create every profile and shows the next action", async (t) => {
  const root = await tempRoot(t);
  const ui = new UiController(appAt(root));
  const profiles = [
    ["basic", "my-notes", "Project knowledge"],
    ["dev", "project-dev", "Development context"],
    ["agent", "helper-context", "Helper context"],
  ];
  for (const [profile, name, purpose] of profiles) {
    await ui.command("create");
    await ui.command(`profile ${profile}`);
    await ui.command(`name ${name}`);
    await ui.command(`purpose ${purpose}`);
    await ui.command(`path ${join(root, "vaults", name)}`);
    await ui.command(`workdir ${join(root, "work", name)}`);
    await ui.command("preview");
    assert.match(ui.render(), /dry-run/);
    assert.match(ui.render(), /No files were written/);
    await ui.command("confirm");
    assert.match(ui.render(), /Next:/);
    assert.match(ui.render(), new RegExp(name));
  }
  await ui.command("list");
  const rendered = ui.render();
  assert.match(rendered, /my-notes/);
  assert.match(rendered, /project-dev/);
  assert.match(rendered, /helper-context/);
  await ui.command("open helper-context");
  assert.match(ui.render(), /does not launch|Define an agent/);
  await ui.command("validate project-dev");
  assert.match(ui.render(), /valid project-dev/);
});
