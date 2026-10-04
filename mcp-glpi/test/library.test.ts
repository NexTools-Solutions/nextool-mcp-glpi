/**
 * Library API (M1): instanceFromConfig without process.env, injected fetch on
 * both API families, redirect refusal end to end, the v2 absolute-URL guard,
 * named toolsets and MCP annotations on every tool.
 *
 * GLPI is stubbed through `fetchImpl` and the server is driven by a real MCP
 * client over an in-memory transport, so what is asserted is what a client sees.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { classifyTool, type FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import {
  createGlpiServer,
  GlpiRedirectError,
  instanceFromConfig,
  instanceFromEnv,
  SERVER_VERSION,
  TOOLSETS,
  TOOLSET_NAMES,
  type InstanceConfig,
} from "../src/lib.js";
import { glpiV2Request, GlpiV2ApiError, resolveV2Url, type GlpiV2Config } from "../src/glpi-v2-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
/** Unique credentials per test: session/token caches are per credential. */
function uniq(label: string): string {
  return `${label}-${process.pid}-${++seq}`;
}

interface Call {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function connect(instance: InstanceConfig, fetchImpl?: FetchImpl) {
  const { server } = createGlpiServer(instance, fetchImpl ? { fetchImpl } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

type ToolCallResult = { isError?: boolean; content: { type: string; text: string }[] };

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as ToolCallResult;
}

/** Every tool name the server can register (both families, no filter). */
async function allToolNames(): Promise<string[]> {
  const client = await connect(
    instanceFromConfig({
      id: "all-tools",
      v1: { url: "https://glpi.example.com", userToken: "u" },
      v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: "n", password: "p" },
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

// ---------------------------------------------------------------------------
// instanceFromConfig
// ---------------------------------------------------------------------------

describe("instanceFromConfig", () => {
  it("builds an instance without reading process.env", () => {
    const saved = { ...process.env };
    process.env.GLPI_URL = "https://from-env.invalid";
    process.env.GLPI_USER_TOKEN = "env-token";
    process.env.GLPI_READ_ONLY = "true";
    process.env.GLPI_TOOLSETS = "admin";
    try {
      const inst = instanceFromConfig({
        id: "acme",
        v1: { url: "https://glpi.acme.example/", userToken: "cfg-token", appToken: "app" },
      });
      assert.equal(inst.v1.baseUrl, "https://glpi.acme.example");
      assert.equal(inst.v1.userToken, "cfg-token");
      assert.equal(inst.v1.appToken, "app");
      assert.equal(inst.enableV1, true);
      assert.equal(inst.enableV2, false);
      assert.deepEqual(inst.policy, { readOnly: false, allowDelete: false, requireDeleteReason: true });
      assert.equal(inst.toolsets, undefined);
    } finally {
      process.env = saved;
    }
  });

  it("maps v2 credentials, policy, toolsets, globs and fetchImpl", () => {
    const fetchImpl: FetchImpl = async () => json({});
    const inst = instanceFromConfig({
      id: "acme-v2",
      v2: {
        url: "https://glpi.acme.example",
        clientId: "cid",
        clientSecret: "cs",
        username: "bot",
        password: "pw",
        apiVersion: "v2.2",
      },
      policy: { readOnly: true },
      toolsets: "Tickets, kb",
      toolsInclude: ["glpi_search", "glpi_v2_get_me"],
      toolsExclude: "*delete*",
      fetchImpl,
    });
    assert.equal(inst.enableV1, false);
    assert.equal(inst.enableV2, true);
    assert.equal(inst.v2.scope, "api");
    assert.equal(inst.v2.apiVersion, "v2.2");
    assert.equal(inst.v2.fetchImpl, fetchImpl);
    assert.equal(inst.policy.readOnly, true);
    assert.deepEqual(inst.toolsets, ["tickets", "kb"]);
    assert.equal(inst.toolsInclude, "glpi_search,glpi_v2_get_me");
    assert.equal(inst.toolsExclude, "*delete*");
  });

  it("rejects bad input up front", () => {
    const v1 = { url: "https://glpi.example.com", userToken: "u" };
    assert.throws(() => instanceFromConfig({ id: "x" }), /v1 and\/or v2/);
    assert.throws(() => instanceFromConfig({ id: "Bad Id", v1 }), /instance id/);
    assert.throws(() => instanceFromConfig({ id: "x", v1: { url: "ftp://glpi", userToken: "u" } }), /http\(s\)/);
    assert.throws(() => instanceFromConfig({ id: "x", v1: { url: "not a url", userToken: "u" } }), /valid URL/);
    assert.throws(() => instanceFromConfig({ id: "x", v1, toolsets: ["tickets", "nope"] }), /unknown toolset\(s\): nope/);
  });

  it("exposes the release version", () => {
    assert.equal(SERVER_VERSION, "3.4.0");
  });
});

// ---------------------------------------------------------------------------
// Injected fetch and redirects, end to end
// ---------------------------------------------------------------------------

describe("fetchImpl through createGlpiServer", () => {
  it("v1: the injected fetch carries initSession and the request, with redirect: manual", async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/initSession")) return json({ session_token: "sess-1" });
      return json({ id: 7, name: "Printer down", status: 1 });
    };
    const client = await connect(
      instanceFromConfig({ id: "v1-fetch", v1: { url: "https://glpi.example.com", userToken: uniq("u") } }),
      fetchImpl,
    );
    const res = await callTool(client, "glpi_get_ticket", { ticketId: 7 });
    await client.close();

    assert.notEqual(res.isError, true, res.content[0]?.text);
    assert.match(res.content[0].text, /Printer down/);
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://glpi.example.com/apirest.php/initSession", "https://glpi.example.com/apirest.php/Ticket/7"],
    );
    for (const c of calls) assert.equal(c.init.redirect, "manual");
    assert.equal((calls[1].init.headers as Record<string, string>)["Session-Token"], "sess-1");
  });

  it("v1: instance.fetchImpl is used when createGlpiServer gets none", async () => {
    let used = 0;
    const fetchImpl: FetchImpl = async (url) => {
      used++;
      return url.endsWith("/initSession") ? json({ session_token: "s" }) : json({ id: 1 });
    };
    const client = await connect(
      instanceFromConfig({ id: "v1-inst-fetch", v1: { url: "https://glpi.example.com", userToken: uniq("u") }, fetchImpl }),
    );
    await callTool(client, "glpi_get_ticket", { ticketId: 1 });
    await client.close();
    assert.equal(used, 2);
  });

  it("v1: a 302 on initSession is reported, not followed", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/login?next=x" } });
    };
    const client = await connect(
      instanceFromConfig({ id: "v1-redirect", v1: { url: "https://glpi.example.com", userToken: uniq("u") } }),
      fetchImpl,
    );
    const res = await callTool(client, "glpi_get_ticket", { ticketId: 1 });
    await client.close();
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /redirect not followed: 302 -> evil\.example/);
    assert.equal(calls.length, 1, "neither followed nor retried");
  });

  it("v2: the injected fetch carries the token and the request", async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/api.php/token")) return json({ access_token: "tok-1", expires_in: 3600 });
      return json({ id: 9, name: "VPN" });
    };
    const client = await connect(
      instanceFromConfig({
        id: "v2-fetch",
        v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: uniq("n"), password: "p" },
      }),
      fetchImpl,
    );
    const res = await callTool(client, "glpi_v2_get_ticket", { ticketId: 9 });
    await client.close();

    assert.notEqual(res.isError, true, res.content[0]?.text);
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://glpi.example.com/api.php/token", "https://glpi.example.com/api.php/v2/Assistance/Ticket/9"],
    );
    for (const c of calls) assert.equal(c.init.redirect, "manual");
    assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer tok-1");
  });

  it("v2: a 307 on the request is reported, not followed", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith("/api.php/token")) return json({ access_token: "tok", expires_in: 3600 });
      return new Response(null, { status: 307, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
    };
    const client = await connect(
      instanceFromConfig({
        id: "v2-redirect",
        v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: uniq("n"), password: "p" },
      }),
      fetchImpl,
    );
    const res = await callTool(client, "glpi_v2_get_ticket", { ticketId: 1 });
    await client.close();
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /redirect not followed: 307 -> 169\.254\.169\.254/);
    assert.equal(calls.length, 2, "token + one request; the redirect target is never fetched");
  });
});

// ---------------------------------------------------------------------------
// v2 absolute URLs
// ---------------------------------------------------------------------------

describe("v2 URL resolution", () => {
  const cfg: GlpiV2Config = {
    baseUrl: "https://glpi.example.com",
    clientId: "c",
    clientSecret: "s",
    username: "n",
    password: "p",
  };

  it("joins relative paths under the API prefix (or the root when raw)", () => {
    assert.equal(resolveV2Url(cfg, "GET", "/Assistance/Ticket"), "https://glpi.example.com/api.php/v2/Assistance/Ticket");
    assert.equal(resolveV2Url(cfg, "GET", "Assistance/Ticket"), "https://glpi.example.com/api.php/v2/Assistance/Ticket");
    assert.equal(resolveV2Url(cfg, "GET", "/status", true), "https://glpi.example.com/status");
  });

  it("refuses absolute URLs to another host", () => {
    for (const url of [
      "https://evil.example/api.php/v2/Assistance/Ticket",
      "http://glpi.example.com/x", // same host, other scheme = other origin
      "https://glpi.example.com:8443/x",
      "//evil.example/x",
      "\\\\evil.example/x",
      "file:///etc/passwd",
    ]) {
      assert.throws(() => resolveV2Url(cfg, "GET", url), GlpiV2ApiError, url);
    }
  });

  it("accepts an absolute URL on the GLPI_V2_URL origin", () => {
    assert.equal(
      resolveV2Url(cfg, "GET", "https://glpi.example.com/api.php/v2/Assistance/Ticket/1"),
      "https://glpi.example.com/api.php/v2/Assistance/Ticket/1",
    );
  });

  it("keeps raw paths on the GLPI host", () => {
    // Without the leading-slash normalisation this would read as user@host.
    assert.equal(resolveV2Url(cfg, "GET", "@evil.example/x", true), "https://glpi.example.com/@evil.example/x");
  });

  it("glpiV2Request refuses before any network call", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls++;
      return json({ access_token: "t", expires_in: 3600 });
    };
    await assert.rejects(
      glpiV2Request({ ...cfg, username: uniq("n"), fetchImpl }, "GET", "https://evil.example/steal"),
      /absolute URL refused, host evil\.example/,
    );
    assert.equal(calls, 0, "not even the token request goes out");
  });
});

// ---------------------------------------------------------------------------
// Toolsets
// ---------------------------------------------------------------------------

describe("toolsets", () => {
  it("every tool belongs to at least one preset besides core, and presets name only real tools", async () => {
    const names = await allToolNames();
    assert.equal(names.length, 166);
    const real = new Set(names);
    for (const [preset, def] of Object.entries(TOOLSETS)) {
      for (const t of def.tools) assert.ok(real.has(t), `${preset} lists unknown tool ${t}`);
    }
    const byPreset = (name: string) =>
      TOOLSET_NAMES.filter((p) => p !== "core").filter((p) => {
        const def = TOOLSETS[p];
        return def.tools.includes(name) || (def.globs ?? []).some((g) => new RegExp("^" + g.replace(/\*/g, ".*") + "$").test(name));
      });
    const orphans = names.filter((n) => byPreset(n).length === 0);
    assert.deepEqual(orphans, [], "tools without a preset");
  });

  it("core holds reads and non-destructive ticket operations only", () => {
    const core = TOOLSETS.core.tools;
    assert.ok(core.length > 0);
    for (const t of core) {
      const kind = classifyTool(t);
      assert.notEqual(kind, "destructive", t);
      if (kind === "write") assert.ok(TOOLSETS.tickets.tools.includes(t), `${t} is a write outside tickets`);
      assert.ok(!/webhook|rule|session/.test(t), `${t} is an admin internal`);
    }
    for (const t of ["glpi_create_ticket", "glpi_add_followup", "glpi_add_solution", "glpi_add_ticket_task", "glpi_search", "glpi_get_user", "glpi_list_entities", "glpi_v2_create_ticket"]) {
      assert.ok(core.includes(t), `core should include ${t}`);
    }
  });

  it("GLPI_TOOLSETS=tickets,kb registers exactly those presets", async () => {
    const client = await connect(
      instanceFromEnv("ts-env", { GLPI_URL: "https://glpi.example.com", GLPI_USER_TOKEN: "u", GLPI_TOOLSETS: "tickets,kb" }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    const expected = [...new Set([...TOOLSETS.tickets.tools, ...TOOLSETS.kb.tools])]
      .filter((n) => !n.startsWith("glpi_v2_")) // v2 family is off: no GLPI_V2_URL
      .sort();
    assert.deepEqual(names, expected);
  });

  it("include globs add up and exclude wins", async () => {
    const client = await connect(
      instanceFromConfig({
        id: "ts-mix",
        v1: { url: "https://glpi.example.com", userToken: "u" },
        toolsets: ["kb"],
        toolsInclude: "glpi_search",
        toolsExclude: "*delete*",
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    assert.ok(names.includes("glpi_search"));
    assert.ok(names.includes("glpi_get_knowbase_item"));
    assert.ok(!names.includes("glpi_delete_knowbase_item"));
    assert.ok(!names.includes("glpi_list_tickets"));
  });

  it("the v2 preset selects the whole v2 family", async () => {
    const client = await connect(
      instanceFromConfig({
        id: "ts-v2",
        v1: { url: "https://glpi.example.com", userToken: "u" },
        v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: "n", password: "p" },
        toolsets: "v2",
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    assert.equal(names.length, 55);
    assert.ok(names.every((n) => n.startsWith("glpi_v2_")));
  });

  it("an unknown toolset fails at load, naming the instance", () => {
    assert.throws(
      () => instanceFromEnv("prod-1", { GLPI_URL: "https://glpi.example.com", GLPI_TOOLSETS: "tickets,tikets" }),
      /instance "prod-1": unknown toolset\(s\): tikets \(valid: core, tickets/,
    );
  });
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe("MCP annotations on every tool", () => {
  it("each tool advertises title and hints matching its classification", async () => {
    const client = await connect(
      instanceFromConfig({
        id: "annotations",
        v1: { url: "https://glpi.example.com", userToken: "u" },
        v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: "n", password: "p" },
      }),
    );
    const { tools } = await client.listTools();
    await client.close();
    assert.equal(tools.length, 166);
    for (const t of tools) {
      const a = t.annotations;
      assert.ok(a, `${t.name} has no annotations`);
      const kind = classifyTool(t.name);
      assert.equal(a.readOnlyHint, kind === "read", `${t.name} readOnlyHint`);
      const additive = /^glpi_(v2_)?(create|add)_/.test(t.name);
      assert.equal(a.destructiveHint, kind === "destructive" || (kind === "write" && !additive), `${t.name} destructiveHint`);
      assert.equal(typeof a.idempotentHint, "boolean", `${t.name} idempotentHint`);
      assert.equal(a.openWorldHint, false, `${t.name} openWorldHint`);
      assert.ok(typeof a.title === "string" && a.title.length > 0, `${t.name} title`);
    }
    const byName = new Map(tools.map((t) => [t.name, t.annotations!]));
    assert.equal(byName.get("glpi_get_ticket")!.readOnlyHint, true);
    assert.equal(byName.get("glpi_delete_document")!.destructiveHint, true);
    assert.equal(byName.get("glpi_v2_delete_ticket")!.destructiveHint, true);
    assert.equal(byName.get("glpi_create_ticket")!.idempotentHint, false);
    assert.equal(byName.get("glpi_create_ticket")!.destructiveHint, false);
    assert.equal(byName.get("glpi_update_ticket")!.destructiveHint, true);
    assert.equal(byName.get("glpi_update_ticket")!.idempotentHint, true);
  });

  it("a redirect error is a GlpiRedirectError for library callers", () => {
    const err = new GlpiRedirectError(302, "GET", "/x", "evil.example");
    assert.equal(err.message, "redirect not followed: 302 -> evil.example");
  });
});

describe("serverInfo and instructions", () => {
  it("sends the default identity and instructions, and lets a host override title, description, website and icons", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { instanceFromConfig, createGlpiServer, DEFAULT_INSTRUCTIONS, SERVER_VERSION } = await import("../src/lib.js");
    const inst = instanceFromConfig({ id: "x", v1: { url: "https://glpi.example.com", userToken: "u" } });
    for (const [opts, title] of [[{}, "NexTool MCP for GLPI"], [{ serverInfo: { title: "Host", description: "d", websiteUrl: "https://host.example", icons: [{ src: "https://host.example/i.png", mimeType: "image/png", sizes: ["180x180"] }] }, instructions: "hi" }, "Host"]] as const) {
      const { server } = createGlpiServer(inst, opts as never);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
      const info = client.getServerVersion()!;
      assert.equal(info.title, title);
      assert.equal(info.version, SERVER_VERSION, "version is never overridden");
      assert.equal(client.getInstructions(), (opts as { instructions?: string }).instructions ?? DEFAULT_INSTRUCTIONS);
      if (title === "Host") {
        assert.equal(info.websiteUrl, "https://host.example");
        assert.equal(info.icons?.[0].src, "https://host.example/i.png");
      }
      await client.close();
    }
  });
});
