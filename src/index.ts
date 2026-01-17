/**
 * Cloudflare Worker proxy for external HTTP requests.
 *
 * Routes requests through Cloudflare's network to avoid IP-based rate limits.
 * Transparently forwards request headers to the target.
 *
 * Security: Requests must include valid X-Proxy-Secret header.
 *
 * Query params:
 *   url      - Target URL (required)
 *   cacheTtl - Edge cache TTL in seconds (optional, default: no caching)
 */

declare const VERSION: string;

interface Env {
  PROXY_SECRET: string;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/version") {
      return Response.json({ version: VERSION, ok: true });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Proxy-Secret");
    if (!secret || secret !== env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    let targetHost: string;
    try {
      targetHost = new URL(targetUrl).host;
    } catch {
      return new Response("Invalid target URL", { status: 400 });
    }

    // Forward headers, stripping only the proxy secret
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers) {
      if (key.toLowerCase() !== "x-proxy-secret") {
        forwardHeaders.set(key, value);
      }
    }
    forwardHeaders.set("Host", targetHost);

    // Optional edge caching
    const cacheTtlParam = url.searchParams.get("cacheTtl");
    const cacheTtl = cacheTtlParam ? parseInt(cacheTtlParam, 10) : null;

    try {
      const response = await fetch(targetUrl, {
        headers: forwardHeaders,
        cf:
          cacheTtl && cacheTtl > 0
            ? { cacheTtl, cacheEverything: true }
            : undefined,
      });

      const responseHeaders = new Headers();
      responseHeaders.set(
        "Content-Type",
        response.headers.get("Content-Type") ?? "application/octet-stream"
      );
      responseHeaders.set("X-Proxied", "true");
      responseHeaders.set("X-Proxy-Version", VERSION);

      if (cacheTtl && cacheTtl > 0) {
        responseHeaders.set("X-Cache-TTL", String(cacheTtl));
      }

      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        responseHeaders.set("Retry-After", retryAfter);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Proxy error: ${message}`, { status: 502 });
    }
  },
};

export default worker;
