const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerMcpSetup } = require('./mcp-setup.cjs');

const origin = 'http://127.0.0.1:4200';

function fixture(t, options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mcp-setup-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launcherPath = path.join(directory, "Cópia ' $(echo expanded) `echo expanded` $USER");
  writeFileSync(launcherPath, '', { mode: 0o700 });
  const resolvedOrigin = options.origin ?? origin;
  const senderFrame = { origin: resolvedOrigin, url: `${resolvedOrigin}/` };
  const sender = { mainFrame: senderFrame };
  const handlers = new Map();
  const writes = [];
  registerMcpSetup({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    clipboard: { writeText: (text) => writes.push(text) },
    getWindow: () => ({ webContents: sender }),
    origin,
    launcherPath,
    ...options,
  });
  return {
    event: { sender, senderFrame },
    launcherPath,
    get: handlers.get('mcp-setup:get'),
    copy: handlers.get('mcp-setup:copy'),
    writes,
  };
}

test('quotes the bundled launcher as one literal argument for both clients', (t) => {
  const { event, get, copy, launcherPath, writes } = fixture(t);
  const setup = get(event);
  assert.equal(setup.launcherPath, launcherPath);
  assert.equal(setup.serverId, 'willis-overengineer-inator');
  assert.deepEqual(setup.launcherArgs, []);
  for (const client of ['codex', 'claude']) {
    assert.equal(copy(event, client), true);
    assert.equal(writes.at(-1), setup.commands[client]);
    const prefix = client === 'codex'
      ? 'codex mcp add willis-overengineer-inator -- '
      : 'claude mcp add --transport stdio --scope user willis-overengineer-inator -- ';
    assert.ok(setup.commands[client].startsWith(prefix));
    const quotedPath = setup.commands[client].slice(prefix.length);
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${quotedPath}`], { encoding: 'utf8' }), launcherPath);
  }
  event.senderFrame.url = `${origin}/playground?mode=architect`;
  assert.deepEqual(get(event), setup);
});

test('rejects other clients, windows, frames, origins, routes and missing launchers', (t) => {
  const { event, get, copy, launcherPath, writes } = fixture(t);
  for (const rejected of [
    { ...event, senderFrame: null },
    { ...event, sender: { mainFrame: event.senderFrame } },
    { ...event, senderFrame: { ...event.senderFrame } },
  ]) {
    assert.equal(get(rejected), null);
    assert.equal(copy(rejected, 'codex'), false);
  }
  assert.equal(copy(event, 'terminal command'), false);

  event.senderFrame.origin = 'http://localhost:4200';
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);

  event.senderFrame.origin = origin;
  event.senderFrame.url = `${origin}/docs`;
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);

  event.senderFrame.url = `${origin}/playground`;
  rmSync(launcherPath);
  assert.equal(get(event), null);
  assert.equal(copy(event, 'claude'), false);
  assert.deepEqual(writes, []);
});

test('uses the development alias and preserves each launcher argument', (t) => {
  const launcherArgs = ["/Example's checkout/mcp/src/index.mjs", '--mode', 'desktop-dev'];
  let isCurrent = true;
  const { event, get, copy, launcherPath } = fixture(t, {
    mode: 'desktop-dev', namespace: 'qa-dev', launcherArgs, isCurrent: () => isCurrent,
  });
  const setup = get(event);
  assert.equal(setup.mode, 'desktop-dev');
  assert.equal(setup.serverId, 'willis-overengineer-inator-dev');
  assert.deepEqual(setup.launcherArgs, [...launcherArgs, '--namespace', 'qa-dev']);
  const prefix = 'codex mcp add willis-overengineer-inator-dev -- ';
  assert.ok(setup.commands.codex.startsWith(prefix));
  const args = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${setup.commands.codex.slice(prefix.length)}`], {
    encoding: 'utf8',
  }).trimEnd().split('\n');
  assert.deepEqual(args, [launcherPath, ...setup.launcherArgs]);
  isCurrent = false;
  assert.equal(get(event), null);
  assert.equal(copy(event, 'codex'), false);
});

test('requires the packaged frame URL to match the Chromium custom origin', (t) => {
  const { event, get } = fixture(t, { origin: 'app://overengineer-inator' });
  assert.equal(get(event).mode, 'desktop');
  for (const url of [
    'http://overengineer-inator/playground',
    'app://other/playground',
    'app://overengineer-inator:3000/playground',
    'app://user@overengineer-inator/playground',
  ]) {
    event.senderFrame.url = url;
    assert.equal(get(event), null, url);
  }
});
