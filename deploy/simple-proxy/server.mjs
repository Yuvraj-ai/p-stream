// P-Stream homeserver proxy — zero-dependency Node service implementing the
// two proxy protocols p-stream (movie-web style providers) speaks:
//
//   1. GET/POST /proxy?destination=<url>[&h=<b64url-json-headers>]
//      General CORS + header proxy. The providers package remaps forbidden
//      headers to X-Cookie / X-Referer / X-Origin / X-User-Agent request
//      headers (see makeSimpleProxyFetcher); the `h` parameter carries the
//      same headers baked into the URL for streams fetched directly by the
//      browser (which cannot set forbidden headers). Responds with
//      X-Final-Destination and permissive CORS.
//
//   2. GET /m3u8-proxy?url=<enc>[&headers=<urlencoded-json>]
//      HLS playlist proxy: fetches the playlist with the given headers and
//      rewrites every child URL (segments, variant playlists, keys, maps,
//      audio/subtitle tracks) back through this same endpoint, so playback
//      works for streams that need Referer/User-Agent/Cookie or lack CORS.
//
// Run: PORT=8081 node server.mjs

import http from 'node:http';
import { Readable } from 'node:stream';

const PORT = Number(process.env.PORT || 8081);
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 45000);
const MAX_BODY = 10 * 1024 * 1024; // 10 MiB for proxied POST bodies

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'host',
  'content-length',
]);

// request headers the browser must not be allowed to inject upstream
const STRIP_FROM_BROWSER = new Set([
  ...HOP_BY_HOP, 'cookie', 'referer', 'origin', 'user-agent',
  ...[...Object.keys({}).values()],
  'x-cookie', 'x-referer', 'x-origin', 'x-user-agent',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-request-headers',
  'access-control-request-method', 'if-none-match', 'if-modified-since',
]);

const REMAP = {
  'x-cookie': 'cookie',
  'x-referer': 'referer',
  'x-origin': 'origin',
  'x-user-agent': 'user-agent',
};

function b64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function b64urlEncode(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'X-Final-Destination, Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, corsHeaders(headers));
  res.end(body);
}

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// -- general proxy -----------------------------------------------------------

async function handleProxy(req, res, url) {
  const destination = url.searchParams.get('destination');
  if (!destination) return send(res, 400, {}, 'missing destination');
  const target = safeUrl(destination);
  if (!target) return send(res, 400, {}, 'invalid destination');

  // Providers ask for redirect chains to stay un-followed (Zangetsu's fetch
  // `followRedirects: false`) so they can read `hx-redirect` / `location`.
  const noFollow = String(req.headers['x-no-follow'] || '') === '1';

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (STRIP_FROM_BROWSER.has(lk) || lk === 'x-no-follow') continue;
    headers[lk] = v;
  }
  // providers-package style remapped headers
  for (const [from, to] of Object.entries(REMAP)) {
    const v = req.headers[from];
    if (typeof v === 'string' && v.length > 0) headers[to] = v;
  }
  // headers baked into the URL by the provider adapter (browser playback)
  const hParam = url.searchParams.get('h');
  if (hParam) {
    try {
      Object.assign(headers, JSON.parse(b64urlDecode(hParam)));
    } catch {
      /* ignore malformed */
    }
  }

  const method = req.method === 'POST' ? 'POST' : req.method === 'HEAD' ? 'HEAD' : 'GET';
  let body;
  if (method === 'POST') body = await readBody(req);

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: noFollow ? 'manual' : 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (err) {
    return send(res, 502, {}, `upstream error: ${String(err?.cause?.message || err?.message || err).slice(0, 200)}`);
  }

  const responseHeaders = {};
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'content-encoding' || lk === 'access-control-allow-origin') continue;
    responseHeaders[k] = v;
  }
  responseHeaders['X-Final-Destination'] = upstream.url || target.toString();
  res.writeHead(upstream.status, corsHeaders(responseHeaders));
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

// -- m3u8 proxy --------------------------------------------------------------

function baseUrlFromReq(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http');
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function rewriteUriAttribute(uri, base, headers, selfBase) {
  if (!uri || uri.startsWith('data:')) return uri;
  try {
    const abs = new URL(uri, base).toString();
    const params = new URLSearchParams({
      url: abs,
      headers: JSON.stringify(headers),
    });
    return `${selfBase}/m3u8-proxy?${params.toString()}`;
  } catch {
    return uri;
  }
}

function rewritePlaylist(text, base, headers, selfBase) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return line;
      if (trimmed.startsWith('#')) {
        // rewrite URI="..." inside EXT tags (keys, maps, alternate tracks)
        return line.replace(/URI="([^"]+)"/g, (_, uri) =>
          `URI="${rewriteUriAttribute(uri, base, headers, selfBase)}"`);
      }
      return rewriteUriAttribute(trimmed, base, headers, selfBase);
    })
    .join('\n');
}

async function handleM3u8(req, res, url, selfBase) {
  const rawUrl = url.searchParams.get('url');
  if (!rawUrl) return send(res, 400, {}, 'missing url');
  const target = safeUrl(rawUrl);
  if (!target) return send(res, 400, {}, 'invalid url');

  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' };
  const headersParam = url.searchParams.get('headers');
  if (headersParam) {
    try {
      Object.assign(headers, JSON.parse(headersParam));
    } catch {
      /* ignore malformed */
    }
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
  } catch (err) {
    return send(res, 502, {}, `upstream error: ${String(err?.cause?.message || err?.message || err).slice(0, 200)}`);
  }
  if (!upstream.ok) {
    return send(res, upstream.status, {}, `upstream ${upstream.status}`);
  }
  const text = await upstream.text();
  // resolve relative child URLs against the FINAL url after redirects
  const finalBase = upstream.url || target.toString();
  const rewritten = rewritePlaylist(text, finalBase, headers, selfBase);
  return send(res, 200, { 'Content-Type': 'application/vnd.apple.mpegurl' }, rewritten);
}

// -- server ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const selfBase = baseUrlFromReq(req);

  try {
    if (req.method === 'OPTIONS') {
      return send(res, 204, {});
    }
    // the providers package calls the proxy at its ROOT path with
    // ?destination=<url> (makeSimpleProxyFetcher sets baseUrl: undefined), so
    // "/" and "/proxy" must both serve the general proxy.
    if (url.pathname === '/proxy' || url.pathname === '/') {
      return await handleProxy(req, res, url);
    }
    if (url.pathname === '/m3u8-proxy') {
      return await handleM3u8(req, res, url, selfBase);
    }
    if (url.pathname === '/ping') {
      return send(res, 200, { 'Content-Type': 'text/plain' }, 'pong');
    }
    return send(res, 404, {}, 'not found');
  } catch (err) {
    if (!res.headersSent) {
      send(res, 500, {}, `proxy error: ${String(err?.message || err).slice(0, 200)}`);
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`[p-stream-proxy] listening on :${PORT}`);
});
