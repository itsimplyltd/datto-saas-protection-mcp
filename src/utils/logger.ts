/**
 * Minimal structured logger for the HTTP transport. Writes one JSON line per
 * event to stderr (stdout belongs to the stdio transport). Callers must never
 * pass a secret, a credential, a header value or a request body in `meta`.
 */
import type { GatewayLogger } from "../itsl/s2s-v3.js";

export type Logger = GatewayLogger & { info(msg: string, meta?: Record<string, unknown>): void };

function emit(level: string, msg: string, meta?: Record<string, unknown>): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

export const logger: Logger = {
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
