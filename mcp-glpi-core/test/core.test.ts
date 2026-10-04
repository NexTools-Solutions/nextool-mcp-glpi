import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backoffDelay,
  isRetryable,
  qs,
  sanitizeId,
  trimSlash,
  withQs,
} from "../src/http.js";
import { GlpiHttpError, GlpiPolicyError } from "../src/errors.js";
import { errorResult, jsonResult, makeWrap, toolResult } from "../src/result.js";

describe("http helpers", () => {
  it("trims a single trailing slash", () => {
    assert.equal(trimSlash("https://glpi.example.com/"), "https://glpi.example.com");
    assert.equal(trimSlash("https://glpi.example.com"), "https://glpi.example.com");
  });

  it("sanitizes IDs against path traversal", () => {
    assert.equal(sanitizeId(42), "42");
    assert.equal(sanitizeId("../../etc/passwd"), "..%2F..%2Fetc%2Fpasswd");
    assert.equal(sanitizeId("1 OR 1=1"), "1%20OR%201%3D1");
  });

  it("retries only on 429 and 5xx", () => {
    assert.equal(isRetryable(429), true);
    assert.equal(isRetryable(500), true);
    assert.equal(isRetryable(503), true);
    assert.equal(isRetryable(400), false);
    assert.equal(isRetryable(401), false);
    assert.equal(isRetryable(404), false);
  });

  it("backs off exponentially", () => {
    assert.equal(backoffDelay(0), 1000);
    assert.equal(backoffDelay(1), 2000);
    assert.equal(backoffDelay(2), 4000);
  });

  it("drops undefined and empty query params", () => {
    assert.equal(qs({ range: "0-9", expand: undefined, empty: "" }), "range=0-9");
    assert.equal(withQs("/Ticket/", { range: "0-9" }), "/Ticket/?range=0-9");
    assert.equal(withQs("/Ticket/", { range: undefined }), "/Ticket/");
  });
});

describe("errors", () => {
  it("keeps the server-specific name on the shared base class", () => {
    const err = new GlpiHttpError("boom", 500, "GET", "/Ticket", "GlpiApiError");
    assert.equal(err.name, "GlpiApiError");
    assert.equal(err.status, 500);
    assert.equal(err.method, "GET");
    assert.equal(err.path, "/Ticket");
    assert.ok(err instanceof Error);
  });

  it("exposes a policy error distinct from HTTP errors", () => {
    const err = new GlpiPolicyError("read-only");
    assert.equal(err.name, "GlpiPolicyError");
    assert.ok(!(err instanceof GlpiHttpError));
  });
});

describe("tool results", () => {
  it("returns parseable structuredContent alongside the text payload", () => {
    const r = jsonResult({ data: [{ id: 1 }] });
    assert.deepEqual(r.structuredContent, { data: [{ id: 1 }] });
    assert.deepEqual(JSON.parse(r.content[0].text), { data: [{ id: 1 }] });
  });

  it("wraps non-object payloads", () => {
    assert.deepEqual(jsonResult(7).structuredContent, { value: 7 });
  });

  it("wraps bare arrays so outputSchema validation does not reject them", () => {
    // Regression: v2 list tools returned a bare array, failing with
    // "Expected object, received array" before it ever reached the client.
    const r = jsonResult([{ id: 1 }, { id: 2 }]);
    assert.deepEqual(r.structuredContent, { data: [{ id: 1 }, { id: 2 }] });
    assert.ok(!Array.isArray(r.structuredContent));
  });

  it("flags errors", () => {
    assert.equal(errorResult("nope").isError, true);
    // No structuredContent: validating clients check it against the outputSchema even on errors.
    assert.equal(errorResult("nope").structuredContent, undefined);
    assert.match(errorResult("nope").content[0].text, /"error": "nope"/);
    assert.equal(toolResult("hi").isError, false);
  });
});

describe("makeWrap", () => {
  it("short-circuits when the config is incomplete", async () => {
    const wrap = makeWrap(() => "GLPI_URL must be set.");
    const handler = wrap(async () => jsonResult({ data: "never" }));
    const r = (await handler({})) as { isError?: boolean; content: { text: string }[] };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /GLPI_URL must be set/);
  });

  it("converts thrown errors into an error result instead of crashing", async () => {
    const wrap = makeWrap(() => null);
    const handler = wrap(async () => {
      throw new GlpiHttpError("GLPI GET /Ticket: 404 – not found", 404, "GET", "/Ticket");
    });
    const r = (await handler({})) as { isError?: boolean; content: { text: string }[] };
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /404/);
  });

  it("passes through on success", async () => {
    const wrap = makeWrap(() => null);
    const handler = wrap(async (args: { n: number }) => jsonResult({ data: args.n * 2 }));
    const r = (await handler({ n: 21 })) as { structuredContent?: Record<string, unknown> };
    assert.deepEqual(r.structuredContent, { data: 42 });
  });
});
