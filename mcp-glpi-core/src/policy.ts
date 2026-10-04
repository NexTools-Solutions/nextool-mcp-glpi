/**
 * Write policy for the GLPI MCP servers.
 *
 * Instances of these servers often point at production GLPI. Before this
 * module every tool —
 * including the eight glpi_delete_* ones — ran unguarded, and the servers
 * advertised no MCP annotations, so clients had no way to know which calls
 * were destructive.
 *
 * Environment tunables:
 *   GLPI_READ_ONLY            — "true" blocks every write and destructive tool
 *   GLPI_ALLOW_DELETE         — "true" enables destructive tools (default off)
 *   GLPI_REQUIRE_DELETE_REASON — "false" drops the mandatory reason (default on)
 */

export type OperationKind = "read" | "write" | "destructive";

export interface WritePolicy {
  readOnly: boolean;
  allowDelete: boolean;
  requireDeleteReason: boolean;
}

/** Minimum length of the `reason` a destructive call must carry. */
export const MIN_REASON_LENGTH = 10;

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function loadWritePolicy(env: NodeJS.ProcessEnv = process.env): WritePolicy {
  return {
    readOnly: boolEnv(env.GLPI_READ_ONLY, false),
    allowDelete: boolEnv(env.GLPI_ALLOW_DELETE, false),
    requireDeleteReason: boolEnv(env.GLPI_REQUIRE_DELETE_REASON, true),
  };
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Tool names that read but whose verb is not one of the read prefixes. */
const READ_EXACT = new Set([
  "glpi_search",
  "glpi_v2_search",
]);

const READ_PREFIXES = ["list_", "get_", "search_", "download_", "health_", "count_", "read_"];
const DESTRUCTIVE_PREFIXES = ["delete_", "purge_", "remove_"];

/** Strips the server prefix (`glpi_` / `glpi_v2_`) from a tool name. */
function verbOf(toolName: string): string {
  return toolName.replace(/^glpi_(?:v2_)?/, "");
}

/**
 * Classifies a tool by name. Unknown verbs fall back to `write` — the
 * conservative choice, so a tool added later is never silently treated as a
 * safe read. The full name-to-kind mapping is asserted in the test suite.
 */
export function classifyTool(toolName: string): OperationKind {
  if (READ_EXACT.has(toolName)) return "read";
  const verb = verbOf(toolName);
  if (DESTRUCTIVE_PREFIXES.some((p) => verb.startsWith(p))) return "destructive";
  if (READ_PREFIXES.some((p) => verb.startsWith(p))) return "read";
  return "write";
}

/** Write verbs that set fields to the values given: repeating the call changes nothing more. */
const IDEMPOTENT_WRITE_PREFIXES = ["update_", "set_"];

/**
 * Write verbs that only ADD records. The MCP spec defines destructiveHint=false as "performs only additive
 * updates", so every other write (update_, set_, change_, retry_ ...) overwrites or re-triggers something and
 * is flagged destructive. Store reviewers check that annotations are accurate.
 */
const ADDITIVE_WRITE_PREFIXES = ["create_", "add_"];

export interface ToolAnnotationHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * MCP tool annotations matching an operation kind (and, for idempotency, the
 * tool name):
 *   - read        → readOnlyHint, idempotent;
 *   - write       → not read-only; destructive unless additive (create_* /
 *                   add_*): update_*, set_* etc. overwrite existing data;
 *                   idempotent only for update_* / set_* (they overwrite fields
 *                   with the values given; creates and adds are not — see
 *                   idempotency.ts);
 *   - destructive → destructiveHint, idempotent (deleting twice leaves the
 *                   same state; the second call just fails).
 * openWorldHint is false: every tool talks to the one GLPI instance configured,
 * not to an open set of external systems.
 */
export function annotationsFor(kind: OperationKind, toolName?: string): ToolAnnotationHints {
  const verb = toolName ? verbOf(toolName) : "";
  return {
    readOnlyHint: kind === "read",
    destructiveHint:
      kind === "destructive" || (kind === "write" && !ADDITIVE_WRITE_PREFIXES.some((p) => verb.startsWith(p))),
    idempotentHint:
      kind === "read" ||
      kind === "destructive" ||
      IDEMPOTENT_WRITE_PREFIXES.some((p) => verb.startsWith(p)),
    openWorldHint: false,
  };
}

/** "glpi_v2_list_kb_articles" -> "List kb articles (API v2)": fallback title when a tool has none. */
export function titleFromToolName(toolName: string): string {
  const verb = verbOf(toolName).replace(/_/g, " ");
  const text = verb.charAt(0).toUpperCase() + verb.slice(1);
  return toolName.startsWith("glpi_v2_") ? `${text} (API v2)` : text;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Returns an error message when the policy blocks the call, or null when it may
 * proceed. Runs before any request reaches GLPI.
 */
export function checkOperation(
  policy: WritePolicy,
  kind: OperationKind,
  toolName: string,
  args?: Record<string, unknown>,
): string | null {
  if (kind === "read") return null;

  if (policy.readOnly) {
    return (
      `Blocked: this GLPI instance is configured read-only (GLPI_READ_ONLY=true), ` +
      `so ${toolName} cannot run. Nothing was sent to GLPI.`
    );
  }

  if (kind === "destructive") {
    if (!policy.allowDelete) {
      return (
        `Blocked: destructive tools are disabled on this instance. ` +
        `Set GLPI_ALLOW_DELETE=true in the instance env file to enable ${toolName}. ` +
        `Nothing was sent to GLPI.`
      );
    }
    if (policy.requireDeleteReason) {
      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      if (reason.length < MIN_REASON_LENGTH) {
        return (
          `Blocked: ${toolName} requires a "reason" of at least ${MIN_REASON_LENGTH} ` +
          `characters describing why the item is being deleted. Nothing was sent to GLPI.`
        );
      }
    }
  }

  return null;
}

/** Human-readable summary, logged to stderr on startup. */
export function describePolicy(policy: WritePolicy): string {
  if (policy.readOnly) return "read-only (writes and deletes blocked)";
  return policy.allowDelete
    ? `read-write, deletes ENABLED${policy.requireDeleteReason ? " (reason required)" : ""}`
    : "read-write, deletes blocked";
}
