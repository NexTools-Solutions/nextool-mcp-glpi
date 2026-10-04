import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRIORITY_MAP,
  RESOURCES,
  TICKET_STATUS_MAP,
  registerResources,
} from "../src/resources.js";
import { buildPrompts, registerPrompts } from "../src/prompts.js";

describe("resources", () => {
  it("exposes the catalogues an agent needs before composing a ticket", () => {
    const uris = RESOURCES.map((r) => r.uri);
    assert.deepEqual(uris, [
      "glpi://entities",
      "glpi://itil-categories",
      "glpi://request-types",
      "glpi://code-maps",
    ]);
  });

  it("documents every resource it registers", () => {
    for (const r of RESOURCES) {
      assert.ok(r.title.length > 0, `${r.uri} needs a title`);
      assert.ok(r.description.length > 20, `${r.uri} needs a usable description`);
      assert.match(r.uri, /^glpi:\/\//);
    }
  });

  it("carries the code maps the API cannot return", async () => {
    const maps = (await RESOURCES.find((r) => r.uri === "glpi://code-maps")!.load(
      {} as never,
    )) as Record<string, Record<string, string>>;
    assert.equal(maps.ticket_status["5"], "Solved");
    assert.equal(maps.ticket_type["1"], "Incident");
    assert.equal(maps.actor_type["2"], "Assigned");
    assert.equal(maps.validation_status["3"], "Refused");
    // urgency and impact share the priority scale in GLPI.
    assert.deepEqual(maps.urgency, PRIORITY_MAP);
    assert.deepEqual(maps.impact, PRIORITY_MAP);
    assert.equal(Object.keys(TICKET_STATUS_MAP).length, 6);
  });

  it("registers each resource once, with json mime type", () => {
    const seen: { name: string; uri: string; metadata: Record<string, unknown> }[] = [];
    const server = {
      registerResource(name: string, uri: string, metadata: Record<string, unknown>) {
        seen.push({ name, uri, metadata });
      },
    };
    registerResources(server, {} as never);
    assert.equal(seen.length, RESOURCES.length);
    for (const s of seen) assert.equal(s.metadata.mimeType, "application/json");
  });

  it("returns an error payload instead of throwing when GLPI is unreachable", async () => {
    const handlers: ((uri: URL) => Promise<{ contents: { text: string }[] }>)[] = [];
    const server = {
      registerResource(
        _n: string,
        _u: string,
        _m: Record<string, unknown>,
        read: (uri: URL) => Promise<{ contents: { text: string }[] }>,
      ) {
        handlers.push(read);
      },
    };
    registerResources(server, {} as never);

    // glpi://entities hits the API and will fail with an empty config.
    const out = await handlers[0](new URL("glpi://entities"));
    const parsed = JSON.parse(out.contents[0].text);
    assert.ok("error" in parsed, "a failed load must surface as an error payload");
  });
});

describe("prompts", () => {
  const schemas = { ticketId: {}, optionalText: {}, requiredText: {} };

  it("stays a short, purposeful catalogue", () => {
    const prompts = buildPrompts(schemas);
    assert.ok(prompts.length <= 5, "a long prompt catalogue is dead weight");
    assert.deepEqual(prompts.map((p) => p.name), [
      "triage_ticket",
      "investigate_recurrence",
      "requester_history",
      "asset_context",
    ]);
  });

  it("names real tools in every prompt body", () => {
    for (const p of buildPrompts(schemas)) {
      const body = p.build({ ticket_id: "1", user: "x", asset_type: "Computer", asset_id: "2" });
      assert.match(body, /glpi_[a-z_]+/, `${p.name} should point at concrete tools`);
    }
  });

  it("interpolates its arguments", () => {
    const prompts = buildPrompts(schemas);
    const triage = prompts.find((p) => p.name === "triage_ticket")!;
    assert.match(triage.build({ ticket_id: 4242 }), /ticket 4242/);

    const recurrence = prompts.find((p) => p.name === "investigate_recurrence")!;
    assert.match(recurrence.build({ ticket_id: 7, keywords: "vpn drop" }), /vpn drop/);
    // The keywords clause disappears when not given, instead of leaving "undefined".
    assert.ok(!recurrence.build({ ticket_id: 7 }).includes("undefined"));
  });

  it("keeps the read-only prompts read-only", () => {
    const prompts = buildPrompts(schemas);
    for (const name of ["triage_ticket", "investigate_recurrence"]) {
      const body = prompts.find((p) => p.name === name)!.build({ ticket_id: "1" });
      assert.match(body, /Do not (modify|create)/, `${name} must not invite writes`);
    }
  });

  it("registers as user messages", () => {
    const built: { name: string; result: unknown }[] = [];
    const server = {
      registerPrompt(
        name: string,
        _m: Record<string, unknown>,
        build: (a: Record<string, unknown>) => unknown,
      ) {
        built.push({ name, result: build({ ticket_id: "1", user: "u", asset_type: "Computer", asset_id: "2" }) });
      },
    };
    registerPrompts(server, buildPrompts(schemas));
    assert.equal(built.length, 4);
    const first = built[0].result as { messages: { role: string; content: { type: string } }[] };
    assert.equal(first.messages[0].role, "user");
    assert.equal(first.messages[0].content.type, "text");
  });
});
