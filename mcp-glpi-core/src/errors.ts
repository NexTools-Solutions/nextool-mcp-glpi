/**
 * Shared error types for the GLPI MCP servers.
 *
 * Both mcp-glpi (REST v1) and mcp-glpi-v2 (API v2 / OAuth2) used to declare an
 * identical error class. They now extend this base so callers can catch a
 * single type while each server keeps its own `name` for readable messages.
 */

export class GlpiHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    name = "GlpiHttpError",
  ) {
    super(message);
    this.name = name;
  }
}

/** Raised when the write policy blocks an operation before it reaches GLPI. */
export class GlpiPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlpiPolicyError";
  }
}

/**
 * Raised when GLPI answers a request with a 3xx. Requests go out with
 * `redirect: "manual"`, so a redirect is never followed: following one would
 * send the session/OAuth headers to whatever host the Location names. Only the
 * target host is kept in the message — the Location path and query may carry
 * tokens.
 */
export class GlpiRedirectError extends GlpiHttpError {
  constructor(
    status: number,
    method: string,
    path: string,
    public readonly targetHost: string,
  ) {
    super(`redirect not followed: ${status} -> ${targetHost}`, status, method, path, "GlpiRedirectError");
  }
}
