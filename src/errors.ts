import { ZodError } from "zod";

export class KrakenError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KrakenError";
    this.code = code;
  }
}

export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "value";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function asKrakenError(error: unknown, fallback: string): KrakenError {
  if (error instanceof KrakenError) return error;
  if (error instanceof ZodError)
    return new KrakenError(fallback, formatZod(error));
  if (error instanceof Error && error.message.length > 0) {
    return new KrakenError(fallback, error.message);
  }
  return new KrakenError(fallback, "The operation could not be completed.");
}
