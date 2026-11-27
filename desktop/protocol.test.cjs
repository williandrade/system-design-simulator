const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPricing } = require('../backend/pricing');
const { APP_ORIGIN, installAppProtocol } = require('./protocol.cjs');

async function fixture(t, fetchFx) {
  const root = await mkdtemp(path.join(tmpdir(), 'overengineer-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staticDir = path.join(root, 'frontend');
  await mkdir(staticDir);
  const pricingFile = path.join(root, 'prices.json');
  await Promise.all([
    writeFile(path.join(staticDir, 'index.html'), '<html>Playground</html>'),
    writeFile(path.join(staticDir, 'main.js'), '"";'),
    writeFile(pricingFile, '{"region":"us-east-1"}'),
    symlink(pricingFile, path.join(staticDir, 'escape.json')),
  ]);
  let handler;
  await installAppProtocol({
    session: { protocol: { handle: (scheme, callback) => {
      assert.equal(scheme, 'app');
      handler = callback;
    } } },
    staticDir,
    pricing: createPricing({ pricingFile }),
    fetchFx,
  });
  return (route, options = {}) => {
    const { method = 'GET', url = APP_ORIGIN } = options;
    const initiatorOrigin = Object.hasOwn(options, 'origin') ? options.origin : APP_ORIGIN;
    return handler({ method, url: `${url}${route}`, initiatorOrigin });
  };
}

test('serves the allowed application routes and assets under the packaged CSP', async (t) => {
  const request = await fixture(t);
  const page = await request('/', { origin: undefined });
  assert.equal(await page.text(), '<html>Playground</html>');
  assert.match(page.headers.get('content-security-policy'), /frame-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /4301/);
  const docs = await request('/docs?service=apiGateway', { method: 'HEAD' });
  assert.equal(docs.status, 200);
  assert.equal(await docs.text(), '');
  assert.match((await request('/main.js')).headers.get('content-type'), /javascript/);
  for (const route of ['/escape.json', '/missing.js', '/unexpected-route']) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.equal((await request('/%2F')).status, 400);
  assert.equal((await request('/%')).status, 400);
  assert.equal((await request('/', { url: 'app://overengineer-inator:3000' })).status, 403);
});

test('requires the local initiator for prices and keeps the per-session API limit', async (t) => {
  const request = await fixture(t);
  for (const origin of [undefined, null, 'null', 'https://outside.example']) {
    assert.equal((await request('/api/status', { origin })).status, 403);
  }
  for (const query of ['region=us-east-1&region=us-east-2', 'region%5Bcode%5D=us-east-1', 'region=%FF']) {
    assert.equal((await request(`/api/prices?${query}`)).status, 400);
  }
  const prices = await request('/api/prices?region=%20US-EAST-1%20');
  assert.equal(prices.headers.get('x-cache'), 'LOCAL_FILE');
  assert.deepEqual(await prices.json(), { region: 'us-east-1' });
  const status = await request('/api/status', { method: 'HEAD' });
  assert.equal(status.status, 200);
  assert.equal(await status.text(), '');
  assert.equal((await request('/api/votes', { method: 'POST' })).status, 405);
  for (let remaining = 55; remaining > 0; remaining--) await request('/api/status');
  assert.equal((await request('/api/status')).status, 429);
});

test('fetches FX only through the fixed desktop GET route', async (t) => {
  let calls = 0;
  const request = await fixture(t, async (url, options) => {
    calls++;
    assert.equal(url, 'https://daily-analytics.sr-architect.workers.dev/fx');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return Response.json({ rates: { AUD: 1.5 } });
  });
  assert.equal((await request('/api/fx?url=https://outside.example')).status, 404);
  assert.deepEqual(await (await request('/api/fx')).json(), { rates: { AUD: 1.5 } });
  assert.equal(calls, 1);
});
