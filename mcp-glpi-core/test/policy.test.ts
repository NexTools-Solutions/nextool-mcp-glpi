import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_REASON_LENGTH,
  annotationsFor,
  checkOperation,
  classifyTool,
  describePolicy,
  loadWritePolicy,
  type WritePolicy,
} from "../src/policy.js";
import { installWritePolicy } from "../src/server-policy.js";

const OPEN: WritePolicy = { readOnly: false, allowDelete: true, requireDeleteReason: true };
const DEFAULT: WritePolicy = { readOnly: false, allowDelete: false, requireDeleteReason: true };
const LOCKED: WritePolicy = { readOnly: true, allowDelete: false, requireDeleteReason: true };

describe("loadWritePolicy", () => {
  it("defaults to read-write with deletes blocked", () => {
    assert.deepEqual(loadWritePolicy({}), DEFAULT);
  });

  it("reads the env flags", () => {
    assert.deepEqual(
      loadWritePolicy({ GLPI_READ_ONLY: "true", GLPI_ALLOW_DELETE: "1", GLPI_REQUIRE_DELETE_REASON: "no" }),
      { readOnly: true, allowDelete: true, requireDeleteReason: false },
    );
  });

  it("treats junk as the safe default", () => {
    assert.equal(loadWritePolicy({ GLPI_READ_ONLY: "maybe" }).readOnly, false);
    assert.equal(loadWritePolicy({ GLPI_ALLOW_DELETE: "" }).allowDelete, false);
  });
});

describe("classifyTool", () => {
  // Real tool names from both servers. Anything misfiled here would either
  // block a legitimate read or let a write through unguarded.
  const READS = [
    "glpi_list_tickets", "glpi_get_ticket", "glpi_search", "glpi_search_user_by_email",
    "glpi_list_search_options", "glpi_get_full_session", "glpi_get_my_entities",
    "glpi_get_my_profiles", "glpi_list_rule_ticket_criteria", "glpi_list_knowbase_items",
    "glpi_get_location", "glpi_list_document_items", "glpi_list_ticket_validations",
    "glpi_v2_list_tickets", "glpi_v2_get_ticket", "glpi_v2_get_me", "glpi_v2_health_check",
    "glpi_v2_list_timeline", "glpi_v2_download_document", "glpi_v2_list_team_members",
    "glpi_v2_get_session", "glpi_v2_list_rule_collections",
  ];
  const WRITES = [
    "glpi_create_ticket", "glpi_update_ticket", "glpi_add_followup", "glpi_add_solution",
    "glpi_add_ticket_user", "glpi_add_ticket_group", "glpi_add_ticket_task",
    "glpi_create_ticket_validation", "glpi_update_ticket_validation", "glpi_create_user",
    "glpi_update_user", "glpi_create_entity", "glpi_update_entity", "glpi_create_document",
    "glpi_create_document_item", "glpi_create_knowbase_item", "glpi_update_knowbase_item",
    "glpi_create_knowbase_category", "glpi_update_knowbase_category", "glpi_create_rule_ticket",
    "glpi_create_rule_criteria", "glpi_create_rule_action", "glpi_update_rule_action",
    "glpi_create_itil_followup_template", "glpi_update_itil_followup_template",
    "glpi_change_active_entities", "glpi_create_change", "glpi_update_change",
    "glpi_create_problem", "glpi_update_problem", "glpi_add_change_followup",
    "glpi_add_problem_followup", "glpi_add_change_solution", "glpi_add_problem_solution",
    "glpi_v2_create_ticket", "glpi_v2_update_ticket", "glpi_v2_add_followup",
    "glpi_v2_add_task", "glpi_v2_add_validation", "glpi_v2_update_validation",
    "glpi_v2_create_entity", "glpi_v2_update_entity", "glpi_v2_create_user",
    "glpi_v2_create_group", "glpi_v2_create_kb_article", "glpi_v2_update_kb_article",
    "glpi_v2_create_rule", "glpi_v2_create_document", "glpi_v2_add_team_member",
  ];
  const DESTRUCTIVE = [
    "glpi_delete_document", "glpi_delete_document_item", "glpi_delete_entity",
    "glpi_delete_knowbase_item", "glpi_delete_knowbase_category",
    "glpi_delete_ticket_validation", "glpi_delete_ticket_user", "glpi_delete_ticket_group",
    "glpi_v2_delete_entity", "glpi_v2_delete_ticket", "glpi_v2_remove_team_member",
  ];

  for (const name of READS) {
    it(`${name} is read`, () => assert.equal(classifyTool(name), "read"));
  }
  for (const name of WRITES) {
    it(`${name} is write`, () => assert.equal(classifyTool(name), "write"));
  }
  for (const name of DESTRUCTIVE) {
    it(`${name} is destructive`, () => assert.equal(classifyTool(name), "destructive"));
  }

  it("falls back to write for an unknown verb", () => {
    assert.equal(classifyTool("glpi_frobnicate_widget"), "write");
  });
});

describe("annotationsFor", () => {
  it("marks reads read-only and deletes destructive", () => {
    assert.equal(annotationsFor("read").readOnlyHint, true);
    assert.equal(annotationsFor("read").destructiveHint, false);
    assert.equal(annotationsFor("write").readOnlyHint, false);
    assert.equal(annotationsFor("destructive").destructiveHint, true);
  });
});

describe("checkOperation", () => {
  it("always allows reads, even read-only", () => {
    assert.equal(checkOperation(LOCKED, "read", "glpi_list_tickets"), null);
  });

  it("blocks writes on a read-only instance", () => {
    const msg = checkOperation(LOCKED, "write", "glpi_create_ticket");
    assert.match(String(msg), /read-only/);
    assert.match(String(msg), /Nothing was sent to GLPI/);
  });

  it("blocks deletes unless explicitly enabled", () => {
    const msg = checkOperation(DEFAULT, "destructive", "glpi_delete_entity", { reason: "a valid reason here" });
    assert.match(String(msg), /GLPI_ALLOW_DELETE/);
  });

  it("requires a substantial reason on deletes", () => {
    assert.match(String(checkOperation(OPEN, "destructive", "glpi_delete_entity", {})), /reason/);
    assert.match(String(checkOperation(OPEN, "destructive", "glpi_delete_entity", { reason: "oops" })), /reason/);
    assert.match(String(checkOperation(OPEN, "destructive", "glpi_delete_entity", { reason: "   spaces   " })), /reason/);
    assert.equal(
      checkOperation(OPEN, "destructive", "glpi_delete_entity", { reason: "duplicate entity created by mistake" }),
      null,
    );
  });

  it("skips the reason check when disabled", () => {
    const noReason = { ...OPEN, requireDeleteReason: false };
    assert.equal(checkOperation(noReason, "destructive", "glpi_delete_entity", {}), null);
  });

  it("describes the policy for the startup log", () => {
    assert.match(describePolicy(LOCKED), /read-only/);
    assert.match(describePolicy(DEFAULT), /deletes blocked/);
    assert.match(describePolicy(OPEN), /deletes ENABLED/);
  });
});

// ---------------------------------------------------------------------------
// installWritePolicy — the wrapper actually applied to the MCP servers
// ---------------------------------------------------------------------------

class FakeServer {
  tools = new Map<string, { config: Record<string, unknown>; handler: (a: Record<string, unknown>) => unknown }>();
  registerTool(name: string, config: Record<string, unknown>, handler: (a: Record<string, unknown>) => unknown) {
    this.tools.set(name, { config, handler });
  }
}

/** Stand-in for z.string().min(10), enough for the schema-extension path. */
const fakeReasonSchema = { _tag: "reason" };

function fakeZodObject(shape: Record<string, unknown>) {
  return {
    shape,
    extend(extra: Record<string, unknown>) {
      return fakeZodObject({ ...shape, ...extra });
    },
  };
}

describe("installWritePolicy", () => {
  it("adds annotations derived from the tool name", () => {
    const server = new FakeServer();
    installWritePolicy(server, { policy: OPEN, reasonSchema: fakeReasonSchema });
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({}) }, async () => "ok");
    server.registerTool("glpi_delete_entity", { inputSchema: fakeZodObject({}) }, async () => "ok");

    assert.equal((server.tools.get("glpi_list_tickets")!.config.annotations as Record<string, unknown>).readOnlyHint, true);
    assert.equal((server.tools.get("glpi_delete_entity")!.config.annotations as Record<string, unknown>).destructiveHint, true);
  });

  it("adds a reason field to destructive tools only", () => {
    const server = new FakeServer();
    installWritePolicy(server, { policy: OPEN, reasonSchema: fakeReasonSchema });
    server.registerTool("glpi_delete_entity", { inputSchema: fakeZodObject({ entityId: 1 }) }, async () => "ok");
    server.registerTool("glpi_get_entity", { inputSchema: fakeZodObject({ entityId: 1 }) }, async () => "ok");

    const del = server.tools.get("glpi_delete_entity")!.config.inputSchema as { shape: Record<string, unknown> };
    const get = server.tools.get("glpi_get_entity")!.config.inputSchema as { shape: Record<string, unknown> };
    assert.equal(del.shape.reason, fakeReasonSchema);
    assert.equal(get.shape.reason, undefined);
  });

  it("blocks the handler before it reaches GLPI", async () => {
    const server = new FakeServer();
    let called = false;
    installWritePolicy(server, { policy: LOCKED, reasonSchema: fakeReasonSchema });
    server.registerTool("glpi_create_ticket", { inputSchema: fakeZodObject({}) }, async () => {
      called = true;
      return "created";
    });

    const r = (await server.tools.get("glpi_create_ticket")!.handler({})) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(called, false, "handler must not run under a read-only policy");
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /read-only/);
  });

  it("lets reads through under a read-only policy", async () => {
    const server = new FakeServer();
    installWritePolicy(server, { policy: LOCKED, reasonSchema: fakeReasonSchema });
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({}) }, async () => "listed");
    assert.equal(await server.tools.get("glpi_list_tickets")!.handler({}), "listed");
  });

  it("honours explicit kind overrides", async () => {
    const server = new FakeServer();
    installWritePolicy(server, {
      policy: LOCKED,
      reasonSchema: fakeReasonSchema,
      kindOverrides: { glpi_frobnicate_widget: "read" },
    });
    server.registerTool("glpi_frobnicate_widget", { inputSchema: fakeZodObject({}) }, async () => "ok");
    assert.equal(await server.tools.get("glpi_frobnicate_widget")!.handler({}), "ok");
  });

  it("requires the reason at call time, not just in the schema", async () => {
    const server = new FakeServer();
    installWritePolicy(server, { policy: OPEN, reasonSchema: fakeReasonSchema });
    server.registerTool("glpi_delete_entity", { inputSchema: fakeZodObject({}) }, async () => "deleted");
    const handler = server.tools.get("glpi_delete_entity")!.handler;

    const blocked = (await handler({ entityId: 3 })) as { isError?: boolean };
    assert.equal(blocked.isError, true);

    assert.equal(await handler({ entityId: 3, reason: "duplicate entity created by mistake" }), "deleted");
  });

  it("keeps MIN_REASON_LENGTH in sync with the guard", () => {
    assert.equal(MIN_REASON_LENGTH, 10);
  });
});
