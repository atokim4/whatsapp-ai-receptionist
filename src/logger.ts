export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON line per event. Message bodies are never logged, phone numbers only masked. */
export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(line + "\n")): Logger {
  const log = (level: string) => (msg: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export function maskPhone(waId: string): string {
  return waId.length <= 4 ? "****" : `${"*".repeat(waId.length - 4)}${waId.slice(-4)}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
