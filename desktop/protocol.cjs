const path = require('node:path');
const { readFile, realpath, stat } = require('node:fs/promises');

const APP_SCHEME = 'app';
const APP_HOST = 'overengineer-inator';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const SPA_ROUTES = new Set(['/', '/playground', '/docs', '/reports', '/benchmarks']);
const FX_URL = 'https://daily-analytics.sr-architect.workers.dev/fx';
const API_WINDOW_MS = 60_000;
const API_LIMIT = 60;
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self' https://daily-analytics.sr-architect.workers.dev",
  "font-src 'self' data: https://fonts.gstatic.com",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isAppUrl(url) {
  return url?.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST &&
    !url.port && !url.username && !url.password;
}

function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  }]);
}

function response(request, body, status, headers = {}) {
  return new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: { ...SECURITY_HEADERS, ...headers },
  });
}

function respondJson(request, body, status, headers) {
  return response(request, JSON.stringify(body), status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function decodePath(pathname) {
  const segments = pathname.split('/').slice(1).map(decodeURIComponent);
  if (segments.some((segment) => segment === '.' || segment === '..' ||
    /[/\\%\u0000-\u001f\u007f]/u.test(segment))) throw new Error('Invalid path');
  return `/${segments.join('/')}`;
}

function parseRegion(search) {
  const pairs = Array.from(new URLSearchParams(search).entries());
  // URLSearchParams tolerates bad escaping and UTF-8. Pricing needs strict decoding.
  decodeURIComponent(search);
  const regions = pairs.filter(([key]) => key === 'region');
  if (regions.length > 1 || pairs.some(([key]) => key.startsWith('region['))) {
    throw new Error('Invalid region');
  }
  return regions[0]?.[1];
}

async function getFx(fetchFx) {
  const upstream = await fetchFx(FX_URL, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!upstream.ok || !upstream.body ||
    !upstream.headers.get('content-type')?.startsWith('application/json')) {
    await upstream.body?.cancel();
    throw new Error('Invalid FX response');
  }
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error('FX response too large');
    }
    chunks.push(value);
  }
  const { rates } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!rates || Array.isArray(rates) || typeof rates !== 'object') throw new Error('Invalid FX rates');
  return { rates };
}

async function installAppProtocol({ session, staticDir, pricing, fetchFx = fetch, migrationUrl }) {
  const staticRoot = await realpath(staticDir);
  let rateReset = 0;
  let requestCount = 0;

  session.protocol.handle(APP_SCHEME, async (request) => {
    const url = URL.parse(request.url);
    if (!isAppUrl(url)) return response(request, 'Forbidden.', 403);
    if (request.initiatorOrigin !== undefined && request.initiatorOrigin !== APP_ORIGIN) {
      return response(request, 'Forbidden.', 403);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(request, 'Method not allowed.', 405, { Allow: 'GET, HEAD' });
    }
    if (migrationUrl && url.href === migrationUrl) return storageDocument(request);

    let pathname;
    try {
      pathname = decodePath(url.pathname);
    } catch {
      return response(request, 'Invalid path.', 400);
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (request.initiatorOrigin !== APP_ORIGIN) return response(request, 'Forbidden.', 403);
      const now = Date.now();
      if (now >= rateReset) {
        rateReset = now + API_WINDOW_MS;
        requestCount = 0;
      }
      requestCount++;
      const rateHeaders = {
        'RateLimit-Policy': `${API_LIMIT};w=${API_WINDOW_MS / 1000}`,
        'RateLimit-Limit': String(API_LIMIT),
        'RateLimit-Remaining': String(Math.max(0, API_LIMIT - requestCount)),
        'RateLimit-Reset': String(Math.ceil((rateReset - now) / 1000)),
      };
      if (requestCount > API_LIMIT) {
        return response(request, 'Too many requests, please try again later.', 429, {
          ...rateHeaders,
          'Retry-After': rateHeaders['RateLimit-Reset'],
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      if (pathname === '/api/status') {
        const { status, body } = pricing.status();
        return respondJson(request, body, status, rateHeaders);
      }
      if (pathname === '/api/prices') {
        let region;
        try {
          region = parseRegion(url.search);
        } catch {
          return respondJson(request, { message: 'The region query parameter must be a single string.' }, 400, rateHeaders);
        }
        const { status, body, cache } = await pricing.prices(region);
        if (cache) rateHeaders['X-Cache'] = cache;
        return respondJson(request, body, status, rateHeaders);
      }
      if (pathname === '/api/fx' && request.method === 'GET' && !url.search) {
        try {
          return respondJson(request, await getFx(fetchFx), 200, rateHeaders);
        } catch {
          return respondJson(request, { error: 'FX rates unavailable.' }, 503, rateHeaders);
        }
      }
      return respondJson(request, { message: 'API route not found.' }, 404, rateHeaders);
    }

    const isSpaRoute = SPA_ROUTES.has(pathname);
    if (!isSpaRoute && request.initiatorOrigin !== APP_ORIGIN) {
      return response(request, 'Forbidden.', 403);
    }
    const asset = path.join(staticRoot, isSpaRoute ? 'index.html' : pathname);
    const type = CONTENT_TYPES.get(path.extname(asset).toLowerCase());
    if (!type) return response(request, 'Not found.', 404);
    try {
      const resolved = await realpath(asset);
      if (path.relative(staticRoot, resolved).startsWith('..') || !(await stat(resolved)).isFile()) {
        return response(request, 'Not found.', 404);
      }
      const body = request.method === 'HEAD' ? null : await readFile(resolved);
      return response(request, body, 200, { 'Content-Type': type });
    } catch {
      return response(request, 'Not found.', 404);
    }
  });
}

function storageDocument(request) {
  return response(request, '<!doctype html><title>Storage migration</title>', 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
  });
}

module.exports = { APP_ORIGIN, SPA_ROUTES, isAppUrl, registerAppScheme, installAppProtocol, storageDocument };
