const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createApp } = require('./server');

const HOST = '127.0.0.1';
const DESKTOP_HOST = '127.0.0.1:4200';

async function listen(t, app) {
  const server = app.listen(0, HOST);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function request(port, path, { method = 'GET', host = DESKTOP_HOST } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HOST,
      port,
      path,
      method,
      headers: { host, connection: 'close' },
    }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('desktop serves the packaged SPA and prices with a loopback-specific policy', async (t) => {
  const staticDir = await mkdtemp(path.join(os.tmpdir(), 'simulator-backend-'));
  t.after(() => rm(staticDir, { recursive: true, force: true }));
  const entry = '<html>Simulator entry</html>';
  const pricingFile = path.join(staticDir, 'test-pricing.json');
  const pricing = { region: 'us-east-1', services: {} };
  await Promise.all([
    writeFile(path.join(staticDir, 'index.html'), entry),
    writeFile(pricingFile, JSON.stringify(pricing)),
  ]);
  const port = await listen(t, createApp({ desktop: { staticDir, pricingFile, hostHeader: DESKTOP_HOST } }));

  const page = await request(port, '/playground?mode=architect');
  assert.equal(page.status, 200);
  assert.equal(page.body, entry);
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /(?:^|;)script-src 'self'(?:;|$)/);
  assert.match(csp, /connect-src[^;]*ws:\/\/127\.0\.0\.1:4301/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(page.headers['strict-transport-security'], undefined);

  const docs = await request(port, '/docs?service=client', { method: 'HEAD' });
  assert.equal(docs.status, 200);
  assert.equal(docs.body, '');
  const badHost = await request(port, '/playground', { host: 'localhost:4200' });
  assert.equal(badHost.status, 403);
  assert.match(badHost.headers['content-type'], /^application\/json/);

  const noApi = await request(port, '/api/missing');
  assert.equal(noApi.status, 404);
  assert.match(noApi.headers['content-type'], /^application\/json/);
  const noAsset = await request(port, '/assets/missing');
  assert.equal(noAsset.status, 404);
  assert.notEqual(noAsset.body, entry);

  for (const query of ['region=us-east-1&region=us-east-2', 'region%5Bcode%5D=us-east-1']) {
    const malformed = await request(port, `/api/prices?${query}`);
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers['content-type'], /^application\/json/);
  }
  const status = await request(port, '/api/status');
  assert.equal(status.status, 200);
  const prices = await request(port, '/api/prices?region=%20US-EAST-1%20');
  assert.equal(prices.status, 200);
  assert.equal(prices.headers['x-cache'], 'LOCAL_FILE');
  assert.deepEqual(JSON.parse(prices.body), pricing);
});

test('web mode still serves the tracked pricing snapshot and web headers', async (t) => {
  const port = await listen(t, createApp());
  const missing = await request(port, '/playground', { host: 'localhost' });
  assert.equal(missing.status, 404);

  const prices = await request(port, '/api/prices', { host: 'localhost' });
  assert.equal(prices.status, 200);
  assert.equal(prices.headers['x-cache'], 'LOCAL_FILE');
  assert.match(prices.headers['content-security-policy'], /upgrade-insecure-requests/);
  assert.ok(prices.headers['strict-transport-security']);
});
