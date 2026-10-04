import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ESSENTIAL_FIELDS,
  formatPayload,
  pickFields,
  renderMarkdown,
  stripHtml,
  toMarkdownTable,
} from "../src/format.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationNote,
  resolveLimit,
  resolveRange,
} from "../src/pagination.js";
import { inferItemtype, installPayloadFormatting } from "../src/server-format.js";

describe("stripHtml", () => {
  it("decodes the double-escaped TinyMCE markup GLPI stores", () => {
    // Exactly what /Ticket/2 returns on the glpi-10-nextools instance.
    const raw = '&#60;div class="elementToProof"&#62;Teste&#60;/div&#62;';
    assert.equal(stripHtml(raw), "Teste");
  });

  it("keeps line structure from block tags", () => {
    assert.equal(stripHtml("<p>um</p><p>dois</p>"), "um\ndois");
    assert.equal(stripHtml("linha<br>outra"), "linha\noutra");
  });

  it("decodes named and numeric entities", () => {
    assert.equal(stripHtml("a &amp; b"), "a & b");
    assert.equal(stripHtml("a&nbsp;b"), "a b");
    assert.equal(stripHtml("&#233;"), "é");
  });

  it("renders list items readably", () => {
    assert.equal(stripHtml("<ul><li>um</li><li>dois</li></ul>"), "- um\n- dois");
  });

  it("passes plain text through and tolerates empties", () => {
    assert.equal(stripHtml("já resolvido"), "já resolvido");
    assert.equal(stripHtml(""), "");
  });
});

describe("pickFields", () => {
  // Field list taken from a real GLPI 10 ticket payload (45 fields).
  const ticket = {
    id: 2, entities_id: 0, name: "Teste", date: "2026-01-20 09:37:55", closedate: null,
    solvedate: "2026-01-20 09:47:14", takeintoaccountdate: "2026-01-20 09:37:55",
    date_mod: "2026-05-05 10:07:52", users_id_lastupdater: 30, status: 5,
    users_id_recipient: 7, requesttypes_id: 1, content: "&#60;p&#62;Teste&#60;/p&#62;",
    urgency: 3, impact: 3, priority: 3, itilcategories_id: 0, type: 1, global_validation: 1,
    slas_id_ttr: 0, slas_id_tto: 0, slalevels_id_ttr: 0, time_to_resolve: null,
    time_to_own: null, begin_waiting_date: null, sla_waiting_duration: 0,
    ola_waiting_duration: 0, olas_id_tto: 0, olas_id_ttr: 0, olalevels_id_ttr: 0,
    ola_tto_begin_date: null, ola_ttr_begin_date: null, internal_time_to_resolve: null,
    internal_time_to_own: null, waiting_duration: 0, close_delay_stat: 0,
    solve_delay_stat: 559, takeintoaccount_delay_stat: 0, actiontime: 0, is_deleted: 0,
    locations_id: 0, validation_percent: 0, date_creation: "2026-01-20 09:37:55",
    stsync_id: null, links: [{ rel: "Entity" }],
  };

  it("drops the SLA/OLA and delay-stat block from tickets", () => {
    const out = pickFields("Ticket", ticket, "essential");
    const keys = Object.keys(out);
    assert.ok(keys.length < 25, `expected a trimmed payload, got ${keys.length} fields`);
    for (const gone of ["slas_id_ttr", "ola_waiting_duration", "solve_delay_stat", "links", "actiontime"]) {
      assert.ok(!(gone in out), `${gone} should have been dropped`);
    }
    for (const kept of ["id", "name", "status", "priority", "date_mod", "content"]) {
      assert.ok(kept in out, `${kept} should have been kept`);
    }
  });

  it("flattens richtext while filtering", () => {
    assert.equal(pickFields("Ticket", ticket, "essential").content, "Teste");
  });

  it("returns the payload untouched in 'all' mode", () => {
    assert.equal(Object.keys(pickFields("Ticket", ticket, "all")).length, Object.keys(ticket).length);
    assert.equal(pickFields("Ticket", ticket, "all").content, ticket.content);
  });

  it("falls back to the generic blocklist for unknown itemtypes", () => {
    const out = pickFields("PluginFooBar", ticket, "essential");
    assert.ok(!("sla_waiting_duration" in out));
    assert.ok(!("links" in out));
    // Nothing outside the blocklist is lost.
    assert.ok("stsync_id" in out, "plugin fields must survive on unknown itemtypes");
    assert.ok("takeintoaccountdate" in out);
  });

  it("never lists a whitelist without an id", () => {
    for (const [itemtype, fields] of Object.entries(ESSENTIAL_FIELDS)) {
      assert.ok(fields.includes("id"), `${itemtype} whitelist must include id`);
    }
  });
});

describe("formatPayload", () => {
  it("maps over arrays of items", () => {
    const rows = formatPayload("Ticket", [{ id: 1, links: [], name: "a" }], "essential") as Record<string, unknown>[];
    assert.deepEqual(rows, [{ id: 1, name: "a" }]);
  });

  it("leaves scalars and arrays of scalars alone", () => {
    assert.equal(formatPayload("Ticket", 7, "essential"), 7);
    assert.deepEqual(formatPayload("Ticket", [1, 2], "essential"), [1, 2]);
  });
});

describe("markdown rendering", () => {
  it("builds a table with the union of keys", () => {
    const md = toMarkdownTable([{ id: 1, name: "a" }, { id: 2, status: 5 }]);
    const lines = md.split("\n");
    assert.equal(lines[0], "| id | name | status |");
    assert.equal(lines[1], "| --- | --- | --- |");
    assert.equal(lines[2], "| 1 | a |  |");
    assert.equal(lines[3], "| 2 |  | 5 |");
  });

  it("escapes pipes and flattens newlines so the table survives", () => {
    const md = toMarkdownTable([{ name: "a | b", content: "one\ntwo" }]);
    assert.match(md, /a \\\| b/);
    assert.ok(!md.includes("one\ntwo"));
  });

  it("says so when there is nothing to show", () => {
    assert.equal(toMarkdownTable([]), "_No results._");
  });

  it("renders a single object as key/value lines", () => {
    assert.equal(renderMarkdown({ id: 1, name: "a" }), "**id**: 1\n**name**: a");
  });
});

describe("pagination", () => {
  it("applies a default range when none is given", () => {
    const r = resolveRange(undefined);
    assert.equal(r.range, `0-${DEFAULT_PAGE_SIZE - 1}`);
    assert.equal(r.defaulted, true);
  });

  it("honours an explicit range", () => {
    assert.deepEqual(resolveRange("10-19"), { range: "10-19", capped: false, defaulted: false });
  });

  it("caps oversized ranges", () => {
    const r = resolveRange("0-99999");
    assert.equal(r.capped, true);
    assert.equal(r.range, `0-${MAX_PAGE_SIZE - 1}`);
  });

  it("recovers from a malformed or inverted range", () => {
    assert.equal(resolveRange("abc").defaulted, true);
    assert.equal(resolveRange("50-10").range, `50-${50 + DEFAULT_PAGE_SIZE - 1}`);
  });

  it("resolves v2 limits the same way", () => {
    assert.equal(resolveLimit(undefined).limit, DEFAULT_PAGE_SIZE);
    assert.equal(resolveLimit(10).limit, 10);
    assert.equal(resolveLimit(99999).limit, MAX_PAGE_SIZE);
    assert.equal(resolveLimit(99999).capped, true);
    assert.equal(resolveLimit(0).defaulted, true);
  });

  it("warns only when the result was actually truncated", () => {
    assert.match(String(paginationNote(resolveRange("0-99999"), 200)), /capped/);
    assert.match(String(paginationNote(resolveRange(undefined), DEFAULT_PAGE_SIZE)), /default first/);
    assert.equal(paginationNote(resolveRange(undefined), 3), undefined);
    assert.equal(paginationNote(resolveRange("0-9"), 10), undefined);
  });
});

// ---------------------------------------------------------------------------
// installPayloadFormatting
// ---------------------------------------------------------------------------

class FakeServer {
  tools = new Map<string, { config: Record<string, unknown>; handler: (a: Record<string, unknown>) => unknown }>();
  registerTool(name: string, config: Record<string, unknown>, handler: (a: Record<string, unknown>) => unknown) {
    this.tools.set(name, { config, handler });
  }
}

function fakeZodObject(shape: Record<string, unknown>) {
  return {
    shape,
    extend(extra: Record<string, unknown>) {
      return fakeZodObject({ ...shape, ...extra });
    },
  };
}

const FORMAT_OPTS = { fieldsSchema: { _tag: "fields" }, formatSchema: { _tag: "format" } };

function jsonToolResult(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify({ data }, null, 2) }],
    structuredContent: { data },
  };
}

describe("inferItemtype", () => {
  it("prefers an explicit argument over the name map", () => {
    assert.equal(inferItemtype("glpi_search", { itemtype: "Computer" }), "Computer");
    assert.equal(inferItemtype("glpi_list_tickets", {}), "Ticket");
    assert.equal(inferItemtype("glpi_get_unknown_thing", {}), undefined);
  });
});

describe("installPayloadFormatting", () => {
  it("adds fields/format to read tools only", () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async () => jsonToolResult([]));
    server.registerTool("glpi_create_ticket", { inputSchema: fakeZodObject({ input: {} }) }, async () => jsonToolResult({}));

    const read = server.tools.get("glpi_list_tickets")!.config.inputSchema as { shape: Record<string, unknown> };
    const write = server.tools.get("glpi_create_ticket")!.config.inputSchema as { shape: Record<string, unknown> };
    assert.ok("fields" in read.shape && "format" in read.shape);
    assert.ok(!("fields" in write.shape), "write tools must not gain formatting params");
  });

  it("filters the payload and reports the count", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async () =>
      jsonToolResult([{ id: 1, name: "a", links: [], sla_waiting_duration: 0, content: "<p>x</p>" }]),
    );

    const r = (await server.tools.get("glpi_list_tickets")!.handler({})) as {
      structuredContent: { data: Record<string, unknown>[]; count: number };
    };
    assert.deepEqual(r.structuredContent.data, [{ id: 1, name: "a", content: "x" }]);
    assert.equal(r.structuredContent.count, 1);
  });

  it("injects the default range before calling the handler", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    let seen: unknown;
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async (args) => {
      seen = args.range;
      return jsonToolResult([]);
    });
    await server.tools.get("glpi_list_tickets")!.handler({});
    assert.equal(seen, `0-${DEFAULT_PAGE_SIZE - 1}`);
  });

  it("caps an oversized range the caller asked for", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    let seen: unknown;
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async (args) => {
      seen = args.range;
      return jsonToolResult([]);
    });
    await server.tools.get("glpi_list_tickets")!.handler({ range: "0-50000" });
    assert.equal(seen, `0-${MAX_PAGE_SIZE - 1}`);
  });

  it("respects fields=all", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_get_ticket", { inputSchema: fakeZodObject({ ticketId: {} }) }, async () =>
      jsonToolResult({ id: 1, links: [], content: "<p>x</p>" }),
    );
    const r = (await server.tools.get("glpi_get_ticket")!.handler({ fields: "all" })) as {
      structuredContent: { data: Record<string, unknown> };
    };
    assert.ok("links" in r.structuredContent.data);
    assert.equal(r.structuredContent.data.content, "<p>x</p>");
  });

  it("renders markdown text but keeps structuredContent parseable", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async () =>
      jsonToolResult([{ id: 1, name: "a" }]),
    );
    const r = (await server.tools.get("glpi_list_tickets")!.handler({ format: "markdown" })) as {
      content: { text: string }[];
      structuredContent: { data: unknown };
    };
    assert.match(r.content[0].text, /^\| id \| name \|/);
    assert.deepEqual(r.structuredContent.data, [{ id: 1, name: "a" }]);
  });

  it("leaves error results untouched", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_list_tickets", { inputSchema: fakeZodObject({ range: {} }) }, async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));
    const r = (await server.tools.get("glpi_list_tickets")!.handler({})) as { isError?: boolean };
    assert.equal(r.isError, true);
  });

  it("uses the itemtype argument when the tool is generic", async () => {
    const server = new FakeServer();
    installPayloadFormatting(server, FORMAT_OPTS);
    server.registerTool("glpi_search", { inputSchema: fakeZodObject({ itemtype: {}, range: {} }) }, async () =>
      jsonToolResult([{ id: 1, name: "pc-01", serial: "X", links: [], comment: "c", bogus: 1 }]),
    );
    const r = (await server.tools.get("glpi_search")!.handler({ itemtype: "Computer" })) as {
      structuredContent: { data: Record<string, unknown>[] };
    };
    assert.ok(!("bogus" in r.structuredContent.data[0]), "Computer whitelist should apply");
    assert.ok("serial" in r.structuredContent.data[0]);
  });
});

describe("inferItemtype scoping (regression)", () => {
  it("only reads the itemtype argument on generic tools", () => {
    // glpi_list_timeline takes itemtype "Ticket" but returns followups, tasks
    // and validations; applying the Ticket whitelist stripped them.
    assert.equal(inferItemtype("glpi_list_timeline", { itemtype: "Ticket" }), undefined);
    assert.equal(inferItemtype("glpi_search", { itemtype: "Computer" }), "Computer");
    assert.equal(inferItemtype("glpi_list_assets", { asset_type: "Monitor" }), "Monitor");
    assert.equal(inferItemtype("glpi_list_tickets", { itemtype: "Nonsense" }), "Ticket");
  });
});
