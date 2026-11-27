const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { test } = require('node:test');
const { HOST, ORIGIN, ownsListener, readDevRuntime, installDevRuntimeGuard } = require('./dev-runtime.cjs');

test('recognizes only the owning process on a loopback listener', { skip: process.platform !== 'darwin' }, async (t) => {
  const server = net.createServer().listen(0, HOST);
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(ownsListener(port, process.pid), true);
  assert.equal(ownsListener(port, process.ppid), false);
});

test('packaged mode ignores dev settings and standalone Electron startup fails closed', () => {
  assert.equal(readDevRuntime({ app: { isPackaged: true } }), null);
  assert.throws(() => readDevRuntime({ app: { isPackaged: false } }), /npm run dev/);
});

test('allows the Angular HMR socket, denies the web relay, and shuts down after losing ownership', async () => {
  let beforeRequest;
  let current = true;
  let lost = 0;
  installDevRuntimeGuard({
    session: { webRequest: { onBeforeRequest: (_filter, listener) => { beforeRequest = listener; } } },
    runtime: { origin: ORIGIN, isCurrent: () => current },
    onLost: () => { lost += 1; },
  });
  function blocked(url, resourceType) {
    let canceled;
    beforeRequest({ url, resourceType }, (result) => { canceled = result.cancel; });
    return canceled;
  }
  assert.equal(blocked('ws://127.0.0.1:4200/?token=fixture', 'webSocket'), false);
  assert.equal(blocked('ws://127.0.0.1:4301/canvas', 'webSocket'), true);
  assert.equal(blocked('http://127.0.0.1:4200/', 'mainFrame'), false);
  current = false;
  assert.equal(blocked('http://127.0.0.1:4200/', 'mainFrame'), true);
  assert.equal(blocked('ws://127.0.0.1:4200/?token=fixture', 'webSocket'), true);
  await Promise.resolve();
  assert.equal(lost, 1);
});
