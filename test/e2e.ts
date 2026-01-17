/**
 * E2E tests for the Cloudflare proxy worker.
 *
 * Uses wrangler's unstable_startWorker() and a local origin server.
 * No external dependencies (httpbin, example.com) needed.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before, describe } from "node:test";
import { unstable_startWorker } from "wrangler";

const SECRET = "local-dev-secret";

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>;

function startOrigin(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://origin.local");

      // Echo headers back as JSON
      if (url.pathname === "/echo-headers") {
        const body = JSON.stringify({
          method: req.method,
          url: url.pathname + url.search,
          headers: req.headers,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
        return;
      }

      // Respond with Retry-After for rate limit testing
      if (url.pathname === "/rate-limited") {
        res.statusCode = 429;
        res.setHeader("Retry-After", "120");
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("slow down");
        return;
      }

      // Default response
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("ok");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind origin server"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

describe("cf-proxy worker", () => {
  let worker: Worker;
  let origin: Awaited<ReturnType<typeof startOrigin>>;

  before(async () => {
    worker = await unstable_startWorker({ config: "wrangler.jsonc" });
    origin = await startOrigin();
  });

  after(async () => {
    await origin.close();
    await worker.dispose();
  });

  // Health endpoints

  test("health endpoint returns ok + version", async () => {
    const res = await worker.fetch("http://proxy/health");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; version: string };
    assert.equal(json.ok, true);
    assert.equal(typeof json.version, "string");
  });

  test("version endpoint returns ok", async () => {
    const res = await worker.fetch("http://proxy/version");
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean };
    assert.equal(json.ok, true);
  });

  // Auth

  test("request without auth returns 401", async () => {
    const res = await worker.fetch(`http://proxy/?url=${origin.baseUrl}`);
    assert.equal(res.status, 401);
  });

  test("request with wrong auth returns 401", async () => {
    const res = await worker.fetch(`http://proxy/?url=${origin.baseUrl}`, {
      headers: { "X-Proxy-Secret": "wrong-secret" },
    });
    assert.equal(res.status, 401);
  });

  // Method validation

  test("POST request returns 405", async () => {
    const res = await worker.fetch(`http://proxy/?url=${origin.baseUrl}`, {
      method: "POST",
      headers: { "X-Proxy-Secret": SECRET },
    });
    assert.equal(res.status, 405);
  });

  // Parameter validation

  test("missing url param returns 400", async () => {
    const res = await worker.fetch("http://proxy/", {
      headers: { "X-Proxy-Secret": SECRET },
    });
    assert.equal(res.status, 400);
  });

  test("invalid url param returns 400", async () => {
    const res = await worker.fetch("http://proxy/?url=not-a-url", {
      headers: { "X-Proxy-Secret": SECRET },
    });
    assert.equal(res.status, 400);
  });

  // Proxy functionality

  test("proxies request to origin", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  test("forwards headers to target but strips X-Proxy-Secret", async () => {
    const target = `${origin.baseUrl}/echo-headers`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}`;

    const res = await worker.fetch(url, {
      headers: {
        "X-Proxy-Secret": SECRET,
        "User-Agent": "TestAgent/1.0",
        Accept: "application/json",
      },
    });

    assert.equal(res.status, 200);

    const json = (await res.json()) as {
      headers: Record<string, string | undefined>;
    };

    // Node http lowercases header names
    assert.equal(json.headers["user-agent"], "TestAgent/1.0");
    assert.equal(json.headers["accept"], "application/json");
    assert.equal(json.headers["x-proxy-secret"], undefined);
    assert.equal(json.headers["host"], new URL(target).host);
  });

  // Response headers

  test("adds proxy response headers", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.headers.get("X-Proxied"), "true");
    assert.ok(res.headers.get("X-Proxy-Version"));
  });

  test("propagates Retry-After from origin", async () => {
    const target = `${origin.baseUrl}/rate-limited`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "120");
  });

  // Cache TTL

  test("sets X-Cache-TTL header when cacheTtl provided", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}&cacheTtl=3600`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.headers.get("X-Cache-TTL"), "3600");
  });

  test("does not set X-Cache-TTL when cacheTtl not provided", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.headers.has("X-Cache-TTL"), false);
  });

  test("does not set X-Cache-TTL when cacheTtl is 0", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}&cacheTtl=0`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.headers.has("X-Cache-TTL"), false);
  });

  test("does not set X-Cache-TTL when cacheTtl is invalid", async () => {
    const target = `${origin.baseUrl}/`;
    const url = `http://proxy/?url=${encodeURIComponent(target)}&cacheTtl=abc`;

    const res = await worker.fetch(url, {
      headers: { "X-Proxy-Secret": SECRET },
    });

    assert.equal(res.headers.has("X-Cache-TTL"), false);
  });
});
