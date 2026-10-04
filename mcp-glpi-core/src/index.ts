/**
 * @nextoolsolutions/mcp-glpi-core
 *
 * Shared infrastructure for the GLPI MCP server (mcp-glpi, API v1 and v2 families):
 * HTTP transport with retry/timeout, typed errors, MCP tool-result helpers,
 * write policy, payload formatting, pagination and create idempotency.
 *
 * Consumed by @nextoolsolutions/mcp-glpi as a semver dependency; inside the repo
 * its lockfile links this folder. Run `npm run build` here after editing: the
 * server loads the compiled `dist/` through that node_modules symlink.
 */

export * from "./errors.js";
export * from "./format.js";
export * from "./http.js";
export * from "./idempotency.js";
export * from "./pagination.js";
export * from "./policy.js";
export * from "./result.js";
export * from "./server-format.js";
export * from "./server-idempotency.js";
export * from "./server-policy.js";
