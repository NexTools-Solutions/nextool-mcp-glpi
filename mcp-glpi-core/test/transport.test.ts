/**
 * Transport: injected fetch, redirect refusal, annotations derived from names.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { fetchFn, fetchWithTimeout, nodeFetch, type FetchImpl } from "../src/http.js";
import { GlpiHttpError, GlpiRedirectError } from "../src/errors.js";
import { annotationsFor, classifyTool, titleFromToolName } from "../src/policy.js";
import { installWritePolicy } from "../src/server-policy.js";

describe("fetchImpl injection", () => {
  it("uses the injected fetch and always asks for redirect: manual", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl: FetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response('{"ok":1}', { status: 200 });
    };
    const res = await fetchWithTimeout("https://glpi.example.com/apirest.php/Ticket", { method: "GET" }, impl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"ok":1}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, "manual");
    assert.ok(calls[0].init.signal, "the timeout signal is forwarded");
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`turns a ${status} into a typed error naming only the target host`, async () => {
      let calls = 0;
      const impl: FetchImpl = async () => {
        calls++;
        return new Response(null, {
          status,
          headers: { Location: "https://attacker.example:8443/steal?token=secret" },
        });
      };
      await assert.rejects(
        fetchFn("https://glpi.example.com/apirest.php/initSession?x=1", { method: "POST" }, impl),
        (err: unknown) => {
          assert.ok(err instanceof GlpiRedirectError);
          assert.ok(err instanceof GlpiHttpError, "callers catching the base type still see it");
          assert.equal(err.status, status);
          assert.equal(err.method, "POST");
          assert.equal(err.path, "/apirest.php/initSession");
          assert.equal(err.targetHost, "attacker.example:8443");
          assert.equal(err.message, `redirect not followed: ${status} -> attacker.example:8443`);
          assert.ok(!err.message.includes("secret"), "Location path/query never reach the message");
          return true;
        },
      );
      assert.equal(calls, 1, "the redirect is not followed");
    });
  }

  it("resolves a relative Location against the request host", async () => {
    const impl: FetchImpl = async () => new Response(null, { status: 302, headers: { Location: "/login" } });
    await assert.rejects(fetchFn("https://glpi.example.com/x", {}, impl), /302 -> glpi\.example\.com$/);
  });

  it("reports a 3xx without Location", async () => {
    const impl: FetchImpl = async () => new Response(null, { status: 300 });
    await assert.rejects(fetchFn("https://glpi.example.com/x", {}, impl), /300 -> \(no Location header\)/);
  });
});

describe("default transport against a real server", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"fine":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it("global fetch: 302 is refused, not followed", async () => {
    await assert.rejects(fetchFn(`${base}/redirect`, { method: "GET" }), GlpiRedirectError);
    assert.deepEqual(hits.filter((h) => h === "/elsewhere"), []);
  });

  it("polyfill: 302 surfaces its Location for the same check", async () => {
    const res = await nodeFetch(`${base}/redirect`, { method: "GET" });
    assert.equal(res.status, 302);
    assert.equal(res.location, "http://127.0.0.1:1/elsewhere");
  });

  it("global fetch: a 200 passes through", async () => {
    const res = await fetchFn(`${base}/ok`, { method: "GET" });
    assert.equal(await res.text(), '{"fine":true}');
  });
});

describe("MCP annotations", () => {
  it("read tools are read-only, idempotent and open-world (the user's GLPI)", () => {
    assert.deepEqual(annotationsFor(classifyTool("glpi_get_ticket"), "glpi_get_ticket"), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("creates are writes, neither destructive nor idempotent", () => {
    assert.deepEqual(annotationsFor(classifyTool("glpi_create_ticket"), "glpi_create_ticket"), {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(annotationsFor("write", "glpi_add_followup").idempotentHint, false);
  });

  it("updates and setters are idempotent writes", () => {
    assert.equal(annotationsFor("write", "glpi_update_ticket").idempotentHint, true);
    assert.equal(annotationsFor("write", "glpi_v2_update_ticket").idempotentHint, true);
    assert.equal(annotationsFor("write", "glpi_set_webhook_active").idempotentHint, true);
    // MCP spec: destructiveHint=false means "only additive updates"; an update overwrites data
    assert.equal(annotationsFor("write", "glpi_update_ticket").destructiveHint, true);
    assert.equal(annotationsFor("write", "glpi_set_webhook_active").destructiveHint, true);
    assert.equal(annotationsFor("write", "glpi_retry_webhook_delivery").destructiveHint, true);
    assert.equal(annotationsFor("write", "glpi_add_followup").destructiveHint, false);
  });

  it("delete/purge/remove are destructive", () => {
    for (const name of ["glpi_delete_entity", "glpi_v2_delete_ticket", "glpi_v2_remove_team_member"]) {
      const a = annotationsFor(classifyTool(name), name);
      assert.equal(a.destructiveHint, true, name);
      assert.equal(a.readOnlyHint, false, name);
      assert.equal(a.openWorldHint, true, name);
    }
  });

  it("derives a readable title when a tool has none", () => {
    assert.equal(titleFromToolName("glpi_list_tickets"), "List tickets");
    assert.equal(titleFromToolName("glpi_v2_get_kb_article"), "Get kb article (API v2)");
  });

  it("installWritePolicy puts the hints and the title on the registered config", () => {
    const seen = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        seen.set(name, config);
      },
    };
    installWritePolicy(server, {
      policy: { readOnly: false, allowDelete: true, requireDeleteReason: false },
      reasonSchema: {},
    });
    const s = server as unknown as { registerTool: (n: string, c: Record<string, unknown>, h: () => unknown) => void };
    s.registerTool("glpi_get_ticket", { title: "Get ticket" }, () => undefined);
    s.registerTool("glpi_delete_document", {}, () => undefined);
    const get = seen.get("glpi_get_ticket")!.annotations as Record<string, unknown>;
    assert.equal(get.title, "Get ticket");
    assert.equal(get.readOnlyHint, true);
    assert.equal(get.openWorldHint, true);
    const del = seen.get("glpi_delete_document")!.annotations as Record<string, unknown>;
    assert.equal(del.title, "Delete document");
    assert.equal(del.destructiveHint, true);
    assert.equal(del.readOnlyHint, false);
  });
});
