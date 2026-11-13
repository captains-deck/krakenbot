import readline from "node:readline";
import type { KrakenApp } from "../services/app.js";
import { UiController } from "./controller.js";

export async function runUi(
  app: KrakenApp,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const ui = new UiController(app);
  const paint = (): void => {
    const body = `${ui.render()}\n`;
    if (stdin.isTTY) stdout.write(`\u001b[2J\u001b[H${body}> ${ui.buffer}`);
    else stdout.write(`${body}\n`);
  };
  paint();
  if (!stdin.isTTY) {
    const lines = readline.createInterface({
      input: stdin,
      output: stdout,
      terminal: false,
    });
    for await (const line of lines) {
      const done = await ui.command(line);
      paint();
      if (done) break;
    }
    lines.close();
    return;
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (data: Buffer): void => {
        void (async () => {
          try {
            const text = data.toString("utf8");
            if (text === "\u0003") {
              stdin.off("data", onData);
              process.exitCode = 130;
              resolve();
              return;
            }
            const done = await ui.input(text);
            paint();
            if (done) {
              stdin.off("data", onData);
              resolve();
            }
          } catch (error) {
            reject(
              error instanceof Error ? error : new Error("UI input failed"),
            );
          }
        })();
      };
      stdin.on("data", onData);
    });
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }
}
