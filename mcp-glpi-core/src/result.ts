/**
 * Shared MCP tool-result helpers for the GLPI MCP servers.
 *
 * mcp-glpi and mcp-glpi-v2 declared identical copies of toolResult/jsonResult/
 * errorResult/wrap. The only difference was the config validation message, so
 * `makeWrap` takes that as a parameter.
 */

export type ToolTextResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function toolResult(text: string, isError = false): ToolTextResult {
  return { content: [{ type: "text" as const, text }], isError };
}

/**
 * Wraps a payload as an MCP tool result.
 *
 * `structuredContent` must be a JSON object: an array there fails the tools'
 * `outputSchema` validation ("Expected object, received array"), which used to
 * break every v2 list tool. Arrays are therefore wrapped as `{ data: [...] }`,
 * matching what the v1 list tools already pass explicitly.
 */
export function jsonResult(obj: unknown): ToolTextResult {
  let safe: Record<string, unknown>;
  if (Array.isArray(obj)) {
    safe = { data: obj };
  } else if (typeof obj === "object" && obj !== null) {
    safe = obj as Record<string, unknown>;
  } else {
    safe = { value: obj };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe,
  };
}

export function errorResult(msg: string): ToolTextResult {
  return { ...jsonResult({ error: msg }), isError: true };
}

/**
 * Builds the `wrap()` helper used to register every tool.
 *
 * @param validateConfig returns an error message when the server is missing
 *        required environment variables, or null when it is ready.
 */
export function makeWrap(validateConfig: () => string | null) {
  return function wrap<A, R>(fn: (args: A) => Promise<R>) {
    return async (args: A): Promise<R | ToolTextResult> => {
      const configError = validateConfig();
      if (configError) return toolResult(configError, true);
      try {
        return await fn(args);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    };
  };
}
