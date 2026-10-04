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

/**
 * An error as an MCP tool result: the message in the text block, no
 * `structuredContent`. The MCP SDK client validates structuredContent against
 * the tool's outputSchema even when isError is set, so an `{ error }` object
 * there (as before 1.2.0) turned every GLPI error (404, 403...) into a client
 * protocol error ("Structured content does not match the tool's output
 * schema") once the client had listed the tools, hiding the actual message.
 */
export function errorResult(msg: string): ToolTextResult {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
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
