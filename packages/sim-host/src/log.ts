// A tiny logger so library modules never touch the console directly. main.ts builds one over the
// console for startup and operational lines; everything else takes it as an argument. The logger
// redacts nothing by policy because nothing secret is ever passed to it: the bearer token lives only in
// the MCP transport headers and is never logged (see SECURITY.md).

export type Logger = {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

function line(level: string, message: string, fields?: Record<string, unknown>): string {
  const base = `${new Date().toISOString()} ${level} ${message}`;
  if (fields === undefined || Object.keys(fields).length === 0) return base;
  return `${base} ${JSON.stringify(fields)}`;
}

/** A console-backed logger. Used by main.ts only; library code receives a Logger, never console. */
export function consoleLogger(): Logger {
  return {
    info: (m, f) => console.error(line("info", m, f)),
    warn: (m, f) => console.error(line("warn", m, f)),
    error: (m, f) => console.error(line("error", m, f)),
  };
}
