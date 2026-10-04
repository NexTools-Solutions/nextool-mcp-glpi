/**
 * Create idempotency for the GLPI MCP servers.
 *
 * An agent that retries a create — after a timeout, a truncated response, or
 * simply because it lost track — opens a second ticket. GLPI has no idempotency
 * key, so the guard lives here: identical create arguments, within a short
 * window, on the same instance, return the first result instead of creating
 * again.
 *
 * The window is deliberately short. It exists to absorb retries, not to stop
 * someone legitimately opening two identical tickets an hour apart.
 *
 * Environment tunables:
 *   GLPI_IDEMPOTENCY_WINDOW — seconds (default 120; 0 disables the guard)
 */

import { createHash } from "node:crypto";

export const IDEMPOTENCY_WINDOW_MS = Math.max(
  0,
  parseInt(process.env.GLPI_IDEMPOTENCY_WINDOW ?? "120", 10) * 1000,
);

/** Argument names that must not take part in the key. */
const VOLATILE_ARGS = new Set(["reason", "fields", "format"]);

/**
 * Stable JSON: object keys sorted at every level, so argument order does not
 * change the key.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function idempotencyKey(
  instance: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!VOLATILE_ARGS.has(k)) filtered[k] = v;
  }
  const payload = JSON.stringify({ instance, toolName, args: canonical(filtered) });
  return createHash("sha256").update(payload).digest("hex");
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** In-process store. The stdio servers are long-lived, so memory is enough. */
export class IdempotencyStore {
  private entries = new Map<string, Entry>();

  constructor(private readonly windowMs: number = IDEMPOTENCY_WINDOW_MS) {}

  get enabled(): boolean {
    return this.windowMs > 0;
  }

  get(key: string): { hit: boolean; value?: unknown } {
    if (!this.enabled) return { hit: false };
    const e = this.entries.get(key);
    if (!e) return { hit: false };
    if (e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return { hit: false };
    }
    return { hit: true, value: e.value };
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;
    this.entries.set(key, { value, expiresAt: Date.now() + this.windowMs });
    this.sweep();
  }

  /** Drops expired entries so a long session does not grow unbounded. */
  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= now) this.entries.delete(k);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Tools whose repetition creates a duplicate record. */
export function isCreateTool(toolName: string): boolean {
  const verb = toolName.replace(/^glpi_(?:v2_)?/, "");
  return verb.startsWith("create_") || verb.startsWith("add_");
}
