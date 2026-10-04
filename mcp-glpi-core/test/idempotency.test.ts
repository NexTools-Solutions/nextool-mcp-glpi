import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IdempotencyStore, idempotencyKey, isCreateTool } from "../src/idempotency.js";
import { installIdempotency } from "../src/server-idempotency.js";

describe("idempotencyKey", () => {
  it("is stable regardless of key order", () => {
    const a = idempotencyKey("https://glpi", "glpi_create_ticket", { input: { name: "x", content: "y" } });
    const b = idempotencyKey("https://glpi", "glpi_create_ticket", { input: { content: "y", name: "x" } });
    assert.equal(a, b);
  });

  it("separates instances, tools and payloads", () => {
    const base = idempotencyKey("https://a", "glpi_create_ticket", { input: { name: "x" } });
    assert.notEqual(base, idempotencyKey("https://b", "glpi_create_ticket", { input: { name: "x" } }));
    assert.notEqual(base, idempotencyKey("https://a", "glpi_create_problem", { input: { name: "x" } }));
    assert.notEqual(base, idempotencyKey("https://a", "glpi_create_ticket", { input: { name: "z" } }));
  });

  it("ignores presentation-only arguments", () => {
    const a = idempotencyKey("https://a", "glpi_create_ticket", { input: { name: "x" } });
    const b = idempotencyKey("https://a", "glpi_create_ticket", {
      input: { name: "x" },
      fields: "all",
      format: "markdown",
      reason: "whatever",
    });
    assert.equal(a, b);
  });
});

describe("isCreateTool", () => {
  it("covers create_ and add_ on both servers", () => {
    assert.equal(isCreateTool("glpi_create_ticket"), true);
    assert.equal(isCreateTool("glpi_add_followup"), true);
    assert.equal(isCreateTool("glpi_v2_create_ticket"), true);
    assert.equal(isCreateTool("glpi_v2_add_task"), true);
    assert.equal(isCreateTool("glpi_update_ticket"), false);
    assert.equal(isCreateTool("glpi_list_tickets"), false);
    assert.equal(isCreateTool("glpi_delete_entity"), false);
  });
});

describe("IdempotencyStore", () => {
  it("returns a stored value inside the window", () => {
    const store = new IdempotencyStore(60_000);
    store.set("k", { id: 1 });
    assert.deepEqual(store.get("k"), { hit: true, value: { id: 1 } });
  });

  it("forgets an entry once the window passes", async () => {
    const store = new IdempotencyStore(10);
    store.set("k", { id: 1 });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(store.get("k").hit, false);
    assert.equal(store.size, 0, "expired entries must not accumulate");
  });

  it("is a no-op when the window is zero", () => {
    const store = new IdempotencyStore(0);
    assert.equal(store.enabled, false);
    store.set("k", { id: 1 });
    assert.equal(store.get("k").hit, false);
  });
});

class FakeServer {
  tools = new Map<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>();
  registerTool(name: string, _c: Record<string, unknown>, handler: (a: Record<string, unknown>) => Promise<unknown>) {
    this.tools.set(name, { handler });
  }
}

function okResult(id: number) {
  return { content: [{ type: "text", text: "{}" }], structuredContent: { data: { id } } };
}

describe("installIdempotency", () => {
  it("replays a repeated create instead of running it again", async () => {
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi" });
    server.registerTool("glpi_create_ticket", {}, async () => okResult(++calls));

    const h = server.tools.get("glpi_create_ticket")!.handler;
    const args = { input: { name: "x" } };
    const first = (await h(args)) as { structuredContent: Record<string, unknown> };
    const second = (await h(args)) as { structuredContent: Record<string, unknown> };

    assert.equal(calls, 1, "the handler must run once");
    assert.deepEqual(first.structuredContent.data, { id: 1 });
    assert.deepEqual(second.structuredContent.data, { id: 1 });
    assert.equal(second.structuredContent.replayed, true);
    assert.equal(first.structuredContent.replayed, undefined, "the first call is not a replay");
  });

  it("collapses concurrent identical creates", async () => {
    // Regression: the MCP server handles requests concurrently, so two
    // identical creates arriving together both found an empty store and
    // produced two tickets (523 and 524) against a live GLPI.
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi" });
    server.registerTool("glpi_create_ticket", {}, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return okResult(calls);
    });

    const h = server.tools.get("glpi_create_ticket")!.handler;
    const args = { input: { name: "x" } };
    const [a, b] = (await Promise.all([h(args), h(args)])) as {
      structuredContent: Record<string, unknown>;
    }[];

    assert.equal(calls, 1, "a concurrent retry must not create a second record");
    assert.deepEqual(a.structuredContent.data, { id: 1 });
    assert.deepEqual(b.structuredContent.data, { id: 1 });
  });

  it("lets different payloads through", async () => {
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi" });
    server.registerTool("glpi_create_ticket", {}, async () => okResult(++calls));

    const h = server.tools.get("glpi_create_ticket")!.handler;
    await h({ input: { name: "x" } });
    await h({ input: { name: "y" } });
    assert.equal(calls, 2);
  });

  it("does not remember failures", async () => {
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi" });
    server.registerTool("glpi_create_ticket", {}, async () => {
      calls++;
      return { content: [{ type: "text", text: "boom" }], isError: true };
    });

    const h = server.tools.get("glpi_create_ticket")!.handler;
    await h({ input: { name: "x" } });
    await h({ input: { name: "x" } });
    assert.equal(calls, 2, "a failed create must stay retryable");
  });

  it("leaves non-create tools alone", async () => {
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi" });
    server.registerTool("glpi_update_ticket", {}, async () => okResult(++calls));

    const h = server.tools.get("glpi_update_ticket")!.handler;
    await h({ ticketId: 1 });
    await h({ ticketId: 1 });
    assert.equal(calls, 2);
  });

  it("keys per instance, so two GLPIs never share a create", async () => {
    const serverA = new FakeServer();
    const serverB = new FakeServer();
    let calls = 0;
    const shared = new IdempotencyStore(60_000);
    installIdempotency(serverA, { instance: "https://a", store: shared });
    installIdempotency(serverB, { instance: "https://b", store: shared });
    serverA.registerTool("glpi_create_ticket", {}, async () => okResult(++calls));
    serverB.registerTool("glpi_create_ticket", {}, async () => okResult(++calls));

    await serverA.tools.get("glpi_create_ticket")!.handler({ input: { name: "x" } });
    await serverB.tools.get("glpi_create_ticket")!.handler({ input: { name: "x" } });
    assert.equal(calls, 2);
  });

  it("does nothing when the window is disabled", async () => {
    const server = new FakeServer();
    let calls = 0;
    installIdempotency(server, { instance: "https://glpi", store: new IdempotencyStore(0) });
    server.registerTool("glpi_create_ticket", {}, async () => okResult(++calls));

    const h = server.tools.get("glpi_create_ticket")!.handler;
    await h({ input: { name: "x" } });
    await h({ input: { name: "x" } });
    assert.equal(calls, 2);
  });
});
