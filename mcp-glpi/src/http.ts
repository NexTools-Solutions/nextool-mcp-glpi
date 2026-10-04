#!/usr/bin/env node

/**
 * MCP Server for GLPI — HTTP entry (Streamable HTTP, many instances, authentication required).
 *
 *   POST/GET/DELETE /mcp/<instance>   MCP endpoint of one GLPI instance
 *   GET /healthz                      liveness, no authentication
 *
 * Every MCP request needs `Authorization: Bearer <key>`; without a valid key the
 * answer is 401 and nothing reaches GLPI. A key opens only the instances it was
 * granted, and a session stays bound to the key and instance that created it.
 *
 * Until the NexTool portal issues OAuth tokens (Laravel Passport), keys and
 * instances come from a JSON file — only SHA-256 hashes of the keys are stored:
 *
 *   {
 *     "instances": {
 *       "nextool-dev": { "env": { "GLPI_URL": "...", "GLPI_USER_TOKEN": "...", "GLPI_V2_URL": "..." } }
 *     },
 *     "keys": [
 *       { "name": "laptop", "sha256": "<hex of the key>", "instances": ["nextool-dev"] }
 *     ]
 *   }
 *
 * `env` takes the same variables as the stdio entry (see index.ts), per
 * instance. The file is re-read when it changes; no restart needed.
 *
 * Environment variables:
 *   MCP_INSTANCES_FILE   — path of the file above (required)
 *   MCP_HTTP_HOST        — bind address (default 127.0.0.1)
 *   MCP_HTTP_PORT        — port (default 8787)
 *   MCP_ALLOWED_HOSTS    — comma-separated Host headers accepted (DNS-rebinding guard; default: any)
 *   MCP_SESSION_IDLE_MIN — minutes before an idle session is closed (default 30)
 *   Operational GLPI_* tunables (retries, timeout, page sizes, idempotency window) apply server-wide.
 *
 * Audit: one JSON line per MCP request on stdout (time, key, instance, method,
 * tool); never arguments, results or credentials.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IdempotencyStore } from "@nextoolsolutions/mcp-glpi-core";
import { createGlpiServer, SERVER_VERSION } from "./create-server.js";
import { instanceFromEnv, type InstanceConfig, type InstanceEnv } from "./instance.js";

// ---------------------------------------------------------------------------
// Instances file
// ---------------------------------------------------------------------------

export interface KeyEntry {
  name: string;
  sha256: string;
  instances: string[];
}

export interface Registry {
  instances: Map<string, InstanceConfig>;
  keys: KeyEntry[];
}

const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseRegistry(json: string): Registry {
  const raw = JSON.parse(json) as {
    instances?: Record<string, { env?: InstanceEnv }>;
    keys?: KeyEntry[];
  };
  const instances = new Map<string, InstanceConfig>();
  for (const [id, entry] of Object.entries(raw.instances ?? {})) {
    if (!INSTANCE_ID.test(id)) throw new Error(`instance id "${id}": use lowercase letters, digits and -`);
    instances.set(id, instanceFromEnv(id, entry.env ?? {}));
  }
  const keys = (raw.keys ?? []).map((k) => {
    if (!/^[0-9a-f]{64}$/.test(k.sha256 ?? "")) throw new Error(`key "${k.name}": sha256 must be 64 hex chars`);
    for (const id of k.instances ?? []) {
      if (!instances.has(id)) throw new Error(`key "${k.name}": unknown instance "${id}"`);
    }
    return { name: k.name, sha256: k.sha256, instances: [...(k.instances ?? [])] };
  });
  return { instances, keys };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time lookup: every entry is compared, whichever matches. */
export function findKey(registry: Registry, presented: string): KeyEntry | undefined {
  const digest = Buffer.from(hashKey(presented), "hex");
  let found: KeyEntry | undefined;
  for (const k of registry.keys) {
    if (timingSafeEqual(digest, Buffer.from(k.sha256, "hex"))) found = k;
  }
  return found;
}

/** Re-reads the file when its mtime changes; a broken edit keeps the last good registry. */
function registryLoader(path: string): () => Registry {
  let mtime = -1;
  let current: Registry | undefined;
  return () => {
    const m = statSync(path).mtimeMs;
    if (m !== mtime) {
      try {
        current = parseRegistry(readFileSync(path, "utf8"));
        process.stderr.write(
          `[mcp-glpi-http] registry: ${current.instances.size} instances, ${current.keys.length} keys\n`,
        );
      } catch (err) {
        if (!current) throw err;
        process.stderr.write(`[mcp-glpi-http] registry NOT reloaded, keeping the previous one: ${String(err)}\n`);
      }
      mtime = m;
    }
    return current!;
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  keyName: string;
  instanceId: string;
  lastSeen: number;
}

export interface HttpServerOptions {
  /** Registry source: a file path (production) or a fixed registry (tests). */
  registry: string | Registry;
  host?: string;
  port?: number;
  allowedHosts?: string[];
  sessionIdleMs?: number;
  /** Audit sink; defaults to stdout JSON lines. */
  audit?: (entry: Record<string, unknown>) => void;
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  sessions(): number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null }, headers);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/** Tool names (or methods) in a JSON-RPC body, for the audit line. */
function describeCalls(body: unknown): { methods: string[]; tools: string[] } {
  const msgs = Array.isArray(body) ? body : body ? [body] : [];
  const methods: string[] = [];
  const tools: string[] = [];
  for (const m of msgs as { method?: string; params?: { name?: string } }[]) {
    if (typeof m?.method === "string") methods.push(m.method);
    if (m?.method === "tools/call" && typeof m.params?.name === "string") tools.push(m.params.name);
  }
  return { methods, tools };
}

export async function startHttpServer(opts: HttpServerOptions): Promise<RunningHttpServer> {
  const loadRegistry = typeof opts.registry === "string" ? registryLoader(opts.registry) : () => opts.registry as Registry;
  loadRegistry(); // fail fast on a missing or broken file
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const audit = opts.audit ?? ((e) => process.stdout.write(JSON.stringify(e) + "\n"));
  const sessions = new Map<string, Session>();
  // One create-idempotency store per instance, shared by its sessions.
  const idempotencyStores = new Map<string, IdempotencyStore>();
  const storeFor = (id: string) => {
    let store = idempotencyStores.get(id);
    if (!store) idempotencyStores.set(id, (store = new IdempotencyStore()));
    return store;
  };

  const closeSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close().catch(() => undefined);
    void s.server.close().catch(() => undefined);
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > idleMs) closeSession(id);
  }, Math.min(idleMs, 60_000));
  sweeper.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { status: "ok", version: SERVER_VERSION, sessions: sessions.size });
    }

    const match = url.pathname.match(/^\/mcp\/([a-z0-9][a-z0-9-]{0,62})\/?$/);
    if (!match) return sendJson(res, 404, { error: "not found" });
    const instanceId = match[1];

    if (opts.allowedHosts?.length && !opts.allowedHosts.includes((req.headers.host ?? "").toLowerCase())) {
      return rpcError(res, 403, "host not allowed");
    }

    // Authentication first: nothing below runs for an anonymous caller.
    const auth = req.headers.authorization ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    const registry = loadRegistry();
    const key = bearer ? findKey(registry, bearer) : undefined;
    if (!key) {
      audit({ t: new Date().toISOString(), event: "unauthorized", instance: instanceId, ip: req.socket.remoteAddress });
      return rpcError(res, 401, "authentication required", { "WWW-Authenticate": 'Bearer realm="mcp-glpi"' });
    }
    const instance = registry.instances.get(instanceId);
    if (!instance || !key.instances.includes(instanceId)) {
      // Same answer for "no such instance" and "not yours": ids are not disclosed.
      audit({ t: new Date().toISOString(), event: "forbidden", key: key.name, instance: instanceId });
      return rpcError(res, 403, "instance not available for this key");
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch {
        return rpcError(res, 400, "invalid JSON body");
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    let session: Session | undefined;
    if (typeof sessionId === "string") {
      session = sessions.get(sessionId);
      // A session id is not a credential: it only works with the key and instance that opened it.
      if (!session || session.keyName !== key.name || session.instanceId !== instanceId) {
        return rpcError(res, 404, "session not found");
      }
    } else if (req.method === "POST" && isInitializeRequest(body)) {
      const { server, summary } = createGlpiServer(instance, { idempotencyStore: storeFor(instanceId) });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, keyName: key.name, instanceId, lastSeen: Date.now() });
          audit({ t: new Date().toISOString(), event: "session", key: key.name, instance: instanceId, summary });
        },
        onsessionclosed: (id) => closeSession(id),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, keyName: key.name, instanceId, lastSeen: Date.now() };
    } else {
      return rpcError(res, 400, "no valid session: send initialize first");
    }

    session.lastSeen = Date.now();
    const { methods, tools } = describeCalls(body);
    if (methods.length) {
      audit({ t: new Date().toISOString(), event: "request", key: key.name, instance: instanceId, methods, tools });
    }
    await session.transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      process.stderr.write(`[mcp-glpi-http] request failed: ${err instanceof Error ? err.stack : String(err)}\n`);
      if (!res.headersSent) rpcError(res, 500, "internal error");
      else res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 8787);

  return {
    server,
    port,
    sessions: () => sessions.size,
    close: async () => {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) closeSession(id);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const file = process.env.MCP_INSTANCES_FILE;
  if (!file) {
    process.stderr.write("[mcp-glpi-http] MCP_INSTANCES_FILE is required\n");
    process.exit(1);
  }
  const running = await startHttpServer({
    registry: file,
    host: process.env.MCP_HTTP_HOST || "127.0.0.1",
    port: parseInt(process.env.MCP_HTTP_PORT ?? "8787", 10),
    allowedHosts: (process.env.MCP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionIdleMs: parseInt(process.env.MCP_SESSION_IDLE_MIN ?? "30", 10) * 60_000,
  });
  process.stderr.write(`[mcp-glpi-http] ${SERVER_VERSION} listening on ${process.env.MCP_HTTP_HOST || "127.0.0.1"}:${running.port}\n`);
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
