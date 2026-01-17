# cf-proxy

Cloudflare Worker that proxies HTTP requests to avoid IP-based rate limits.

## Why

External services rate-limit by IP. This worker routes requests through Cloudflare's edge network, isolating your server's IP from rate limits.

Use cases:
- Wayback Machine CDX API
- Shopify store scraping
- Any rate-limited external API

## How It Works

1. Your app sends a request to the worker with `X-Proxy-Secret` header
2. Worker validates the secret
3. Worker forwards request to target URL
4. Response returned to your app

## Quick Start

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/cf-proxy.git
cd cf-proxy
pnpm install

# Set the auth secret
wrangler secret put PROXY_SECRET

# Deploy
pnpm deploy
```

## Usage

```bash
curl "https://your-worker.workers.dev?url=https://example.com" \
  -H "X-Proxy-Secret: your-secret"
```

### Query Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `url` | Yes | Target URL to proxy |
| `cacheTtl` | No | Edge cache TTL in seconds |

### Response Headers

| Header | Description |
|--------|-------------|
| `X-Proxied` | Always `true` |
| `X-Proxy-Version` | Worker version string |
| `X-Cache-TTL` | Cache TTL if caching enabled |

## Client Example

```typescript
const PROXY_URL = process.env.CF_PROXY_URL;
const PROXY_SECRET = process.env.CF_PROXY_SECRET;

async function proxyFetch(targetUrl: string, init?: RequestInit) {
  if (!PROXY_URL || !PROXY_SECRET) {
    return fetch(targetUrl, init);
  }

  const url = new URL(PROXY_URL);
  url.searchParams.set("url", targetUrl);

  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      "X-Proxy-Secret": PROXY_SECRET,
    },
  });
}

// Usage
const response = await proxyFetch("https://web.archive.org/cdx/search?url=example.com");
```

## Local Development

```bash
# Copy example env
cp .dev.vars.example .dev.vars

# Start dev server (port 8787)
pnpm dev

# Test
curl "http://localhost:8787?url=https://example.com" \
  -H "X-Proxy-Secret: local-dev-secret"
```

## Running Tests

```bash
pnpm test
```

Tests use wrangler's `unstable_startWorker()` with a local origin server - no external dependencies.

## Configuration

Edit `wrangler.jsonc`:

| Setting | Purpose |
|---------|---------|
| `name` | Worker name (appears in URL) |
| `define.VERSION` | Build-time version string |
| `observability.enabled` | Cloudflare logging |
| `upload_source_maps` | Better error stack traces |

## Environment Variables

### Worker (Cloudflare)

Set via `wrangler secret put PROXY_SECRET`:

| Variable | Description |
|----------|-------------|
| `PROXY_SECRET` | Auth secret for requests |

### Your App

| Variable | Description |
|----------|-------------|
| `CF_PROXY_URL` | Worker URL |
| `CF_PROXY_SECRET` | Same secret as worker |

## Security

- All requests require valid `X-Proxy-Secret` header
- Secret stripped before forwarding to target
- No host whitelist - the secret is the access control

## License

MIT
