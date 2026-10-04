/**
 * Installs create idempotency on an MCP server.
 *
 * Same approach as the write policy and the formatter: wrap `registerTool`
 * once. Only create/add tools are guarded, and a replayed result is marked
 * `replayed: true` so the caller can tell it did not create anything new.
 *
 * In-flight calls matter as much as finished ones. The MCP server handles
 * requests concurrently, so an agent that fires a retry before the first
 * response arrives reaches the guard twice with an empty store — exactly the
 * case this exists to stop (verified against a live GLPI: two identical
 * creates arriving together produced tickets 523 and 524). Identical arguments
 * therefore join the pending promise instead of starting a second create.
 */

import { IdempotencyStore, idempotencyKey, isCreateTool } from "./idempotency.js";

import { extendSchema } from "./server-format.js";
import type { RegistrableServer, ToolConfigLike, ToolHandlerLike } from "./server-policy.js";

interface ToolResultLike {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function isToolResult(v: unknown): v is ToolResultLike {
  return typeof v === "object" && v !== null && Array.isArray((v as ToolResultLike).content);
}

export interface IdempotencyOptions {
  /** Identifies the GLPI instance, so two instances never share a key. */
  instance: string;
  store?: IdempotencyStore;
  /** Extra tool names to guard beyond the create_/add_ prefixes. */
  extraTools?: string[];
  /**
   * Zod schema for the `replayed` flag (e.g. z.boolean().optional()), added to
   * each guarded tool's outputSchema so validating clients accept a replay.
   */
  replayedSchema?: unknown;
}

/** Marks a replayed result, in both the structured payload and the text. */
export function markReplayed(result: unknown): unknown {
  if (!isToolResult(result) || result.isError) return result;
  const structured = { ...(result.structuredContent ?? {}), replayed: true };
  return {
    ...result,
    structuredContent: structured,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
  };
}

export function installIdempotency(server: object, opts: IdempotencyOptions): IdempotencyStore {
  const target = server as RegistrableServer;
  const store = opts.store ?? new IdempotencyStore();
  const extra = new Set(opts.extraTools ?? []);
  const original = target.registerTool.bind(target);

  if (!store.enabled) return store;

  /** Calls that have not answered yet, keyed the same way as the store. */
  const inFlight = new Map<string, Promise<unknown>>();

  target.registerTool = (name: string, config: ToolConfigLike, handler: ToolHandlerLike) => {
    if (!isCreateTool(name) && !extra.has(name)) return original(name, config, handler);

    const guarded: ToolHandlerLike = async (args, extraArg) => {
      const key = idempotencyKey(opts.instance, name, args ?? {});

      const done = store.get(key);
      if (done.hit) return markReplayed(done.value);

      const pending = inFlight.get(key);
      if (pending) return markReplayed(await pending);

      const promise = Promise.resolve(handler(args, extraArg)).then((result) => {
        // Only successful creates are remembered: a failure must be retryable.
        if (isToolResult(result) && !result.isError) store.set(key, result);
        return result as unknown;
      });

      inFlight.set(key, promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(key);
      }
    };

    const guardedConfig: ToolConfigLike =
      config.outputSchema && opts.replayedSchema
        ? { ...config, outputSchema: extendSchema(config.outputSchema, { replayed: opts.replayedSchema }) }
        : config;
    return original(name, guardedConfig, guarded);
  };

  return store;
}
