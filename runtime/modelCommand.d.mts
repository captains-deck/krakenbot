export function runModelCommand(input: {
  action: string | undefined;
  rest: string[];
  flags: Map<string, string | true>;
  cwd: string;
}): Promise<{ ok: boolean; body: unknown; text: string }>;
