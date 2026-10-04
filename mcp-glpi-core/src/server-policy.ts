/**
 * Installs the write policy on an MCP server.
 *
 * Rather than editing all 144 `server.registerTool(...)` call sites across the
 * two servers (and hoping nobody forgets the next one), this wraps
 * `registerTool` once, right after the server is constructed. Every tool
 * registered afterwards — present or future — gets:
 *
 *   1. MCP annotations derived from its name (title, readOnlyHint,
 *      destructiveHint, idempotentHint, openWorldHint: false);
 *   2. a mandatory `reason` field on destructive tools;
 *   3. a policy check that runs before the handler touches GLPI.
 *
 * Classification is by tool name (see policy.ts `classifyTool`), with unknown
 * verbs treated as writes. The test suite asserts the kind of every real tool
 * name, so a misclassification fails CI rather than leaking a write.
 *
 * The zod schema for `reason` is injected by the caller so the core does not
 * depend on zod (and cannot end up with a second, incompatible copy of it).
 */

import {
  annotationsFor,
  checkOperation,
  classifyTool,
  titleFromToolName,
  type OperationKind,
  type WritePolicy,
} from "./policy.js";
import { toolResult } from "./result.js";

/** Structural type of the bits of McpServer we touch. */
export interface RegistrableServer {
  registerTool(name: string, config: ToolConfigLike, handler: ToolHandlerLike): unknown;
}

export interface ToolConfigLike {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}

export type ToolHandlerLike = (args: Record<string, unknown>, extra?: unknown) => unknown;

interface ExtendableSchema {
  extend(shape: Record<string, unknown>): unknown;
}

function isExtendable(schema: unknown): schema is ExtendableSchema {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { extend?: unknown }).extend === "function"
  );
}

/** Adds `reason` to a tool's input schema (ZodObject or raw shape). */
function withReason(inputSchema: unknown, reasonSchema: unknown): unknown {
  if (isExtendable(inputSchema)) return inputSchema.extend({ reason: reasonSchema });
  if (typeof inputSchema === "object" && inputSchema !== null) {
    return { ...(inputSchema as Record<string, unknown>), reason: reasonSchema };
  }
  return inputSchema;
}

export interface InstallOptions {
  policy: WritePolicy;
  /** Zod schema for the destructive `reason` field, e.g. z.string().min(10). */
  reasonSchema: unknown;
  /** Overrides for tools whose name does not reflect what they do. */
  kindOverrides?: Record<string, OperationKind>;
}

/**
 * Wraps `server.registerTool`. Call once, before registering any tool.
 * Returns the classification applied, for logging and tests.
 *
 * `server` is typed as `object` because McpServer.registerTool is generic over
 * the zod schemas of each tool; no structural type can describe it without
 * pulling the SDK into this package. The cast is contained here.
 */
export function installWritePolicy(
  server: object,
  opts: InstallOptions,
): Map<string, OperationKind> {
  const target = server as RegistrableServer;
  const { policy, reasonSchema, kindOverrides = {} } = opts;
  const registered = new Map<string, OperationKind>();
  const original = target.registerTool.bind(target);

  target.registerTool = (name: string, config: ToolConfigLike, handler: ToolHandlerLike) => {
    const kind = kindOverrides[name] ?? classifyTool(name);
    registered.set(name, kind);

    const guardedConfig: ToolConfigLike = {
      ...config,
      annotations: {
        title: config.title ?? titleFromToolName(name),
        ...annotationsFor(kind, name),
        ...(config.annotations ?? {}),
      },
    };

    if (kind === "destructive" && policy.requireDeleteReason && config.inputSchema !== undefined) {
      guardedConfig.inputSchema = withReason(config.inputSchema, reasonSchema);
    }

    const guardedHandler: ToolHandlerLike = (args, extra) => {
      const blocked = checkOperation(policy, kind, name, args);
      if (blocked) return toolResult(blocked, true);
      return handler(args, extra);
    };

    return original(name, guardedConfig, guardedHandler);
  };

  return registered;
}
