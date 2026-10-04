/**
 * Contracts every tool must keep, checked across the whole catalogue:
 *
 *   1. A tool named in another tool's description or parameters exists and is
 *      in every preset that holds the tool naming it (a preset never sends the
 *      model after a tool it lacks). Prompts naming a missing tool are skipped.
 *   2. Every tool that advertises `format` honours `format: "markdown"` — in the
 *      text block AND in structuredContent, which is what clients that support
 *      structured results hand to the model.
 *
 * GLPI is stubbed through `fetchImpl`; the server is driven by a real MCP client.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FetchImpl } from "@nextoolsolutions/mcp-glpi-core";

import { createGlpiServer, instanceFromConfig, TOOLSETS, type InstanceConfig } from "../src/lib.js";
import { buildPrompts, toolsCitedBy } from "../src/prompts.js";

let seq = 0;
const uniq = (label: string) => `${label}-${process.pid}-${++seq}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Plausible answers for any v1/v2 path, enough for every read tool to succeed. */
const stubGlpi: FetchImpl = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith("/initSession")) return json({ session_token: "s" });
  if (path.endsWith("/api.php/token")) return json({ access_token: "t", expires_in: 3600 });
  if (path.endsWith("/getFullSession")) return json({ session: { glpiID: 7, glpifriendlyname: "Jane Doe" } });
  if (path.endsWith("/session")) return json({ user_id: 7, friendly_name: "Jane Doe" });
  if (path.includes("/listSearchOptions/")) return json({ "1": { name: "Title" }, "2": { name: "ID" } });
  if (path.includes("/search/")) {
    return json({ totalcount: 1, count: 1, data: [{ "1": "Printer down", "2": 1, "12": 1, "4": "7", "5": ["8", "9"] }] });
  }
  if (path.endsWith("/getMultipleItems")) return json([{ id: 1, name: "Printer down", status: 1 }]);
  if (path.endsWith("/404404")) return json(["ERROR_ITEM_NOT_FOUND", "Item not found"], 404);
  if (/\/\d+$/.test(path)) {
    const id = Number(path.split("/").pop());
    return json({ id, name: `item-${id}`, firstname: "Jane", realname: "Doe", users_id: 7, status: 1 });
  }
  return json([{ id: 1, name: "a", users_id: 7, type: 1, status: 1, date: "2026-10-04 10:00:00" }]);
};

const BOTH: Pick<InstanceConfig, never> & Parameters<typeof instanceFromConfig>[0] = {
  id: "contracts",
  v1: { url: "https://glpi.example.com", userToken: "u" },
  v2: { url: "https://glpi.example.com", clientId: "c", clientSecret: "s", username: "n", password: "p" },
};

async function connect(opts: Parameters<typeof instanceFromConfig>[0]) {
  const { server } = createGlpiServer(instanceFromConfig(opts), { fetchImpl: stubGlpi });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contracts", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const CITATION = /\bglpi_[a-z0-9_]+/g;

function citedBy(tool: { name: string; description?: string; inputSchema: unknown }): string[] {
  const text = `${tool.description ?? ""}\n${JSON.stringify(tool.inputSchema)}`;
  return [...new Set(text.match(CITATION) ?? [])].filter((n) => n !== tool.name);
}

function presetTools(preset: string, all: string[]): Set<string> {
  const def = TOOLSETS[preset];
  const globs = (def.globs ?? []).map((g) => new RegExp("^" + g.replace(/\*/g, ".*") + "$"));
  return new Set(all.filter((n) => def.tools.includes(n) || globs.some((re) => re.test(n))));
}

/** Minimal valid arguments from a tool's JSON schema. */
function sampleArgs(schema: { properties?: Record<string, Record<string, unknown>>; required?: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) out[key] = sampleValue(schema.properties?.[key] ?? {});
  return out;
}

function sampleValue(s: Record<string, unknown>): unknown {
  if (Array.isArray(s.enum)) return s.enum[0];
  const branch = (s.anyOf ?? s.oneOf) as Record<string, unknown>[] | undefined;
  if (branch?.length) return sampleValue(branch[0]);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return typeof s.minLength === "number" ? "x".repeat(s.minLength) : "1";
  }
}

describe("citations between tools", () => {
  it("every cited tool exists and sits in every preset of the citing tool", async () => {
    const client = await connect(BOTH);
    const { tools } = await client.listTools();
    await client.close();
    const all = tools.map((t) => t.name);
    const real = new Set(all);

    const problems: string[] = [];
    for (const t of tools) {
      for (const cited of citedBy(t)) {
        if (!real.has(cited)) problems.push(`${t.name} cites ${cited}, which does not exist`);
      }
    }
    for (const preset of Object.keys(TOOLSETS)) {
      const members = presetTools(preset, all);
      for (const t of tools.filter((x) => members.has(x.name))) {
        for (const cited of citedBy(t)) {
          if (real.has(cited) && !members.has(cited)) problems.push(`preset ${preset}: ${t.name} cites ${cited}, not in the preset`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("the ticket presets hold search and the user reads that name people", () => {
    for (const preset of ["tickets", "core"]) {
      for (const t of ["glpi_search", "glpi_list_search_options", "glpi_get_user", "glpi_search_user_by_email", "glpi_list_my_tickets"]) {
        assert.ok(TOOLSETS[preset].tools.includes(t), `${preset} should include ${t}`);
      }
    }
  });

  it("prompts are registered only when every tool they name is", async () => {
    const definitions = buildPrompts({ ticketId: {}, optionalText: {}, requiredText: {} });
    const client = await connect({ ...BOTH, id: uniq("prompts"), toolsets: ["kb"] });
    // No prompt left = no prompts capability: the server answers "method not found".
    const prompts = await client.listPrompts().then((r) => r.prompts, () => []);
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    await client.close();
    for (const p of prompts) {
      const def = definitions.find((d) => d.name === p.name)!;
      for (const t of toolsCitedBy(def)) assert.ok(names.has(t), `prompt ${p.name} names ${t}, absent with toolsets=kb`);
    }
    assert.equal(prompts.length, 0, "kb alone backs none of the ticket/asset prompts");

    const full = await connect({ ...BOTH, id: uniq("prompts-all") });
    assert.equal((await full.listPrompts()).prompts.length, definitions.length);
    await full.close();
  });
});

describe("item IDs are validated before any request", () => {
  const ID_NAME = /(Id|_id|_id_[a-z]+)$/;
  /** Follows "#/properties/x/anyOf/0" refs (the JSON schema reuses a shared zod schema by reference). */
  const deref = (root: unknown, node: Record<string, unknown>): Record<string, unknown> => {
    if (typeof node.$ref !== "string") return node;
    let cur: unknown = root;
    for (const part of node.$ref.replace(/^#\//, "").split("/")) cur = (cur as Record<string, unknown>)?.[part];
    return deref(root, (cur ?? {}) as Record<string, unknown>);
  };
  let rootSchema: unknown;
  const isIdSchema = (p: Record<string, unknown>) => {
    const branches = (((p.anyOf as Record<string, unknown>[] | undefined) ?? []) as Record<string, unknown>[]).map((b) =>
      deref(rootSchema, b),
    );
    return branches.some((b) => b.type === "integer") && branches.some((b) => b.type === "string" && typeof b.pattern === "string");
  };

  it("every ID parameter of every tool rejects non-IDs without calling GLPI", async () => {
    let calls = 0;
    const counting: FetchImpl = async (url, init) => {
      calls++;
      return stubGlpi(url, init);
    };
    const { server } = createGlpiServer(instanceFromConfig({ ...BOTH, id: uniq("ids") }), { fetchImpl: counting });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ids", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();

    const problems: string[] = [];
    let checked = 0;
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
      rootSchema = schema;
      for (const [prop, p] of Object.entries(schema.properties ?? {})) {
        if (!ID_NAME.test(prop) && !isIdSchema(p)) continue;
        if (!isIdSchema(p)) {
          const plainNumber = p.type === "integer" || (p.type === "number" && (p.exclusiveMinimum === 0 || p.minimum === 1));
          if (!plainNumber) problems.push(`${t.name}.${prop}: ID accepted as ${JSON.stringify(p.type ?? p)}`);
          continue;
        }
        checked++;
        const zeroOk = /entity/i.test(prop);
        for (const bad of ["abc", "", "-1", "1.5", "1/2", -1, 1.5, ...(zeroOk ? [] : [0, "0"])]) {
          const before = calls;
          const args = { ...sampleArgs(schema as never), [prop]: bad };
          const r = (await client.callTool({ name: t.name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
          if (!r.isError || !/Input validation error/.test(r.content[0]?.text ?? "")) problems.push(`${t.name}.${prop}=${JSON.stringify(bad)} accepted`);
          if (calls !== before) problems.push(`${t.name}.${prop}=${JSON.stringify(bad)} reached GLPI`);
        }
        const ok = (await client.callTool({ name: t.name, arguments: { ...sampleArgs(schema as never), [prop]: "12" } })) as {
          content: { text: string }[];
        };
        if (/Input validation error/.test(ok.content[0]?.text ?? "")) problems.push(`${t.name}.${prop}: "12" rejected`);
      }
    }
    await client.close();
    assert.ok(checked > 80, `only ${checked} ID parameters found`);
    assert.deepEqual(problems, []);
  });
});

describe("generated notes name only real parameters and tools", () => {
  it("pagination and size notes of every listing cite parameters the tool has", async () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `row ${i + 1}`, content: "c".repeat(400), users_id: 7, status: 1 }));
    const many: FetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.includes("/search/")) {
        return json({ totalcount: 500, count: 25, data: rows(25).map((r) => ({ "1": r.name, "2": r.id, "4": "7" })) });
      }
      if (path.endsWith("/getMultipleItems")) return json(rows(25));
      if (/\/(initSession|token|getFullSession|session)$/.test(path) || /\/\d+$/.test(path) || path.includes("listSearchOptions")) {
        return stubGlpi(url, init);
      }
      return json(rows(25));
    };
    const { server } = createGlpiServer(instanceFromConfig({ ...BOTH, id: uniq("notes") }), { fetchImpl: many });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "notes", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const real = new Set(tools.map((t) => t.name));

    const problems: string[] = [];
    let withNote = 0;
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if (!("range" in props) && !("limit" in props)) continue;
      for (const format of ["json", "markdown"]) {
        const r = (await client.callTool({ name: t.name, arguments: { ...sampleArgs(t.inputSchema as never), format } })) as {
          isError?: boolean;
          content: { text: string }[];
          structuredContent?: { note?: string };
        };
        if (r.isError) {
          problems.push(`${t.name}: ${r.content[0]?.text.slice(0, 100)}`);
          continue;
        }
        const note = r.structuredContent?.note ?? "";
        if (note) withNote++;
        for (const [, param] of note.matchAll(/\b([a-z_]+)=/g)) {
          if (!(param in props)) problems.push(`${t.name}: note names ${param}=, not a parameter of the tool`);
        }
        for (const cited of note.match(CITATION) ?? []) if (!real.has(cited)) problems.push(`${t.name}: note names ${cited}`);
        if (/\bstart\b/.test(note) && !("start" in props)) problems.push(`${t.name}: note mentions start`);
      }
    }
    await client.close();
    assert.ok(withNote > 40, `only ${withNote} notes produced`);
    assert.deepEqual(problems, []);
  });
});

describe("errors reach validating clients", () => {
  it("a GLPI 404 is an isError result with the message, not an output-schema protocol error", async () => {
    const client = await connect({ ...BOTH, id: uniq("err") });
    await client.listTools(); // the SDK client validates structuredContent only after listing tools
    for (const [name, args] of [
      ["glpi_get_ticket", { ticketId: 404404 }],
      ["glpi_v2_get_ticket", { ticketId: 404404 }],
    ] as const) {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(r.isError, true, name);
      assert.match(r.content[0].text, /404/, name);
    }
    await client.close();
  });
});

describe("format: markdown on every tool that advertises it", () => {
  it("returns markdown in the text and in structuredContent", async () => {
    const client = await connect({ ...BOTH, id: uniq("md") });
    const { tools } = await client.listTools();
    const withFormat = tools.filter((t) => "format" in ((t.inputSchema as { properties?: object }).properties ?? {}));
    assert.ok(withFormat.length > 50, `expected the read tools to advertise format, got ${withFormat.length}`);

    const failures: string[] = [];
    for (const t of withFormat) {
      const args = { ...sampleArgs(t.inputSchema as never), format: "markdown" };
      const r = (await client.callTool({ name: t.name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
        structuredContent?: Record<string, unknown>;
      };
      const text = r.content?.[0]?.text ?? "";
      if (r.isError) failures.push(`${t.name}: error ${text.slice(0, 120)}`);
      else if (/^\s*[[{]/.test(text)) failures.push(`${t.name}: text is JSON`);
      else if (r.structuredContent?.format !== "markdown" || typeof r.structuredContent?.data !== "string") {
        failures.push(`${t.name}: structuredContent does not carry the markdown`);
      }
    }
    await client.close();
    assert.deepEqual(failures, []);
  });

  it("JSON stays the default", async () => {
    const client = await connect({ ...BOTH, id: uniq("json") });
    const r = (await client.callTool({ name: "glpi_v2_get_ticket", arguments: { ticketId: 3 } })) as {
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };
    await client.close();
    assert.match(r.content[0].text, /^\{/);
    assert.equal(r.structuredContent.id, 3);
    assert.equal(r.structuredContent.format, undefined);
  });
});
